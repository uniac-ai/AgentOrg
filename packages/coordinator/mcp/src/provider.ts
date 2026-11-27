import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capabilityProvider, hubActors, unitProvider } from "@agentorg/interfaces";
import { type Log, Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { z } from "zod";
import { Connection, type Timing } from "./connection.js";
import {
  CAPABILITIES,
  fromArguments,
  namedSecrets,
  parseConnection,
  type Secrets,
  type Spec,
  targetOf,
  UNITS,
} from "./kinds.js";
import { notPublic } from "./public.js";

/** What is kept of a connection between runs, in the provider's private file. */
const Stored = z.object({
  credential: z.string(),
  kind: z.string(),
  params: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), z.string()),
  /** The agent it was mounted on, as a capability: none for one made as a unit. */
  agent: z.string().optional(),
});
const FILE = "connections.json";
/** What a unit's values come to as a connection's parameters: its name isn't one. */
const paramsOf = ({ slot: _, ...params }: Record<string, unknown>) => params;

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
 * Run the built-in MCP provider as an Actor exporting `unit.provider@1` as `provider`, and
 * `capability.provider@1` as `capabilities`. It offers two kinds, `url` and `command`, as units and
 * as capabilities an agent may hold any number of; a server it starts runs with this process's
 * rights. Connections made earlier are joined again at the start.
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
    exports: { provider: unitProvider, capabilities: capabilityProvider },
    log,
    start(ctx) {
      ctx.exports.provider.implement({
        units: () => ({ units: UNITS }),
        skill: () => {
          throw new Refused("unknown", "These units come with no skill.");
        },
        check({ unit, values, secrets }) {
          // Only whether a token is there matters, and a check never holds its value.
          const given = secrets.includes("token") ? { token: "given" } : {};
          const { why } = parseConnection(unit, paramsOf(values), given);
          return { problems: why ? [{ message: why }] : [] };
        },
        async apply({ unit: kind, values, secrets, name }) {
          const made = await make(kind, paramsOf(values), secrets, name);
          if ("why" in made) throw new Refused("invalid", made.why);
          // The instance is the connection: one made before units had no other id.
          return {
            instance: made.connection,
            connections: [
              { slot: String(values.slot), connection: made.connection, target: made.target },
            ],
            results: [],
          };
        },
        async status({ instance }) {
          const status = await held(instance).status();
          return {
            state: status.state,
            ...(status.detail ? { detail: status.detail } : {}),
            connections: [{ ...status, connection: instance }],
          };
        },
        live: () => {
          throw new Refused("unknown", "A connection has nothing to open live.");
        },
        remove: ({ instance: connection }) => takeOff(connection),
      });

      /** The mount, if the agent holds it: its connection is the mount. */
      const mountOf = (agent: string, mounted: string) => {
        if (stored[mounted]?.agent !== agent)
          throw new Refused("unknown", `${agent} has nothing mounted as ${mounted} here.`);
        return held(mounted);
      };
      ctx.exports.capabilities.implement({
        capabilities: () => ({ capabilities: CAPABILITIES }),
        skill: () => {
          throw new Refused("unknown", "These capabilities come with no skill.");
        },
        async mount({ agent, capability: kind, arguments: given }) {
          const capability = CAPABILITIES.find((one) => one.id === kind);
          if (!capability)
            throw new Refused("unknown", `This provider makes no capability ${kind}.`);
          const { slot, params, secrets } = fromArguments(kind, given);
          if (typeof slot !== "string" || !slot)
            return { problems: [{ path: "/slot", message: "Name must be given." }] };
          // Named, as its agent is named.
          const { name: agentName } = await ctx.slots.actors.call.get({ actorId: agent });
          const made = await make(
            kind,
            params,
            secrets,
            `${agentName}: ${capability.title}`.slice(0, 128),
            agent,
          );
          if ("why" in made) return { problems: [{ message: made.why }] };
          return {
            mounted: made.connection,
            made: { connections: [{ slot, connection: made.connection, target: made.target }] },
          };
        },
        async status({ agent, mounted }) {
          const { state, detail } = await mountOf(agent, mounted).status();
          // Connecting is down for now, with why; down says the server's words.
          if (state === "connected") return { state: "mounted" };
          return {
            state: "down",
            detail: (detail ?? (state === "connecting" ? "Connecting to its server." : "")).slice(
              0,
              2000,
            ),
          };
        },
        async unmount({ agent, mounted }) {
          mountOf(agent, mounted);
          return takeOff(mounted);
        },
      });

      /**
       * Make a connection to a server of `kind`, kept privately with its secrets: as a unit, or as a
       * capability on `agent`. What doesn't fit its kind is said, and nothing is made.
       */
      const make = async (
        kind: string,
        params: Record<string, unknown>,
        secrets: Secrets,
        name: string,
        agent?: string,
      ): Promise<{ connection: string; target: string } | { why: string }> => {
        const named = namedSecrets(secrets);
        if (!named.secrets) return { why: named.why ?? "Its secrets don't fit." };
        const { spec, secrets: hidden, why } = parseConnection(kind, params, named.secrets);
        if (!spec) return { why };
        // Said now, as well as at each request.
        const away = spec.kind === "url" && spec.public ? await notPublic(spec.url) : undefined;
        if (away) return { why: away };
        const { actorId, credential } = await ctx.slots.actors.call.create({ name });
        let connection: Connection | undefined;
        try {
          connection = await open(actorId, credential as string, spec, hidden);
          if (closing) throw new Refused("unavailable", "This provider is stopping.");
          stored[actorId] = {
            credential: credential as string,
            kind,
            params,
            secrets: hidden,
            ...(agent ? { agent } : {}),
          };
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
      };
      /** Close a connection's Actor and let its server go; its kept secrets go with it. */
      const takeOff = async (connection: string) => {
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
      };
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
