// The units' provider, and the connector to AgentComputer. A computer is one the service runs: this
// asks the service for it through its SDK, then opens an ordinary `url` connection to each endpoint
// with the computer's token. The web unit is one connection to a hosted server. Nothing here starts
// a service. The control token and each computer's token stay in this provider's private file.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Computer, ComputerError } from "@agentorg/computer";
import { hubActors, type Problem, unitProvider } from "@agentorg/interfaces";
import { Connection, parseConnection, type Timing } from "@agentorg/mcp";
import { type Log, Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
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
  SKILLS,
  WEB,
  WEB_UNIT,
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
const SKILLS_DIR = fileURLToPath(new URL("../../skills/", import.meta.url));
const EXA_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa";
const SERVICE_ANSWERS_MS = 2000;
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
  /** A private folder of the provider's, which holds each connection's Hub credential. */
  dir: string;
  /** Where a service on this machine writes its address and token; the service's own default. */
  dataFolder?: string;
  /** Where an agent's own folder goes when none is named; `~/Agents` by default. */
  agentsFolder?: string;
  /** The hosted server the web unit connects to; Exa's by default. For tests. */
  webUrl?: string;
  log?: Log;
  timing?: Timing;
}

export interface ComputerProvider {
  /** Leave the Hub and let every connection go. The computers stay, and resume at the next start. */
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
    wrong.push({ field: "service", message: "Choose a service." });
  if (values.access === "none") {
    if (values.browser !== true)
      wrong.push({
        field: "access",
        message: "With no files, no commands and no browser, there's no computer.",
      });
  } else if (!LEVELS.includes(values.access as string))
    wrong.push({ field: "access", message: "Choose what it can do." });
  const workspace = fromHome(values.workspace);
  if (values.service === LOCAL && workspace !== undefined) {
    let folder = false;
    try {
      folder = isAbsolute(workspace as string) && statSync(workspace as string).isDirectory();
    } catch {
      // Reported as not being a folder.
    }
    if (!folder) wrong.push({ field: "workspace", message: `There's no folder at ${workspace}.` });
  }
  return wrong;
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
  const stored = read();
  const save = () => {
    writeFileSync(`${path}.tmp`, JSON.stringify(stored), { mode: 0o600, flush: true });
    renameSync(`${path}.tmp`, path);
  };

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
  /** The service on this machine, if it answers now. */
  const findLocal = async (): Promise<Found> => {
    const reached = localService();
    if (!reached) return undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Computer.serviceInfo(reached),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(resolve, SERVICE_ANSWERS_MS, undefined);
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  const running = new Map<string, Connection[]>();
  /** Connect a link. A service on this machine may have moved to another port since. */
  const open = async ({ url, actor, credential }: Linked, computer?: Instance["computer"]) => {
    const moved = computer && "local" in computer.service ? localService()?.apiUrl : undefined;
    const token = computer?.token;
    const server = new Connection(
      { kind: "url", url: moved ? at(moved, url) : url },
      token ? { token } : {},
      log,
      options.timing,
    );
    await server.join({ hubUrl, actorId: actor, credential });
    return server;
  };
  const endAll = () => Promise.all([...running.values()].flat().map((server) => server.end()));
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

  for (const [instance, entry] of Object.entries(stored)) {
    const servers: Connection[] = [];
    try {
      for (const link of entry.links) servers.push(await open(link, entry.computer));
      running.set(instance, servers);
      for (const server of servers) server.run();
    } catch (error) {
      log.error(`${instance} didn't rejoin the Hub: ${String(error)}`);
      await Promise.all(servers.map((server) => server.end()));
      // The Hub no longer knows it: its Actors were closed while the provider was away.
      if (error instanceof Refused && error.code === "forbidden") {
        if (entry.computer) await killComputer(entry.computer).catch(() => {});
        delete stored[instance];
        save();
      }
    }
  }

  /** The folder an agent with this name works in when none is named. It stays when the agent goes. */
  const agentFolder = (agentName: string) => {
    const safe =
      agentName
        .trim()
        .replace(/[/\\\p{Cc}]/gu, "-")
        .replace(/^\.+/, "")
        .trim() || "agent";
    const folder = join(options.agentsFolder ?? join(homedir(), "Agents"), safe);
    try {
      mkdirSync(folder, { recursive: true });
    } catch {
      throw new Refused("invalid", `The folder ${folder} can't be made.`);
    }
    return folder;
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
    if (!reached) return undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const info = await Promise.race([
        Computer.getInfo(computer.id, reached),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(resolve, SURFACES_MS, undefined);
        }),
      ]);
      return info?.surfaces.map(({ surface, protocol, operate, unavailable }) => ({
        surface,
        protocol,
        operate,
        ...(unavailable ? { unavailable } : {}),
      }));
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  /** Make the computer, and say what each of its endpoints is. */
  const makeComputer = async (
    values: Record<string, unknown>,
    secrets: Record<string, string>,
    name: string,
    agent: string,
    agentName?: string,
  ) => {
    const local = values.service === LOCAL;
    const reached = local
      ? localService()
      : { apiUrl: String(values.address).replace(/\/$/, ""), apiKey: secrets.token as string };
    if (!reached) throw new Refused("invalid", INSTALL_STEPS);
    const { isolation } = await Computer.serviceInfo(reached);
    const access = values.access as Access | "none";
    const workspace = (
      local
        ? (fromHome(values.workspace) ?? (agentName ? agentFolder(agentName) : undefined))
        : values.path
    ) as string | undefined;
    const computer = await Computer.create({
      ...reached,
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
    const where = local ? "this machine" : new URL(reached.apiUrl).host;
    const on = isolation === "container" ? `${where}, in a container` : `${where}, no isolation`;
    const servers = [];
    if (access !== "none")
      servers.push({
        slot: COMPUTER,
        url: at(reached.apiUrl, computer.getMcpUrl("computer")),
        target: `${on}: ${SAYS[access]}${folder ? ` in ${folder}` : ""}`,
      });
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
    return { servers, computer: held };
  };

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
          const { servers, computer } =
            unit === WEB
              ? {
                  servers: [{ slot: WEB, url: web.url, target: new URL(web.url).host }],
                  computer: undefined,
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
            if (closing) throw new Refused("unavailable", "This provider is stopping.");
            running.set(instance, made);
            stored[instance] = entry;
            save();
            for (const server of made) server.run();
          } catch (error) {
            running.delete(instance);
            delete stored[instance];
            await Promise.all(made.map((server) => server.end()));
            for (const { actor } of entry.links)
              await ctx.slots.actors.call.close({ actorId: actor }).catch(() => {});
            if (computer)
              await killComputer(computer).catch((failed) =>
                log.warn(`A computer may be left on its service: ${String(failed)}`),
              );
            throw error;
          }
          return { instance, connections, results: [] };
        },
        status: async ({ instance }) => {
          const { found, servers } = held(instance);
          const each = servers.map((server, i) => ({
            connection: (found.links[i] as Linked).actor,
            ...server.status(),
          }));
          const down = each.find((one) => one.state === "down");
          const waiting = each.some((one) => one.state === "connecting");
          const surfaces = found.computer ? await surfacesOf(found.computer) : undefined;
          return {
            state: down
              ? ("down" as const)
              : waiting
                ? ("connecting" as const)
                : ("connected" as const),
            ...(down?.detail ? { detail: down.detail } : {}),
            connections: each,
            ...(surfaces ? { surfaces } : {}),
          };
        },
        async live({ instance, surface, mode }) {
          const { found } = held(instance);
          const reached = found.computer && reachOf(found.computer.service);
          if (!found.computer || !reached)
            throw new Refused("unknown", "Nothing of this can be opened live.");
          try {
            const session = await Computer.createLiveSession(
              found.computer.id,
              { surface: surface as "commands" | "terminal", mode },
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
        },
        async remove({ instance }) {
          const { found, servers } = held(instance);
          // First: if the service refuses, the rest is still here to be tried again.
          if (found.computer) await killComputer(found.computer);
          for (const { actor } of found.links)
            await ctx.slots.actors.call.close({ actorId: actor });
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
