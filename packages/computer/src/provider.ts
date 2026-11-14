// The units' provider, and the connector to AgentComputer. A computer is this one, attached whole,
// or one the service makes: this asks the service for it through its SDK, then opens an ordinary
// `url` connection to each endpoint with the computer's token, and joins the computer's capability
// as an Actor of its own, which the person is connected to. The web unit is one connection to a
// hosted server. When no service runs on this machine and AgentComputer is installed,
// `agentcomputer up` starts one: when a computer here is added, and at start for computers kept
// here. One an earlier version made with no isolation is no longer started: its capability says
// the ways on. The app doesn't include AgentComputer. The control token and each computer's token
// stay in this provider's private file.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
import { Computer, type ComputerDetail, ComputerError, type LiveSurface } from "@agentorg/computer";
import {
  capability,
  type FactRow as FactRowShape,
  hubActors,
  type Problem,
  unitProvider,
  type WayForward,
} from "@agentorg/interfaces";
import { Connection, type Groups, parseConnection, type Timing } from "@agentorg/mcp";
import { type Log, Refused } from "@agentorg/sdk";
import { type Client, connect } from "@agentorg/sdk/client";
import { z } from "zod";
import {
  type Access,
  BROWSER_SLOT,
  COMPUTER,
  CONTAINER,
  computerUnit,
  type Found,
  INSTALL_STEPS,
  NEW,
  REACHES,
  REMOTE,
  SKILLS,
  THIS,
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
  /**
   * Its computer failed and is stopped here to be started again: it is started until it runs,
   * after a restart too, since the service itself starts no stopped computer again.
   */
  restarting: z.literal(true).optional(),
});
type Instance = z.infer<typeof Stored>;
type Linked = z.infer<typeof Link>;
type TheProblem = z.input<typeof Problem>;
interface Reached {
  apiUrl: string;
  apiKey: string;
}

const FILE = "instances.json";
/** Holds the folders an earlier version's computers kept, by agent. */
const EARLIER_FILE = "earlier-folders.json";
const SKILLS_DIR = fileURLToPath(new URL("../../skills/", import.meta.url));
/**
 * The sha256 of every text each skill file has had in a version shipped, the current one among
 * them, by `<skill>/<path>`, from skills/shipped.json: a change of a file appends its new text's
 * hash there and keeps the old ones.
 */
const SKILLS_SHIPPED = JSON.parse(readFileSync(join(SKILLS_DIR, "shipped.json"), "utf8")) as Record<
  string,
  string[]
>;
const EXA_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa";
const SERVICE_ANSWERS_MS = 2000;
/** What to do when the AgentComputer here is older than this build can use. */
const UPDATE_STEPS =
  "AgentComputer on this computer is older than this AgentOrg needs. Update it with npm install -g @agentorg/computer, then stop the one running with agentcomputer down: AgentOrg starts it again for you.";
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
  /** A private folder of the provider's, which holds each connection's Hub credential. */
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
  /** The first wait before a failed computer is tried again; a minute by default. For tests. */
  mendFirstMs?: number;
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
/**
 * A computer its service says failed is stopped and started again, as the service says to: at
 * once, then after a wait that doubles each time up to the most, until it runs or its unit goes.
 */
const MEND_FIRST_MS = 60_000;
const MEND_MOST_MS = 30 * 60_000;

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

/** A computer an earlier version made here with no isolation: the folder kept, and its reach. */
interface Before {
  folder: string | null;
  access: string;
  browser: boolean;
}
/** A computer that isn't running, as the person reads it. */
const NOT_RUNNING: Record<Exclude<ComputerDetail["state"], "running">, string> = {
  stopped: "Its computer has stopped.",
  failed: "Its computer failed, and is started again by itself.",
};
/** While a failed computer is being stopped and started again. */
const TRYING = "Its computer is being started again.";
/** A failed computer being mended, as `mend` keeps it. */
interface Mending {
  timer?: NodeJS.Timeout;
  trying: boolean;
  /** The look or try under way, which a removal waits for. */
  going?: Promise<void>;
}
/** Whether the service says a computer is one an earlier version made with no isolation. */
const fromBefore = (info: ComputerDetail) => info.isolation === "none" && info.attached === false;
const beforeOf = (info: ComputerDetail): Before => ({
  folder: info.workspace ?? null,
  access: info.access,
  browser: info.browser,
});
/** What the person reads of one, in the words the service uses, and what goes either way. */
const beforeDetail = (folder: string | null) =>
  `A computer with no isolation is no longer made.${folder ? ` Its folder is kept at ${folder}.` : ""} Either way, its own browser and what it was signed in to aren't kept.`;
