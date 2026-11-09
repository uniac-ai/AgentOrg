// The units' provider. A local computer is AgentExec and, when asked for, Playwright MCP, each run
// as the person through the MCP binding's connection, each an Actor offering its tools. The web
// unit is one connection to a hosted server. A workspace is the person's folder: nothing here ever
// deletes it, and only the folder this provider made for a browser goes with its computer.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hubActors, type Problem, unitProvider } from "@agentorg/interfaces";
import { Connection, type Spec, type Timing } from "@agentorg/mcp";
import { type Log, Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { z } from "zod";
import {
  type Access,
  BROWSER_SLOT,
  COMPUTER,
  COMPUTER_UNIT,
  SKILLS,
  WEB,
  WEB_UNIT,
} from "./unit.js";

const Link = z.object({
  slot: z.string(),
  actor: z.string(),
  credential: z.string(),
  spec: z.union([
    z.object({ kind: z.literal("url"), url: z.string() }),
    z.object({
      kind: z.literal("command"),
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
    }),
  ]),
  hide: z.array(z.string()),
});
const Stored = z.object({
  agent: z.string(),
  links: z.array(Link),
  /** A folder this provider made, which goes when the instance does. */
  own: z.string().optional(),
});
type Instance = z.infer<typeof Stored>;
type Linked = z.infer<typeof Link>;
const FILE = "instances.json";
const SKILLS_DIR = fileURLToPath(new URL("../../skills/", import.meta.url));
const EXA_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa";
/** Playwright's own README calls this equivalent to remote code execution. */
const RUNS_CODE = "browser_run_code_unsafe";
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
  /** AgentExec's built file, which this runs with Node. */
  agentexec: string;
  /** Playwright MCP's program and which browser it drives; the person's Chrome by default. */
  playwright?: { cli?: string; args?: string[] };
  /** The hosted server the web unit connects to; Exa's by default. For tests. */
  webUrl?: string;
  log?: Log;
  timing?: Timing;
}

export interface ComputerProvider {
  /** Leave the Hub and stop every server. They resume at the next start. */
  close(): Promise<void>;
}

const quiet: Log = { info() {}, warn() {}, error() {} };
const playwrightCli = () =>
  join(dirname(createRequire(import.meta.url).resolve("@playwright/mcp/package.json")), "cli.js");

