// The units' provider, and the connector to AgentComputer. A computer is one the service runs: this
// asks the service for it through its SDK, then opens an ordinary `url` connection to each endpoint
// with the computer's token, and joins the computer's capability as an Actor of its own, which the
// person is connected to. The web unit is one connection to a hosted server. When no service runs
// on this machine and AgentComputer is installed, `agentcomputer up` starts one, isolated as the
// one here last was: when a computer here is added, and at start for computers kept here. The app
// doesn't include AgentComputer. The control token and each computer's token stay in this
// provider's private file.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Computer, ComputerError, type LiveSurface } from "@agentorg/computer";
import {
  capability,
  type FactRow as FactRowShape,
  hubActors,
  type Problem,
  unitProvider,
} from "@agentorg/interfaces";
import { Connection, type Groups, parseConnection, type Timing } from "@agentorg/mcp";
import { type Log, Refused } from "@agentorg/sdk";
import { type Client, connect } from "@agentorg/sdk/client";
import { z } from "zod";
import {
  type Access,
  ANOTHER,
  BROWSER_SLOT,
  COMPUTER,
  computerUnit,
  type Found,
  INSTALL_STEPS,
  LOCAL,
  REACHES,
  SKILLS,
  WEB,
  WEB_UNIT,
  WHERE,
  WORKSPACE,
} from "./unit.js";

const Link = z.object({
  slot: z.string(),
  actor: z.string(),
  credential: z.string(),
  url: z.string(),
});
const Stored = z.object({
  agent: z.string(),
  links: z.array(Link),
  /** The capability's own Actor, which exports `capability@1` for the computer. */
  capability: z.object({ actor: z.string(), credential: z.string() }).optional(),
  /** The computer behind them. A service at an address is reached with what is kept here. */
  computer: z
    .object({
      id: z.string(),
      token: z.string(),
      service: z.union([
        z.object({ local: z.literal(true) }),
        z.object({ apiUrl: z.string(), apiKey: z.string() }),
      ]),
    })
    .optional(),
});
type Instance = z.infer<typeof Stored>;
type Linked = z.infer<typeof Link>;
type TheProblem = z.input<typeof Problem>;
interface Reached {
  apiUrl: string;
  apiKey: string;
}

const FILE = "instances.json";
/** Holds `lastIsolation`. */
const ISOLATION_FILE = "local-service.json";
const SKILLS_DIR = fileURLToPath(new URL("../../skills/", import.meta.url));
const EXA_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa";
const SERVICE_ANSWERS_MS = 2000;
/** How long `agentcomputer up` may take to have a service answer. */
const UP_MS = 30_000;
type FactRow = z.input<typeof FactRowShape>;
/** The most a row's value holds, as `FactRow` has it. */
const ROW_VALUE_MAX = 1024;
/** The most a connection's target holds, as `ConnectionTarget` has it. */
const TARGET_MAX = 4096;
/** How the computer's `computer` endpoint takes a call's group, and stops a group. */
const AGENTEXEC_GROUPS: Groups = { meta: "agentexec/group", stop: "agentexec/group/stop" };
const SAYS: Record<Access, string> = {
  read: "reads files",
  files: "reads and changes files",
  terminal: "files and terminal",
};
const LEVELS = ["read", "files", "terminal"];

export interface ComputerProviderOptions {
  hubUrl: string;
  /** The provider's own Actor, bound to `hub.actors@1` at its slot `actors`. */
  actorId: string;
  credential: string;
  /**
   * A private folder of the provider's, which holds each connection's Hub credential, and how the
   * service here was last isolated.
   */
  dir: string;
  /**
   * Where a service on this machine writes its address and token, and where `agentcomputer up`
   * starts one; the service's own default.
   */
  dataFolder?: string;
  /** Where an agent's own folder goes when none is named; `~/Agents` by default. */
  agentsFolder?: string;
  /** Where `agentcomputer` is looked for, to start a service here: `PATH` by default. */
  path?: string;
  /** The hosted server the web unit connects to; Exa's by default. For tests. */
  webUrl?: string;
  log?: Log;
  timing?: Timing;
}