/**
 * The ways on from one: this computer with its folder, or a container whose workspace starts with
 * what is in it. One with no files has only the container, as this computer has no browser yet.
 */
const waysOn = ({ folder, access, browser }: Before): z.input<typeof WayForward>[] => [
  ...(access === "none"
    ? []
    : [
        {
          title: "Attach this computer",
          description: folder
            ? `Its work happens in ${folder}, as before. Unlike before, it reaches the whole machine, as you.`
            : "Unlike before, it reaches the whole machine, as you.",
          unit: COMPUTER,
          values: { kind: THIS, access, ...(folder ? { workspace: folder } : {}) },
        },
      ]),
  {
    title: "Make a container",
    description:
      folder && access !== "none"
        ? `Its workspace starts with what's in ${folder}.`
        : "Made for it on this machine, apart from yours.",
    unit: COMPUTER,
    values: { kind: NEW, made: CONTAINER, access, browser },
  },
];

/** Whether what was filled in is a computer on this machine: this one, or a container here. */
const onThisMachine = (values: Record<string, unknown>) =>
  values.kind === THIS || (values.kind === NEW && (values.made ?? CONTAINER) === CONTAINER);

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
  if (values.kind !== THIS && values.kind !== NEW)
    wrong.push({ field: "kind", message: "Choose which computer." });
  else if (onThisMachine(values) && !found) wrong.push({ field: "kind", message: INSTALL_STEPS });
  else if (values.kind === NEW && values.made === REMOTE) {
    const given = secrets.includes("token") ? { token: "given" } : {};
    const { why } = parseConnection("url", { url: values.address }, given);
    if (why) wrong.push({ field: "address", message: `That address won't do. ${why}` });
  } else if (values.kind === NEW && (values.made ?? CONTAINER) !== CONTAINER)
    wrong.push({ field: "made", message: "Choose how it's made." });
  if (values.access === "none") {
    // A browser of its own is a made computer's: this one has none yet.
    if (!(values.kind === NEW && values.browser === true))
      wrong.push({
        field: "access",
        message: "With no files, no commands and no browser, there's no computer.",
      });
  } else if (!LEVELS.includes(values.access as string))
    wrong.push({ field: "access", message: "Choose what it reaches." });
  // Where this computer's work happens: made with it if it's missing.
  const folder = fromHome(values.workspace);
  if (values.kind === THIS && folder !== undefined) {
    if (!isAbsolute(folder))
      wrong.push({
        field: "workspace",
        message: "Give the folder's full path, or one that starts with ~/.",
      });
    else if (!makeable(folder)) wrong.push({ field: "workspace", message: cantBeMade(folder) });
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
  /**
   * The service on this machine, if it answers now, and what it can make. One older than this
   * build, which says nothing of what it makes, answers as none does, with the steps to update.
   */
  const answering = async () => {
    const reached = localService();
    const info = reached && (await within(SERVICE_ANSWERS_MS, Computer.serviceInfo(reached)));
    if (!reached || !info) return undefined;
    if (!Array.isArray(info.made)) throw new Refused("unavailable", UPDATE_STEPS);
    return { reached, found: { thisComputer: info.thisComputer, made: info.made } };
  };
  /**
   * The service on this machine. When none answers, `agentcomputer up` starts one, or finds one
   * that answers after all. Calls made while it runs share it.
   */
  let starting: Promise<Reached> | undefined;
  const startedLocal = (): Promise<Reached> =>
    (starting ??= (async () => {
      const here = await answering();
      if (here) return here.reached;
      const command = onPath();
      if (!command) throw new Refused("invalid", INSTALL_STEPS);
      const data = options.dataFolder ?? defaultDataFolder();
      await promisify(execFile)(command, ["up", "--data", data], { timeout: UP_MS }).catch(
        (error: { killed?: boolean; stderr?: unknown }) => {
          const said = String(error.stderr ?? "").trim();
          throw new Refused(
            "unavailable",
            error.killed
              ? `AgentComputer didn't answer within ${UP_MS / 1000} seconds of being started. It may still be starting. Try again in a moment.`
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
  /** What the service on this machine can make, or that one will be started to make it. */
  const findLocal = async (): Promise<Found> => {
    try {
      return (await answering())?.found ?? (onPath() ? { made: [], starts: true } : undefined);
    } catch (error) {
      return { made: [], why: messageOf(error) };
    }
  };

  const running = new Map<string, Connection[]>();
  /** Failed computers being mended, by instance: `trying` while one is stopped and started. */
  const mending = new Map<string, Mending>();
  /** The last try to start each failed computer again, and the wait after it. */
  const tried = new Map<string, { at: number; wait: number }>();
  let ending = false;
  /**
   * Computers an earlier version made here with no isolation, by instance: no longer made or
   * started, with the folder the service keeps and what they reached, for the ways on.
   */
  const before = new Map<string, Before>();
  /** Find them on the service here, as it says of each: no isolation, and not attached. */
  const findBefore = async (reached: Reached) => {
    for (const [instance, entry] of Object.entries(stored)) {
      if (!entry.computer || !("local" in entry.computer.service)) continue;
      const info = await within(SERVICE_ANSWERS_MS, Computer.getInfo(entry.computer.id, reached));
      if (info && fromBefore(info)) before.set(instance, beforeOf(info));
    }
  };
  /**
   * One the service says is from before, found as its record is read after the start, as when the
   * service here was updated meanwhile: what of it was opened ends, and its capability says so.
   */
  const seenBefore = (computer: NonNullable<Instance["computer"]>, info: ComputerDetail) => {
    const instance = Object.keys(stored).find((key) => stored[key]?.computer?.id === computer.id);
    if (!instance || before.has(instance) || !("local" in computer.service)) return;
    before.set(instance, beforeOf(info));
    const ended = running.get(instance) ?? [];
    running.set(instance, []);
    void Promise.all(ended.map((server) => server.end()));
    capabilities.get(instance)?.exports.capability.emit("changed", {});
  };
  const keepEarlier = () => {
    try {
      keep(earlierPath, earlier);
    } catch (error) {
      log.warn(`The folders kept from before weren't written: ${messageOf(error)}`);
    }
  };
  /** Folders an earlier version's computers kept, by agent: its next computer starts with one. */
  const earlierPath = join(dir, EARLIER_FILE);
  const earlier: Record<string, string> = (() => {
    try {
      return z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(earlierPath, "utf8")));
    } catch {
      return {};
    }
  })();
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
    ending = true;
    for (const { timer } of mending.values()) clearTimeout(timer);
    mending.clear();
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

  /**
   * How a computer stands and what of it can be opened live, as its service says; nothing if it
   * can't say now.
   */
  const asked = new Map<string, { at: number; answer: ReturnType<typeof askInfo> }>();
  /** One question at a time per computer, and its answer kept a little while. */
  const infoOf = (computer: NonNullable<Instance["computer"]>) => {
    const kept = asked.get(computer.id);
    if (kept && Date.now() - kept.at < SURFACES_FRESH_MS) return kept.answer;
    const answer = askInfo(computer);
    asked.set(computer.id, { at: Date.now(), answer });
    return answer;
  };
  const askInfo = async (computer: NonNullable<Instance["computer"]>) => {
    const reached = reachOf(computer.service);
    const info = reached && (await within(SURFACES_MS, Computer.getInfo(computer.id, reached)));
    if (!info) return undefined;
    if (fromBefore(info)) seenBefore(computer, info);
    return {
      state: info.state,
      surfaces: info.surfaces.map(({ surface, protocol, operate, unavailable }) => ({
        surface,
        protocol,
        operate,
        ...(unavailable ? { unavailable } : {}),
      })),
    };
  };

  /**
   * Attach this computer, or make one, and say what each of its endpoints is and the rows fixed
   * for its views.
   */
  const makeComputer = async (
    values: Record<string, unknown>,
    secrets: Record<string, string>,
    name: string,
    agent: string,
    agentName?: string,
  ) => {
    const whole = values.kind === THIS;
    const here = onThisMachine(values);
    const reached = here
      ? await startedLocal()
      : { apiUrl: String(values.address).replace(/\/$/, ""), apiKey: secrets.token as string };
    const access = values.access as Access | "none";
    const browser = !whole && values.browser === true;
    const metadata = { agent };
    // The folder said to it on this computer, made if it's missing; or a path on the provider's
    // machine. A container here has a workspace of its own, which starts with what is in the
    // folder an earlier computer of the agent's kept, if it had one.
    const folder = whole
      ? (fromHome(values.workspace) ?? agentFolder(agentName ?? name))
      : here
        ? undefined
        : (values.path as string | undefined);
    if (whole && folder)
      try {
        mkdirSync(folder, { recursive: true });
      } catch {
        throw new Refused("invalid", cantBeMade(folder));
      }
    let copyFrom = here && !whole && access !== "none" ? earlier[agent] : undefined;
    // One no longer there would have the container refused: it is forgotten instead.
    if (copyFrom !== undefined && !statSync(copyFrom, { throwIfNoEntry: false })?.isDirectory()) {
      delete earlier[agent];
      keepEarlier();
      copyFrom = undefined;
    }
    const computer = whole
      ? await Computer.attach({ ...reached, access, workspace: folder as string, name, metadata })
      : await Computer.create({
          ...reached,
          ...(here ? { isolation: CONTAINER } : {}),
          access,
          browser,
          name,
          metadata,
          ...(folder ? { workspace: folder } : {}),
          ...(copyFrom ? { copyFrom } : {}),
        });
    const host = here ? undefined : new URL(reached.apiUrl).host;
    const on = whole ? "This computer, as you" : (host ?? "A container on this machine");
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
    if (browser)
      servers.push({
        slot: BROWSER_SLOT,
        url: at(reached.apiUrl, computer.getMcpUrl("browser")),
        target: `A browser, ${on}`,
      });
    const held: NonNullable<Instance["computer"]> = {
      id: computer.computerID,
      token: computer.getMcpToken(),
      service: here ? { local: true } : reached,
    };
    // What the person reads of it beside its windows, fixed now: which computer it is, what it
    // acts as and where its work happens, what it reaches, and its browser.
    const rows: Record<string, FactRow[]> = {
      [WHERE]: [
        {
          label: "Computer",
          value: whole ? "This computer" : (host ?? "A container on this machine"),
        },
      ],
      [WORKSPACE]: [
        ...(whole
          ? [
              { label: "Acts as", value: "You, with all you can reach", caution: true as const },
              // A folder too long for a row is left out of it, rather than shown cut.
              ...(folder && folder.length <= ROW_VALUE_MAX
                ? [{ label: "Its work happens in", value: folder, path: true as const }]
                : []),
            ]
          : []),
        ...(access === "none" ? [] : [{ label: "Reaches", value: REACHES[access] }]),
        { label: "Browser", value: browser ? "Its own browser" : "None" },
      ],
    };
    return { servers, computer: held, rows };
  };

  /**
   * Mend an instance's computer if its service says it failed: stop it and start it again, as the
   * service says to, and look again after a wait if it didn't start. One that keeps failing waits
   * twice as long each time, up to the most, until it has stayed up that long. It ends once the
   * computer runs, is stopped by someone else, or its unit goes. Only a failed one is started: one
   * being made is left to be made, and one made earlier with no isolation is left as it is.
   */
  const mend = (instance: string) => {
    if (ending || mending.has(instance)) return;
    const mine: Mending = { trying: false };
    mending.set(instance, mine);
    const first = options.mendFirstMs ?? MEND_FIRST_MS;
    const later = (ms: number) => {
      mine.timer = setTimeout(() => {
        mine.going = attempt();
      }, ms);
    };
    const restarting = (entry: Instance, now: boolean) => {
      if (Boolean(entry.restarting) === now || mending.get(instance) !== mine) return;
      if (now) entry.restarting = true;
      else delete entry.restarting;
      try {
        save();
      } catch (error) {
        log.warn(`Whether its computer is to be started again wasn't written: ${messageOf(error)}`);
      }
    };
    const changed = () => capabilities.get(instance)?.exports.capability.emit("changed", {});
    const attempt = async () => {
      const entry = stored[instance];
      const computer = entry?.computer;
      const reached = computer && reachOf(computer.service);
      const info =
        reached && (await within(SERVICE_ANSWERS_MS, Computer.getInfo(computer.id, reached)));
      if (mending.get(instance) !== mine) return;
      if (!entry || !computer || before.has(instance) || (info && fromBefore(info))) {
        mending.delete(instance);
        return;
      }
      if (info?.state === "running" || (info?.state === "stopped" && !entry.restarting)) {
        if (info.state === "running") restarting(entry, false);
        mending.delete(instance);
        return;
      }
      const last = tried.get(instance);
      // Being made, or its service can't say now: look again soon, with no try counted.
      if (!reached || !(info?.state === "failed" || info?.state === "stopped")) return later(first);
      const now = Date.now();
      if (last && now < last.at + last.wait) return later(last.at + last.wait - now);
      const wait =
        last && now - last.at < last.wait + MEND_MOST_MS
          ? Math.min(last.wait * 2, MEND_MOST_MS)
          : first;
      tried.set(instance, { at: now, wait });
      log.warn("Its computer failed: it is stopped and started again.", { instance });
      mine.trying = true;
      asked.delete(computer.id);
      changed();
      let started = false;
      try {
        if (info.state === "failed") {
          restarting(entry, true);
          await Computer.stop(computer.id, reached);
        }
        await Computer.start(computer.id, reached);
        restarting(entry, false);
        started = true;
      } catch (error) {
        log.warn(`Its computer didn't start again: ${messageOf(error)}`, { instance });
      }
      mine.trying = false;
      asked.delete(computer.id);
      changed();
      if (mending.get(instance) !== mine) return;
      if (started) mending.delete(instance);
      else later(wait);
    };
    mine.going = attempt();
  };
  /** How an instance stands: its connections' states as one, and what of it can be opened. */
  const stateOf = async (instance: string) => {
    const { found, servers } = held(instance);
    /** One from before: down, with nothing of it opened. */
    const fromEarlier = () => {
      const earlier = before.get(instance);
      if (!earlier) return undefined;
      const detail = beforeDetail(earlier.folder);
      return {
        state: "down" as const,
        detail,
        connections: found.links.map(({ actor }) => ({
          connection: actor,
          state: "down" as const,
          detail,
          tools: [],
        })),
        surfaces: [],
      };
    };
    const earlier = fromEarlier();
    if (earlier) return earlier;
    const info = found.computer ? await infoOf(found.computer) : undefined;
    // Failed, or marked to be started again: a mark left on a running one is cleared by the look.
    if (info?.state === "failed" || found.restarting) mend(instance);
    // A computer that isn't running is why its connections are down: they say so in its words.
    const why = mending.get(instance)?.trying
      ? TRYING
      : info && info.state !== "running"
        ? NOT_RUNNING[found.restarting ? "failed" : info.state]
        : undefined;
    const each = servers.map((server, i) => {
      const status = server.status();
      return {
        connection: (found.links[i] as Linked).actor,
        ...status,
        ...(why && status.state === "down" ? { detail: why } : {}),
      };
    });
    const down = each.find((one) => one.state === "down");
    const waiting = each.some((one) => one.state === "connecting");
    const surfaces = info?.surfaces;
    // Its record, read just now, may have said it is from before.
    const seen = fromEarlier();
    if (seen) return seen;
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
    const earlierOne = before.get(instance);
    if (earlierOne) throw new Refused("state", beforeDetail(earlierOne.folder));
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
            const earlier = before.get(instance);
            return {
              state,
              ...(detail ? { detail } : {}),
              surfaces: surfaces ?? [],
              ...(earlier ? { ways: waysOn(earlier) } : {}),
            };
          },
          live: ({ surface, mode }) => ticket(instance, surface, mode),
        });
      },
    });
    capabilities.set(instance, client);
    for (const server of servers)
      server.onState(() => {
        client.exports.capability.emit("changed", {});
        // Down, it may be because its computer failed: that is mended.
        if (server.status().state === "down") mend(instance);
      });
  };

  // Computers kept here come back with their service, started first if none runs, so their
  // connections find it where it is.
  if (
    onPath() &&
    Object.values(stored).some((entry) => entry.computer && "local" in entry.computer.service)
  )
    await startedLocal()
      .then(findBefore)
      .catch((error) => log.error(messageOf(error)));
  for (const [instance, entry] of Object.entries(stored)) {
    const servers: Connection[] = [];
    try {
      // One made with no isolation is no longer started: its capability says the ways on.
      if (before.has(instance)) {
        running.set(instance, servers);
        if (entry.capability) await joinCapability(instance, entry.capability, servers);
        continue;
      }
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
          const text = await readFile(join(SKILLS_DIR, name, file), "utf8");
          const now = createHash("sha256").update(text).digest("hex");
          const shipped = (SKILLS_SHIPPED[`${name}/${file}`] ?? []).filter((hash) => hash !== now);
          return { text, ...(shipped.length > 0 ? { shipped } : {}) };
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
            // The agent's next computer is this one: a folder kept from before is used up.
            if (computer && earlier[agent] !== undefined) {
              delete earlier[agent];
              keepEarlier();
            }
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
          // Nothing more is tried on its computer, which goes: a try under way ends first.
          const under = mending.get(instance);
          clearTimeout(under?.timer);
          mending.set(instance, { trying: false });
          tried.delete(instance);
          try {
            await under?.going;
            // First: if the service refuses, the rest is still here to be tried again.
            if (found.computer) await killComputer(found.computer);
          } finally {
            mending.delete(instance);
          }
          // One from before: the agent's next computer, as a container, starts with its folder.
          const earlierOne = before.get(instance);
          if (earlierOne?.folder && earlierOne.access !== "none") {
            earlier[found.agent] = earlierOne.folder;
            keepEarlier();
          }
          for (const { actor } of [...found.links, ...(found.capability ? [found.capability] : [])])
            await ctx.slots.actors.call.close({ actorId: actor });
          capabilities.get(instance)?.close();
          capabilities.delete(instance);
          running.delete(instance);
          before.delete(instance);
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
