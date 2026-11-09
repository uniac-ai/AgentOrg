import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubActors, mcpProvider } from "@agentorg/interfaces";
import { type Log, Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { z } from "zod";
import { Connection, type Timing } from "./connection.js";
import { KINDS, parseConnection, type Secrets, type Spec, targetOf } from "./kinds.js";

/** What is kept of a connection between runs, in the provider's private file. */
const Stored = z.object({
  credential: z.string(),
  kind: z.string(),
  params: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), z.string()),
});
const FILE = "connections.json";

export interface McpProviderOptions {
  hubUrl: string;
  /** The provider's own Actor, bound to `hub.actors@1` at its slot `actors`. */
  actorId: string;
  credential: string;
  /** A private folder of the provider's, which holds each connection's Hub credential. */
  dir: string;
  log?: Log;
  /** How often a server is checked, and the first wait before trying one again. For tests. */
  timing?: Timing;
}

export interface McpProvider {
  /** Leave the Hub and let every server go. The connections stay, and resume at the next start. */
  close(): Promise<void>;
}

const quiet: Log = { info() {}, warn() {}, error() {} };

/**
 * Run the built-in MCP provider as an Actor exporting `mcp.provider@1` as `provider`. It offers two
 * kinds, `url` and `command`; a server it starts runs with this process's rights. Connections made earlier are joined again at the start.
 */
export async function startMcpProvider(options: McpProviderOptions): Promise<McpProvider> {
  const log = options.log ?? quiet;
  const { hubUrl, dir } = options;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, FILE);
  /** The file, entry by entry; one that can't be read is set aside and the rest still run. */
  const read = (): Record<string, z.infer<typeof Stored>> => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const entries = z.record(z.string(), z.unknown()).safeParse(
      (() => {
        try {
          return JSON.parse(raw);
        } catch {
          return undefined;
        }
      })(),
    );
    if (!entries.success) {
      renameSync(path, `${path}.unreadable-${Date.now()}`);
      log.error("The connections file can't be read: it is set aside and starts empty.");
      return {};
    }
    const kept: Record<string, z.infer<typeof Stored>> = {};
    for (const [id, entry] of Object.entries(entries.data)) {
      const parsed = Stored.safeParse(entry);
      if (parsed.success) kept[id] = parsed.data;
      else log.error(`Connection ${id} can't be read, and is left out.`);
    }
    return kept;
  };
  const stored = read();
  const save = () => {
    writeFileSync(`${path}.tmp`, JSON.stringify(stored), { mode: 0o600, flush: true });
    renameSync(`${path}.tmp`, path);
  };

  const connections = new Map<string, Connection>();
  const open = async (actorId: string, credential: string, spec: Spec, secrets: Secrets) => {
    const connection = new Connection(spec, secrets, log, options.timing);
    await connection.join({ hubUrl, actorId, credential });
    connections.set(actorId, connection);
    return connection;
  };
  let closing = false;
  const endAll = () => Promise.all([...connections.values()].map((c) => c.end()));
  const held = (id: string) => {
    const connection = connections.get(id);
    if (!connection) throw new Refused("unknown", `This provider holds no connection ${id}.`);
    return connection;
  };

  for (const [actorId, { credential, kind, params, secrets }] of Object.entries(stored)) {
    const { spec, secrets: hidden, why } = parseConnection(kind, params, secrets);
    if (!spec) {
      log.error(`Connection ${actorId} can't be read: ${why}`);
      continue;
    }
    try {
      (await open(actorId, credential, spec, hidden)).run();
    } catch (error) {
      log.error(`Connection ${actorId} didn't rejoin the Hub: ${String(error)}`);
      // The Hub no longer knows it: its Actor was closed while the provider was away.
      if (error instanceof Refused && error.code === "forbidden") {
        delete stored[actorId];
        save();
      }
    }
  }

  const provider = await connect({
    hubUrl,
    actorId: options.actorId,
    credential: options.credential,
    slots: { actors: hubActors },
    exports: { provider: mcpProvider },
    log,
    start(ctx) {
      ctx.exports.provider.implement({
        kinds: () => ({
          kinds: KINDS.map(({ kind, title, params, secrets }) => ({
            kind,
            title,
            params: JSON.parse(JSON.stringify(z.toJSONSchema(params))),
            secrets: JSON.parse(JSON.stringify(z.toJSONSchema(secrets))),
          })),
        }),
        async create({ kind, params, secrets, name }) {
          const { spec, secrets: hidden, why } = parseConnection(kind, params, secrets);
          if (!spec) throw new Refused("invalid", why);
          const { actorId, credential } = await ctx.slots.actors.call.create({ name });
          let connection: Connection | undefined;
          try {
            connection = await open(actorId, credential as string, spec, hidden);
            if (closing) throw new Refused("unavailable", "This provider is stopping.");
            stored[actorId] = { credential: credential as string, kind, params, secrets: hidden };
            save();
            connection.run();
          } catch (error) {
            connections.delete(actorId);
            delete stored[actorId];
            await connection?.end();
            await ctx.slots.actors.call.close({ actorId }).catch(() => {});
            throw error;
          }
          return { connection: actorId, target: targetOf(spec) };
        },
        status: ({ connection }) => held(connection).status(),
        async remove({ connection }) {
          const found = held(connection);
          await ctx.slots.actors.call.close({ actorId: connection });
          connections.delete(connection);
          delete stored[connection];
          try {
            save();
          } finally {
            await found.end();
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
