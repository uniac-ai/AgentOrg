// The computer unit's provider. A local computer is AgentExec, run as the person through the MCP
// binding's connection, with an Actor offering its tools. The workspace is the person's folder:
// nothing here ever deletes it.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hubActors, type Problem, unitProvider } from "@agentorg/interfaces";
import { Connection, type Timing } from "@agentorg/mcp";
import { type Log, Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { z } from "zod";
import { type Access, COMPUTER_UNIT, SKILLS, SLOT, UNIT_ID } from "./unit.js";

const Stored = z.object({
  agent: z.string(),
  access: z.enum(["read", "files", "terminal"]),
  workspace: z.string(),
  connection: z.string(),
  credential: z.string(),
});
type Instance = z.infer<typeof Stored>;
const FILE = "instances.json";
const SKILLS_DIR = fileURLToPath(new URL("../../skills/", import.meta.url));
const SAYS: Record<Access, string> = {
  read: "reads files",
  files: "reads and changes files",
  terminal: "files and terminal",
};

export interface ComputerProviderOptions {
  hubUrl: string;
  /** The provider's own Actor, bound to `hub.actors@1` at its slot `actors`. */
  actorId: string;
  credential: string;
  /** A private folder of the provider's, which holds each connection's Hub credential. */
  dir: string;
  /** AgentExec's built file, which this runs with Node. */
  agentexec: string;
  log?: Log;
  timing?: Timing;
}

export interface ComputerProvider {
  /** Leave the Hub and stop every computer's server. They resume at the next start. */
  close(): Promise<void>;
}

const quiet: Log = { info() {}, warn() {}, error() {} };

/** What is wrong with what was filled in; nothing means it can be applied. */
function problems(values: Record<string, unknown>): z.input<typeof Problem>[] {
  const found: z.input<typeof Problem>[] = [];
  if (values.where !== "local")
    found.push({ field: "where", message: "Choose where the computer runs." });
  if (values.access === "none")
    found.push({
      field: "access",
      message: "With no files and no commands, there's no computer. Choose what it can do.",
    });
  else if (values.access !== "read" && values.access !== "files" && values.access !== "terminal")
    found.push({ field: "access", message: "Choose what it can do." });
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

/** Run the computer unit's provider as an Actor exporting `unit.provider@1` as `provider`. */
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

  const running = new Map<string, Connection>();
  const open = async ({ access, workspace, connection, credential }: Instance) => {
    const server = new Connection(
      {
        kind: "command",
        command: process.execPath,
        args: [options.agentexec, "--workspace", workspace, "--level", access],
        cwd: workspace,
      },
      {},
      log,
      options.timing,
    );
    await server.join({ hubUrl, actorId: connection, credential });
    return server;
  };
  const endAll = () => Promise.all([...running.values()].map((server) => server.end()));
  const held = (instance: string) => {
    const found = stored[instance];
    const server = running.get(instance);
    if (!found || !server)
      throw new Refused("unknown", `This provider holds no computer ${instance}.`);
    return { found, server };
  };

  for (const [instance, entry] of Object.entries(stored)) {
    try {
      const server = await open(entry);
      running.set(instance, server);
      server.run();
    } catch (error) {
      log.error(`Computer ${instance} didn't rejoin the Hub: ${String(error)}`);
      // The Hub no longer knows it: its Actor was closed while the provider was away.
      if (error instanceof Refused && error.code === "forbidden") {
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
      ctx.exports.provider.implement({
        units: async () => ({ units: [COMPUTER_UNIT] }),
        async skill({ unit, name, path: file }) {
          if (unit !== UNIT_ID || !SKILLS.includes(name) || file !== "SKILL.md")
            throw new Refused("unknown", `${unit} has no file ${file} of a skill ${name}.`);
          return { text: await readFile(join(SKILLS_DIR, name, file), "utf8") };
        },
        async check({ unit, values }) {
          if (unit !== UNIT_ID) throw new Refused("unknown", `This provider has no unit ${unit}.`);
          return { problems: problems(values) };
        },
        async apply({ unit, values, name, agent }) {
          if (unit !== UNIT_ID) throw new Refused("unknown", `This provider has no unit ${unit}.`);
          const wrong = problems(values);
          if (wrong.length > 0)
            throw new Refused("invalid", wrong.map((problem) => problem.message).join(" "));
          const access = values.access as Access;
          const workspace = values.workspace as string;
          const { actorId: connection, credential } = await ctx.slots.actors.call.create({ name });
          const instance = `computer_${randomBytes(9).toString("hex")}`;
          const entry = {
            agent,
            access,
            workspace,
            connection,
            credential: credential as string,
          };
          let server: Connection | undefined;
          try {
            server = await open(entry);
            if (closing) throw new Refused("unavailable", "This provider is stopping.");
            running.set(instance, server);
            stored[instance] = entry;
            save();
            server.run();
          } catch (error) {
            running.delete(instance);
            delete stored[instance];
            await server?.end();
            await ctx.slots.actors.call.close({ actorId: connection }).catch(() => {});
            throw error;
          }
          return {
            instance,
            connections: [
              {
                slot: SLOT,
                connection,
                target: `this computer, as you, in ${workspace}: ${SAYS[access]}`,
              },
            ],
            results: [],
          };
        },
        status: async ({ instance }) => {
          const { found, server } = held(instance);
          const status = server.status();
          return {
            state: status.state,
            ...(status.detail ? { detail: status.detail } : {}),
            connections: [{ connection: found.connection, ...status }],
          };
        },
        async remove({ instance }) {
          const { found, server } = held(instance);
          await ctx.slots.actors.call.close({ actorId: found.connection });
          running.delete(instance);
          delete stored[instance];
          try {
            save();
          } finally {
            await server.end();
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