export interface ComputerProvider {
  /**
   * Leave the Hub and let every connection and every capability's Actor go. The computers stay,
   * and resume at the next start.
   */
  close(): Promise<void>;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const quiet: Log = { info() {}, warn() {}, error() {} };
/** An endpoint at the address the service was reached on, whatever the service calls itself. */
const at = (apiUrl: string, endpoint: string) => {
  const url = new URL(endpoint);
  const { origin } = new URL(apiUrl);
  return `${origin}${url.pathname}${url.search}`;
};

/** A live session's socket, at the address the service was reached on. */
const socketAt = (apiUrl: string, socket: string) => {
  const { pathname, search } = new URL(socket);
  const reached = new URL(apiUrl);
  return `${reached.protocol === "https:" ? "wss:" : "ws:"}//${reached.host}${pathname}${search}`;
};
/** How long a computer's own surfaces may take to say what they are, in a status. */
const SURFACES_MS = 2000;
/** How long what they said is used again: a status is asked for often. */
const SURFACES_FRESH_MS = 10_000;

/** The same folders the service looks in itself. */
const defaultDataFolder = () =>
  process.env.AGENTCOMPUTER_DATA ??
  (process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, "agentcomputer")
    : join(homedir(), ".local", "share", "agentcomputer"));

/** `promise`'s value, or undefined if it fails or takes longer than `ms`. */
async function within<T>(ms: number, promise: Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, ms, undefined);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** A folder as a person writes it: `~/` is their home. */
const fromHome = (folder: unknown) =>
  typeof folder === "string" && folder.startsWith("~/")
    ? join(homedir(), folder.slice(2))
    : (folder as string | undefined);

/** What is wrong with what was filled in; nothing means it can be applied. */
function problems(
  unit: string,
  values: Record<string, unknown>,
  found: Found,
  secrets: string[],
): TheProblem[] {
  const wrong: TheProblem[] = [];
  if (unit === WEB) {
    if (values.service !== "exa") wrong.push({ field: "service", message: "Choose a service." });
    return wrong;
  }
  if ((values.service === LOCAL || values.service === undefined) && !found)
    wrong.push({ field: "service", message: INSTALL_STEPS });
  else if (values.service === ANOTHER) {
    const given = secrets.includes("token") ? { token: "given" } : {};
    const { why } = parseConnection("url", { url: values.address }, given);
    if (why) wrong.push({ field: "address", message: `That address won't do. ${why}` });
  } else if (values.service !== LOCAL)
    wrong.push({ field: "service", message: "Choose where it resides." });
  if (values.access === "none") {
    if (values.browser !== true)
      wrong.push({
        field: "access",
        message: "With no files, no commands and no browser, there's no computer.",
      });
  } else if (!LEVELS.includes(values.access as string))
    wrong.push({ field: "access", message: "Choose what it reaches." });
  const workspace = fromHome(values.workspace);
  if (values.service === LOCAL && workspace !== undefined) {
    if (!isAbsolute(workspace))
      wrong.push({
        field: "workspace",
        message: "Give the folder's full path, or one that starts with ~/.",
      });
    else if (!makeable(workspace))
      wrong.push({ field: "workspace", message: cantBeMade(workspace) });
  }
  return wrong;
}

const cantBeMade = (folder: string) => `The folder ${folder} can't be made.`;

/**
 * Whether `folder` is a folder or could be made as one, without making anything: going up from
 * it, the first thing that is there is a folder, and one a new folder can be put in. So what
 * `check` lets through, making the computer can make.
 */
function makeable(folder: string) {
  try {
    for (let at = resolve(folder); ; at = dirname(at)) {
      const found = statSync(at, { throwIfNoEntry: false });
      if (found) {
        if (!found.isDirectory()) return false;
        if (at !== resolve(folder)) accessSync(at, constants.W_OK | constants.X_OK);
        return true;
      }
      // Something is there that leads nowhere, such as a link to nothing, or nothing at all is.
      if (lstatSync(at, { throwIfNoEntry: false }) || dirname(at) === at) return false;
    }
  } catch {
    return false;
  }
}