/** What is wrong with what was filled in; nothing means it can be applied. */
function problems(unit: string, values: Record<string, unknown>): z.input<typeof Problem>[] {
  const found: z.input<typeof Problem>[] = [];
  if (unit === WEB) {
    if (values.service !== "exa") found.push({ field: "service", message: "Choose a service." });
    return found;
  }
  if (values.where !== "local")
    found.push({ field: "where", message: "Choose where the computer runs." });
  if (values.access === "none") {
    if (values.browser !== true)
      found.push({
        field: "access",
        message: "With no files, no commands and no browser, there's no computer.",
      });
    return found;
  }
  if (!LEVELS.includes(values.access as string))
    found.push({ field: "access", message: "Choose what it can do." });
  // Asked for here, not by `required`: a form field is shown by one condition, and this has two.
  if (values.where === "container") {
    if (!values.containerPath)
      found.push({ field: "containerPath", message: "Give the path it works in." });
    return found;
  }
  const { workspace } = values;
  if (typeof workspace !== "string" || !isAbsolute(workspace))
    found.push({ field: "workspace", message: "Give the full path of a folder." });
  else {
    let folder = false;
    try {
      folder = statSync(workspace).isDirectory();
    } catch {
      // Reported as not being a folder.
    }
    if (!folder) found.push({ field: "workspace", message: `There's no folder at ${workspace}.` });
  }
  return found;
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

  const running = new Map<string, Connection[]>();
  const open = async ({ spec, hide, actor, credential }: Linked) => {
    const server = new Connection(spec as Spec, {}, log, options.timing, hide);
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

  for (const [instance, entry] of Object.entries(stored)) {
    const servers: Connection[] = [];
    try {
      for (const link of entry.links) servers.push(await open(link));
      running.set(instance, servers);
      for (const server of servers) server.run();
    } catch (error) {
      log.error(`${instance} didn't rejoin the Hub: ${String(error)}`);
      await Promise.all(servers.map((server) => server.end()));
      // The Hub no longer knows it: its Actors were closed while the provider was away.
      if (error instanceof Refused && error.code === "forbidden") {
        delete stored[instance];
        save();
      }
    }
  }

  /** What a filled-in unit runs: each server with the slot it gives and what a person reads. */
  const plan = (unit: string, values: Record<string, unknown>, instance: string) => {
    if (unit === WEB) {
      const url = options.webUrl ?? EXA_URL;
      return {
        servers: [
          {
            slot: WEB,
            spec: { kind: "url" as const, url },
            hide: [],
            target: new URL(url).host,
          },
        ],
      };
    }
    const access = values.access as Access | "none";
    const workspace = values.workspace as string | undefined;
    const servers = [];
    if (access !== "none")
      servers.push({
        slot: COMPUTER,
        spec: {
          kind: "command" as const,
          command: process.execPath,
          args: [options.agentexec, "--workspace", workspace as string, "--level", access],
          cwd: workspace as string,
        },
        hide: [],
        target: `this computer, as you, in ${workspace}: ${SAYS[access]}`,
      });
    if (values.browser !== true) return { servers };
    const own = join(dir, "browsers", instance);
    mkdirSync(own, { recursive: true, mode: 0o700 });
    servers.push({
      slot: BROWSER_SLOT,
      spec: {
        kind: "command" as const,
        command: process.execPath,
        args: [
          options.playwright?.cli ?? playwrightCli(),
          "--headless",
          ...(options.playwright?.args ?? ["--browser", "chrome"]),
          "--user-data-dir",
          join(own, "profile"),
          "--output-dir",
          join(own, "output"),
        ],
        // Its file tools are kept to the folder it starts in.
        cwd: workspace ?? own,
      },
      // Below a terminal it would be one.
      hide: access === "terminal" ? [] : [RUNS_CODE],
      target: "a browser on this computer",
    });
    return { servers, own };
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
        units: async () => ({ units: [COMPUTER_UNIT, WEB_UNIT] }),
        async skill({ unit, name, path: file }) {
          if (!SKILLS[unit]?.includes(name) || file !== "SKILL.md")
            throw new Refused("unknown", `${unit} has no file ${file} of a skill ${name}.`);
          return { text: await readFile(join(SKILLS_DIR, name, file), "utf8") };
        },
        async check({ unit, values }) {
          known(unit);
          return { problems: problems(unit, values) };
        },
        async apply({ unit, values, name, agent }) {
          known(unit);
          const wrong = problems(unit, values);
          if (wrong.length > 0)
            throw new Refused("invalid", wrong.map((problem) => problem.message).join(" "));
          const instance = `${unit}_${randomBytes(9).toString("hex")}`;
          const { servers, own } = plan(unit, values, instance);
          const entry: Instance = { agent, links: [], ...(own ? { own } : {}) };
          const made: Connection[] = [];
          const connections: { slot: string; connection: string; target: string }[] = [];
          try {
            for (const { slot, spec, hide, target } of servers) {
              // A name of its own for each, as a computer can be two Actors.
              const { actorId, credential } = await ctx.slots.actors.call.create({
                name: servers.length > 1 ? `${name} (${slot})`.slice(0, 128) : name,
              });
              const link = { slot, actor: actorId, credential: credential as string, spec, hide };
              entry.links.push(link);
              made.push(await open(link));
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
            if (own) rmSync(own, { recursive: true, force: true });
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
          return {
            state: down
              ? ("down" as const)
              : waiting
                ? ("connecting" as const)
                : ("connected" as const),
            ...(down?.detail ? { detail: down.detail } : {}),
            connections: each,
          };
        },
        async remove({ instance }) {
          const { found, servers } = held(instance);
          for (const { actor } of found.links)
            await ctx.slots.actors.call.close({ actorId: actor });
          running.delete(instance);
          delete stored[instance];
          try {
            save();
          } finally {
            await Promise.all(servers.map((server) => server.end()));
          }
          // The browser's own profile and downloads. Never a workspace.
          if (found.own) rmSync(found.own, { recursive: true, force: true });
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