/** Run the units' provider as an Actor exporting `unit.provider@1` as `provider`. */
export async function startComputerProvider(
  options: ComputerProviderOptions,
): Promise<ComputerProvider> {
  const log = options.log ?? quiet;
  const { hubUrl, dir } = options;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, FILE);
  const read = (): Record<string, Instance> => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    try {
      return z.record(z.string(), Stored).parse(JSON.parse(raw));
    } catch {
      renameSync(path, `${path}.unreadable-${Date.now()}`);
      log.error("The computers file can't be read: it is set aside and starts empty.");
      return {};
    }
  };
  /** Write `value` to `file` in one step, for this user alone. */
  const keep = (file: string, value: unknown) => {
    writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600, flush: true });
    renameSync(`${file}.tmp`, file);
  };
  const stored = read();
  const save = () => keep(path, stored);

  /** A service on this machine, by what it wrote; it needn't be running. */
  const localService = (): Reached | undefined => {
    const data = options.dataFolder ?? defaultDataFolder();
    try {
      const { url, pid } = JSON.parse(readFileSync(join(data, "server.json"), "utf8")) as {
        url: string;
        pid: number;
      };
      // A service that crashed leaves this behind: nothing else on its port gets the token.
      process.kill(pid, 0);
      return { apiUrl: url, apiKey: readFileSync(join(data, "control-token"), "utf8").trim() };
    } catch {
      return undefined;
    }
  };
  /** The `agentcomputer` command on the path, if AgentComputer is installed here. */
  const onPath = () => {
    for (const folder of (options.path ?? process.env.PATH ?? "").split(delimiter)) {
      if (!folder) continue;
      const command = join(folder, "agentcomputer");
      try {
        accessSync(command, constants.X_OK);
        return command;
      } catch {}
    }
    return undefined;
  };
  type Isolation = NonNullable<Found>["isolation"];
  const isolationPath = join(dir, ISOLATION_FILE);
  /**
   * How the service here was isolated when it last answered, so it starts again so: AgentComputer
   * gives a computer recorded with no isolation the service's. `none` until one answers.
   */
  let lastIsolation: Isolation = "none";
  try {
    if (JSON.parse(readFileSync(isolationPath, "utf8")).isolation === "container")
      lastIsolation = "container";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      log.warn(`How the service here was last isolated can't be read: ${messageOf(error)}`);
  }
  /** What the file holds, so a write that failed is tried again at the next answer. */
  let keptIsolation = lastIsolation;
  /** How the service on this machine isolates, if it answers now. A change is kept. */
  const answering = async () => {
    const reached = localService();
    const info = reached && (await within(SERVICE_ANSWERS_MS, Computer.serviceInfo(reached)));
    const isolation = info?.isolation;
    if (!reached || (isolation !== "none" && isolation !== "container")) return undefined;
    lastIsolation = isolation;
    if (isolation !== keptIsolation)
      try {
        keep(isolationPath, { isolation });
        keptIsolation = isolation;
      } catch (error) {
        log.warn(`How the service here is isolated wasn't kept: ${messageOf(error)}`);
      }
    return { reached, isolation };
  };
  /**
   * The service on this machine. When none answers, `agentcomputer up` starts one, isolated as
   * the one here last was, or finds one that answers after all. Calls made while it runs share it.
   */
  let starting: Promise<Reached> | undefined;
  const startedLocal = (): Promise<Reached> =>
    (starting ??= (async () => {
      const here = await answering();
      if (here) return here.reached;
      const command = onPath();
      if (!command) throw new Refused("invalid", INSTALL_STEPS);
      const data = options.dataFolder ?? defaultDataFolder();
      const args = ["up", "--data", data, "--isolation", lastIsolation];
      await promisify(execFile)(command, args, { timeout: UP_MS }).catch(
        (error: { killed?: boolean; stderr?: unknown }) => {
          const said = String(error.stderr ?? "").trim();
          throw new Refused(
            "unavailable",
            error.killed
              ? `AgentComputer didn't answer within ${UP_MS / 1000} seconds of being started. It may still be starting${lastIsolation === "container" ? ": the first start in containers after an update fetches their image" : ""}. Try again in a moment.`
              : `AgentComputer couldn't be started on this computer. ${said.slice(0, 1000) || messageOf(error)}`,
          );
        },
      );
      log.info("AgentComputer is running on this computer.");
      const started = localService();
      if (!started)
        throw new Refused("unavailable", "AgentComputer started, but can't be reached.");
      return started;
    })().finally(() => {
      starting = undefined;
    }));
  /** The service on this machine as the form says it: how it isolates, or that it will start. */
  const findLocal = async (): Promise<Found> =>
    (await answering()) ?? (onPath() ? { isolation: lastIsolation, starts: true } : undefined);

  const running = new Map<string, Connection[]>();
  /** Connect a link. A service on this machine may have moved to another port since. */
  const open = async (
    { slot, url, actor, credential }: Linked,
    computer?: Instance["computer"],
  ) => {
    const moved = computer && "local" in computer.service ? localService()?.apiUrl : undefined;
    const token = computer?.token;
    const server = new Connection(
      { kind: "url", url: moved ? at(moved, url) : url },
      token ? { token } : {},
      log,
      options.timing,
      [],
      // The computer's own commands can be put in a group and stopped together, as AgentExec
      // names it.
      slot === COMPUTER ? AGENTEXEC_GROUPS : undefined,
    );
    await server.join({ hubUrl, actorId: actor, credential });
    return server;
  };
  /** Each computer's capability as its own Actor, joined, by instance. */
  const capabilities = new Map<
    string,
    Client<Record<never, never>, { capability: typeof capability }>
  >();
  const endAll = async () => {
    for (const client of capabilities.values()) client.close();
    await Promise.all([...running.values()].flat().map((server) => server.end()));
  };
  const held = (instance: string) => {
    const found = stored[instance];
    const servers = running.get(instance);
    if (!found || !servers)
      throw new Refused("unknown", `This provider holds nothing named ${instance}.`);
    return { found, servers };
  };

  const reachOf = (service: NonNullable<Instance["computer"]>["service"]) =>
    "local" in service ? localService() : service;
  /**
   * The computer goes. Only a service having trouble is worth another try: one that can't be
   * reached, or no longer takes this token, mustn't keep the agent from going.
   */
  const killComputer = async ({ id, service }: NonNullable<Instance["computer"]>) => {
    const reached = reachOf(service);
    try {
      if (!reached) throw new Error("The service isn't there.");
      await Computer.kill(id, reached);
    } catch (error) {
      if (error instanceof ComputerError && error.code >= 500) throw error;
      if (!(error instanceof ComputerError && error.code === 404))
        log.error(`A computer may be left on its service: ${messageOf(error)}`);
    }
  };

  /** The folder an agent with this name works in when none is named. It stays when the agent goes. */
  const agentFolder = (agentName: string) => {
    const safe =
      agentName
        .trim()
        .replace(/[/\\\p{Cc}]/gu, "-")
        .replace(/^\.+/, "")
        .trim() || "agent";
    return join(options.agentsFolder ?? join(homedir(), "Agents"), safe);
  };

  /** What of a computer can be opened live, as its service says; none if it can't say now. */
  const asked = new Map<string, { at: number; answer: ReturnType<typeof askSurfaces> }>();
  /** One question at a time per computer, and its answer kept a little while. */
  const surfacesOf = (computer: NonNullable<Instance["computer"]>) => {
    const kept = asked.get(computer.id);
    if (kept && Date.now() - kept.at < SURFACES_FRESH_MS) return kept.answer;
    const answer = askSurfaces(computer);
    asked.set(computer.id, { at: Date.now(), answer });
    return answer;
  };
  const askSurfaces = async (computer: NonNullable<Instance["computer"]>) => {
    const reached = reachOf(computer.service);
    const info = reached && (await within(SURFACES_MS, Computer.getInfo(computer.id, reached)));
    return info?.surfaces.map(({ surface, protocol, operate, unavailable }) => ({
      surface,
      protocol,
      operate,
      ...(unavailable ? { unavailable } : {}),
    }));
  };

  /** Make the computer, and say what each of its endpoints is and the rows fixed for its views. */
  const makeComputer = async (
    values: Record<string, unknown>,
    secrets: Record<string, string>,
    name: string,
    agent: string,
    agentName?: string,
  ) => {
    const local = values.service === LOCAL;
    const reached = local
      ? await startedLocal()
      : { apiUrl: String(values.address).replace(/\/$/, ""), apiKey: secrets.token as string };
    // Named, so the computer has the isolation its targets and rows below say.
    const { isolation } = await Computer.serviceInfo(reached);
    const access = values.access as Access | "none";
    const workspace = (
      local
        ? (fromHome(values.workspace) ?? (agentName ? agentFolder(agentName) : undefined))
        : values.path
    ) as string | undefined;
    // On this machine the folder is made if it's missing, typed or default. On another, only
    // its service can say whether the path will do.
    if (local && workspace !== undefined)
      try {
        mkdirSync(workspace, { recursive: true });
      } catch {
        throw new Refused("invalid", cantBeMade(workspace));
      }
    const computer = await Computer.create({
      ...reached,
      isolation,
      access,
      browser: values.browser === true,
      name,
      metadata: { agent },
      ...(workspace ? { workspace } : {}),
    });
    // The folder, so the person can find it: the service says where one it made is.
    const folder =
      workspace ??
      (await computer.getInfo().then(
        (info) => info.workspace,
        () => null,
      ));
    const where = local ? "this computer" : new URL(reached.apiUrl).host;
    const on = isolation === "container" ? `${where}, in a container` : `${where}, no isolation`;
    const servers = [];
    if (access !== "none") {
      // A folder too long for a connection's target is left out of it.
      const says = `${on}: ${SAYS[access]}`;
      const inFolder = `${says} in ${folder}`;
      servers.push({
        slot: COMPUTER,
        url: at(reached.apiUrl, computer.getMcpUrl("computer")),
        target: folder && inFolder.length <= TARGET_MAX ? inFolder : says,
      });
    }
    if (values.browser === true)
      servers.push({
        slot: BROWSER_SLOT,
        url: at(reached.apiUrl, computer.getMcpUrl("browser")),
        target: `A browser, ${on}`,
      });
    const held: NonNullable<Instance["computer"]> = {
      id: computer.computerID,
      token: computer.getMcpToken(),
      service: local ? { local: true } : reached,
    };
    // What the person reads of it beside its windows, fixed now: where it is, its folder, and
    // what it reaches. In a container the agent finds the folder elsewhere, so the row says both
    // and is no path to follow.
    const reaches = [
      ...(access === "none" ? [] : [REACHES[access]]),
      ...(values.browser === true ? ["Browser"] : []),
    ].join(", ");
    const folderRow: FactRow | undefined = !folder
      ? undefined
      : isolation === "container"
        ? { label: "Folder", value: `${folder} on the machine, mounted at /workspace in it` }
        : { label: "Folder", value: folder, path: true };
    const rows: Record<string, FactRow[]> = {
      [WHERE]: [{ label: "Where", value: local ? "This computer" : new URL(reached.apiUrl).host }],
      [WORKSPACE]: [
        // A folder too long for a row is left out of it, rather than shown cut.
        ...(folderRow && folderRow.value.length <= ROW_VALUE_MAX ? [folderRow] : []),
        { label: "Reaches", value: reaches },
      ],
    };
    return { servers, computer: held, rows };
  };

  /** How an instance stands: its connections' states as one, and what of it can be opened. */
  const stateOf = async (instance: string) => {
    const { found, servers } = held(instance);
    const each = servers.map((server, i) => ({
      connection: (found.links[i] as Linked).actor,
      ...server.status(),
    }));
    const down = each.find((one) => one.state === "down");
    const waiting = each.some((one) => one.state === "connecting");
    const surfaces = found.computer ? await surfacesOf(found.computer) : undefined;
    return {
      state: down ? ("down" as const) : waiting ? ("connecting" as const) : ("connected" as const),
      ...(down?.detail ? { detail: down.detail } : {}),
      connections: each,
      ...(surfaces ? { surfaces } : {}),
    };
  };
  /** A one-time way to open something of an instance's computer live. */
  const ticket = async (instance: string, surface: string, mode: "watch" | "operate") => {
    const { found } = held(instance);
    const reached = found.computer && reachOf(found.computer.service);
    if (!found.computer || !reached)
      throw new Refused("unknown", "Nothing of this can be opened live.");
    try {
      const session = await Computer.createLiveSession(
        found.computer.id,
        { surface: surface as LiveSurface, mode },
        reached,
      );
      return {
        url: socketAt(reached.apiUrl, session.url),
        protocol: session.protocol,
        expiresAt: session.expiresAt,
      };
    } catch (error) {
      if (!(error instanceof ComputerError)) throw error;
      throw new Refused(
        error.code === 404 || error.code === 400
          ? "unknown"
          : error.code === 409
            ? "state"
            : "failed",
        error.message,
      );
    }
  };
  /**
   * Join the Hub as the capability's own Actor for an instance's computer. It answers
   * as the instance stands, with no unit asked, and says so when a connection's state changes.
   */
  const joinCapability = async (
    instance: string,
    { actor, credential }: { actor: string; credential: string },
    servers: Connection[],
  ) => {
    const client = await connect({
      hubUrl,
      actorId: actor,
      credential,
      exports: { capability },
      log,
      start(ctx) {
        ctx.exports.capability.implement({
          async state() {
            const { state, detail, surfaces } = await stateOf(instance);
            return { state, ...(detail ? { detail } : {}), surfaces: surfaces ?? [] };
          },
          live: ({ surface, mode }) => ticket(instance, surface, mode),
        });
      },
    });
    capabilities.set(instance, client);
    for (const server of servers)
      server.onState(() => client.exports.capability.emit("changed", {}));
  };

  // Computers kept here come back with their service, started first if none runs, so their
  // connections find it where it is.
  if (
    onPath() &&
    Object.values(stored).some((entry) => entry.computer && "local" in entry.computer.service)
  )
    await startedLocal().catch((error) => log.error(messageOf(error)));
  for (const [instance, entry] of Object.entries(stored)) {
    const servers: Connection[] = [];
    try {
      for (const link of entry.links) servers.push(await open(link, entry.computer));
      running.set(instance, servers);
      if (entry.capability) await joinCapability(instance, entry.capability, servers);
      for (const server of servers) server.run();
    } catch (error) {
      log.error(`${instance} didn't rejoin the Hub: ${String(error)}`);
      running.delete(instance);
      capabilities.get(instance)?.close();
      capabilities.delete(instance);
      await Promise.all(servers.map((server) => server.end()));
      // The Hub no longer knows it: its Actors were closed while the provider was away.
      if (error instanceof Refused && error.code === "forbidden") {
        if (entry.computer) await killComputer(entry.computer).catch(() => {});
        delete stored[instance];
        save();
      }
    }
  }

  let closing = false;
  const provider = await connect({
    hubUrl,
    actorId: options.actorId,
    credential: options.credential,
    slots: { actors: hubActors },
    exports: { provider: unitProvider },
    log,
    start(ctx) {
      const known = (unit: string) => {
        if (unit !== COMPUTER && unit !== WEB)
          throw new Refused("unknown", `This provider has no unit ${unit}.`);
      };
      ctx.exports.provider.implement({
        units: async () => ({ units: [computerUnit(await findLocal()), WEB_UNIT] }),
        async skill({ unit, name, path: file }) {
          if (!SKILLS[unit]?.includes(name) || file !== "SKILL.md")
            throw new Refused("unknown", `${unit} has no file ${file} of a skill ${name}.`);
          return { text: await readFile(join(SKILLS_DIR, name, file), "utf8") };
        },
        async check({ unit, values, secrets }) {
          known(unit);
          return { problems: problems(unit, values, await findLocal(), secrets) };
        },
        async apply({ unit, values, secrets, name, agent, agentName }) {
          known(unit);
          const wrong = problems(unit, values, await findLocal(), Object.keys(secrets));
          if (wrong.length > 0)
            throw new Refused("invalid", wrong.map((problem) => problem.message).join(" "));
          const instance = `${unit}_${randomBytes(9).toString("hex")}`;
          const web = { url: options.webUrl ?? EXA_URL };
          const { servers, computer, rows } =
            unit === WEB
              ? {
                  servers: [{ slot: WEB, url: web.url, target: new URL(web.url).host }],
                  computer: undefined,
                  rows: undefined,
                }
              : await makeComputer(values, secrets, name, agent, agentName);
          const entry: Instance = { agent, links: [], ...(computer ? { computer } : {}) };
          const made: Connection[] = [];
          const connections: { slot: string; connection: string; target: string }[] = [];
          try {
            for (const { slot, url, target } of servers) {
              // A name of its own for each, as a computer can be two Actors.
              const { actorId, credential } = await ctx.slots.actors.call.create({
                name: servers.length > 1 ? `${name} (${slot})`.slice(0, 128) : name,
              });
              const link = { slot, actor: actorId, credential: credential as string, url };
              entry.links.push(link);
              made.push(await open(link, computer));
              connections.push({ slot, connection: actorId, target });
            }
            // The capability is an Actor of its own, beside the computer's connections.
            if (computer) {
              const { actorId, credential } = await ctx.slots.actors.call.create({
                name: `${name} (windows)`.slice(0, 128),
              });
              entry.capability = { actor: actorId, credential: credential as string };
            }
            if (entry.capability) await joinCapability(instance, entry.capability, made);
            // Checked after the last wait: a stop meanwhile ended only what was running then.
            if (closing) throw new Refused("unavailable", "This provider is stopping.");
            running.set(instance, made);
            stored[instance] = entry;
            save();
            for (const server of made) server.run();
          } catch (error) {
            running.delete(instance);
            delete stored[instance];
            capabilities.get(instance)?.close();
            capabilities.delete(instance);
            await Promise.all(made.map((server) => server.end()));
            for (const { actor } of [
              ...entry.links,
              ...(entry.capability ? [entry.capability] : []),
            ])
              await ctx.slots.actors.call.close({ actorId: actor }).catch(() => {});
            if (computer)
              await killComputer(computer).catch((failed) =>
                log.warn(`A computer may be left on its service: ${String(failed)}`),
              );
            throw error;
          }
          return {
            instance,
            connections,
            results: [],
            ...(entry.capability && rows
              ? { capability: { actor: entry.capability.actor, rows } }
              : {}),
          };
        },
        status: ({ instance }) => stateOf(instance),
        live: ({ instance, surface, mode }) => ticket(instance, surface, mode),
        async remove({ instance }) {
          const { found, servers } = held(instance);
          // First: if the service refuses, the rest is still here to be tried again.
          if (found.computer) await killComputer(found.computer);
          for (const { actor } of [...found.links, ...(found.capability ? [found.capability] : [])])
            await ctx.slots.actors.call.close({ actorId: actor });
          capabilities.get(instance)?.close();
          capabilities.delete(instance);
          running.delete(instance);
          delete stored[instance];
          try {
            save();
          } finally {
            await Promise.all(servers.map((server) => server.end()));
          }
          return {};
        },
      });
    },
  }).catch(async (error) => {
    await endAll();
    throw error;
  });

  return {
    async close() {
      closing = true;
      await endAll();
      provider.close();
    },
  };
}
