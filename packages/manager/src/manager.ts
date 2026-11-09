import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentProvider,
  agentSettings,
  agents,
  ConnectionOrigin,
  type ConnectionStatus,
  connections,
  hubActors,
  hubBindings,
  hubGrants,
  mcpProvider,
  skills,
} from "@agentorg/interfaces";
import { describeInterface, type Interface, type Log, Refused, type Slot } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { z } from "zod";
import { createSkills, readSkillFolder, type SkillFiles } from "./skills.js";

/** What only management knows of an agent: where it came from, what it is told, and its skills. */
const AgentRecord = z.object({
  provider: z.string(),
  creatable: z.string(),
  instructions: z.string(),
  skills: z.array(z.string()),
  purpose: z.string().optional(),
});
const Records = z.object({
  agents: z.record(z.string(), AgentRecord),
  connections: z.record(z.string(), ConnectionOrigin),
});
type Origin = z.infer<typeof ConnectionOrigin>;
type Agents = Slot<typeof agentProvider>["call"];
type Mcp = Slot<typeof mcpProvider>["call"];
type Status = z.infer<typeof ConnectionStatus>;

const FILE = "manager.json";
const PERSON = "person";
const TOOLS = "tools@1";
const TOOLS_EXPORT = "tools";

export interface ManagerOptions {
  hubUrl: string;
  /** Its own Actor, bound to `hub.actors@1`, `hub.grants@1` and `hub.bindings@1`, which make it a manager. */
  actorId: string;
  credential: string;
  /** A private folder of its own, which holds its records and the skills. */
  dir: string;
  log?: Log;
}

export interface Manager {
  /** Leave the Hub. What it keeps stays. */
  close(): Promise<void>;
}

const quiet: Log = { info() {}, warn() {}, error() {} };
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Stacks, templates and units: declared, not served yet. */
const notYet = (): never => {
  throw new Refused("unimplemented", "Stacks of units aren't served yet.");
};
const alreadyGone = (error: unknown) => error instanceof Refused && error.code === "unknown";

/**
 * Run management as an Actor exporting `agents@1`, `connections@1`, `skills@1` and, as `settings`,
 * `agent.settings@1`. It keeps only what the Hub can't know. A provider is connected by exposing
 * its export to this Actor: the Hub's slots are the list of them, and what is exposed to an agent
 * is the Hub's bindings. No status is stored, and no secret reaches it to keep.
 */
export async function startManager(options: ManagerOptions): Promise<Manager> {
  const log = options.log ?? quiet;
  const { dir } = options;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, FILE);
  const read = (): z.infer<typeof Records> => {
    const empty = { agents: {}, connections: {} };
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
      throw error;
    }
    try {
      return Records.parse(JSON.parse(raw));
    } catch {
      renameSync(path, `${path}.unreadable-${Date.now()}`);
      log.error("Management's records can't be read: they are set aside and start empty.");
      return empty;
    }
  };
  const records = read();
  const save = () => {
    writeFileSync(`${path}.tmp`, JSON.stringify(records), { mode: 0o600, flush: true });
    renameSync(`${path}.tmp`, path);
  };
  const library = createSkills(join(dir, "skills"));
  /** Agents being made: they can read their settings, and nothing else can see them yet. */
  const creating = new Map<string, z.infer<typeof AgentRecord>>();

  const client = await connect({
    hubUrl: options.hubUrl,
    actorId: options.actorId,
    credential: options.credential,
    slots: { actors: hubActors, grants: hubGrants, bindings: hubBindings },
    exports: { agents, connections, skills, settings: agentSettings },
    log,
    start(ctx) {
      const hub = {
        actors: ctx.slots.actors.call,
        grants: ctx.slots.grants.call,
        bindings: ctx.slots.bindings.call,
      };
      /** The providers of an interface exposed to this Actor now. */
      const exposed = <T>(iface: Interface) => {
        const { id, hash } = describeInterface(iface);
        return ctx
          .exposed()
          .filter(({ described }) => described.id === id && described.hash === hash)
          .map(({ provider, call }) => ({ actor: provider.actor, call: call as unknown as T }));
      };
      const agentProviders = () => exposed<Agents>(agentProvider);
      const mcpProviders = () => exposed<Mcp>(mcpProvider);
      const named = <T extends { actor: string }>(list: T[], actor: string, what: string) => {
        const found = list.find((one) => one.actor === actor);
        if (!found) throw new Refused("unknown", `${actor} isn't a connected ${what}.`);
        return found;
      };
      const open = async () =>
        new Map(
          (await hub.actors.list({})).actors
            .filter((actor) => actor.state !== "closed")
            .map((actor) => [actor.actorId, actor]),
        );
      const nameOf = async (actor: string) => (await hub.actors.get({ actorId: actor })).name;
      const changed = (agent: string) => ctx.exports.settings.emit("changed", {}, { to: agent });
      /** What every one of these answers; one that doesn't is logged and left out. */
      const fromEach = async <T, R>(list: T[], read: (one: T) => Promise<R>) =>
        (await Promise.allSettled(list.map(read))).flatMap((result) => {
          if (result.status === "fulfilled") return [result.value];
          log.warn(`A provider didn't answer: ${messageOf(result.reason)}`);
          return [];
        });

      const recordOf = (agent: string) => {
        const record = records.agents[agent];
        if (!record) throw new Refused("unknown", `Management has no agent ${agent}.`);
        return record;
      };
      const settingsOf = (agent: string) => creating.get(agent) ?? recordOf(agent);
      const originOf = (connection: string) => {
        const origin = records.connections[connection];
        if (!origin) throw new Refused("unknown", `Management has no connection ${connection}.`);
        return origin;
      };
      const agentStatus = async (agent: string, provider: string) => {
        try {
          return await named(agentProviders(), provider, "agent provider").call.status({ agent });
        } catch {
          return { state: "down" as const, detail: "Its provider can't be reached." };
        }
      };
      const connectionStatus = async (connection: string): Promise<Status> => {
        const origin = records.connections[connection];
        if (!origin) {
          // Exposed by hand, so no provider is known: the Hub says whether it is there.
          const { connected } = await hub.actors.get({ actorId: connection });
          return { state: connected ? "connected" : "down", tools: [] };
        }
        try {
          const mcp = named(mcpProviders(), origin.provider, "MCP provider");
          return await mcp.call.status({ connection });
        } catch {
          return { state: "down", detail: "Its provider can't be reached.", tools: [] };
        }
      };
      const offering = async (kind: string) => {
        const providers = mcpProviders();
        const answers = await fromEach(providers, async ({ actor, call }) => ({
          actor,
          call,
          kinds: (await call.kinds({})).kinds,
        }));
        const found = answers.find((one) => one.kinds.some((k) => k.kind === kind));
        if (!found) throw new Refused("unknown", `No connected MCP provider offers ${kind}.`);
        return found;
      };
      const exposeConnection = async (agent: string, connection: string, as?: string) => {
        const { slot } = await hub.grants.expose({
          provider: connection,
          export: TOOLS_EXPORT,
          to: agent,
          ...(as ? { as } : {}),
        });
        return slot;
      };
      /** Remove a connection through its provider; one that has lost it leaves only the Actor. */
      const removeConnection = async (connection: string, provider: string) => {
        const mcp = mcpProviders().find((one) => one.actor === provider);
        try {
          if (mcp) return void (await mcp.call.remove({ connection }));
        } catch (error) {
          if (!alreadyGone(error)) throw error;
        }
        await hub.actors.close({ actorId: connection });
      };
      /** The same for an agent. */
      const removeAgent = async (agent: string, provider: string) => {
        const maker = agentProviders().find((one) => one.actor === provider);
        try {
          if (maker) return void (await maker.call.remove({ agent }));
        } catch (error) {
          if (!alreadyGone(error)) throw error;
        }
        await hub.actors.close({ actorId: agent });
      };
      /** For undoing: whatever the provider says, the thing goes. */
      const closing = (what: string, remove: () => Promise<void>) =>
        remove().catch(async (error) => {
          log.warn(`Removing ${what}: ${messageOf(error)}`);
          await hub.actors.close({ actorId: what });
        });
      const dropSkill = (name: string) => {
        library.remove(name);
        for (const [agent, record] of Object.entries(records.agents))
          if (record.skills.includes(name)) {
            record.skills = record.skills.filter((skill) => skill !== name);
            changed(agent);
          }
      };

      ctx.exports.settings.implement({
        get: (_, { caller }) => {
          const { instructions, skills: names } = settingsOf(caller);
          return {
            instructions,
            skills: names.flatMap((name) => library.entry(name) ?? []),
          };
        },
        skill: ({ name, path: file }, { caller }) => {
          const text = settingsOf(caller).skills.includes(name)
            ? library.read(name, file)
            : undefined;
          if (text === undefined)
            throw new Refused("unknown", `No skill ${name} with that file is exposed to you.`);
          return { text };
        },
      });

      ctx.exports.agents.implement({
        creatable: async () => ({
          creatables: (
            await fromEach(agentProviders(), async ({ actor, call }) =>
              (await call.creatable({})).creatables.map((one) => ({ ...one, provider: actor })),
            )
          ).flat(),
        }),
        providers: async () => ({
          providers: await Promise.all(
            agentProviders().map(async ({ actor }) => ({
              provider: actor,
              name: await nameOf(actor),
            })),
          ),
        }),

        units: async () => ({
          bases: (
            await fromEach(agentProviders(), async ({ actor, call }) => {
              const providerName = await nameOf(actor);
              return (await call.creatable({})).creatables.map((one) => ({
                ...one,
                provider: actor,
                providerName,
              }));
            })
          ).flat(),
          units: [],
        }),
        templates: async () => ({ templates: [] }),
        saveTemplate: notYet,
        removeTemplate: notYet,
        check: notYet,
        addUnit: notYet,
        removeUnit: notYet,

        async create(input, { caller }) {
          if (!("creatable" in input)) return notYet();
          const { creatable: id, name, answers, connections: picked = {}, purpose } = input;
          const provider = named(agentProviders(), input.provider, "agent provider");
          const creatable = (await provider.call.creatable({})).creatables.find((c) => c.id === id);
          if (!creatable) throw new Refused("unknown", `${input.provider} offers no ${id}.`);
          for (const need of creatable.mcp)
            if (need.how === "pick" && !picked[need.slot])
              throw new Refused("invalid", `Pick a connection for ${need.slot}.`);

          /** What this creation has made so far, undone last first if a step fails. */
          const undo: (() => unknown)[] = [];
          try {
            const made = await provider.call.create({ creatable: id, name, answers });
            const { agent } = made;
            undo.push(() => closing(agent, () => removeAgent(agent, input.provider)));
            const record: z.infer<typeof AgentRecord> = {
              provider: input.provider,
              creatable: id,
              instructions: creatable.instructions,
              skills: [],
              ...(purpose ? { purpose } : {}),
            };
            creating.set(agent, record);
            undo.push(() => creating.delete(agent));
            const origins: Record<string, Origin> = {};

            await hub.grants.bind({
              consumer: agent,
              slot: made.settings,
              provider: options.actorId,
              export: "settings",
            });

            for (const skill of creatable.skills) {
              if (!library.has(skill.name)) {
                const files: SkillFiles = {};
                for (const file of skill.files)
                  files[file] = (
                    await provider.call.skill({ creatable: id, name: skill.name, path: file })
                  ).text;
                library.add(files, skill.name);
                // Another agent may have been given it meanwhile, and then it stays.
                undo.push(() => {
                  if (!Object.values(records.agents).some((r) => r.skills.includes(skill.name)))
                    library.remove(skill.name);
                });
              }
              record.skills.push(skill.name);
            }

            for (const need of creatable.mcp) {
              let connection = picked[need.slot];
              if (need.how === "create") {
                const mcp = await offering(need.kind);
                const params = { ...need.params };
                for (const [param, ask] of Object.entries(need.fromAnswers ?? {}))
                  if (answers[ask] !== undefined) params[param] = answers[ask];
                const { connection: id2, target } = await mcp.call.create({
                  kind: need.kind,
                  params,
                  name: `${name}: ${need.title}`.slice(0, 128),
                });
                connection = id2;
                undo.push(() => closing(id2, () => removeConnection(id2, mcp.actor)));
                origins[id2] = {
                  provider: mcp.actor,
                  kind: need.kind,
                  target,
                  madeBy: caller,
                  madeFor: agent,
                  at: new Date().toISOString(),
                };
              }
              await exposeConnection(agent, connection as string, need.slot);
            }

            await hub.grants.expose({
              provider: agent,
              export: made.chat,
              to: PERSON,
            });
            records.agents[agent] = record;
            Object.assign(records.connections, origins);
            undo.push(() => {
              delete records.agents[agent];
              for (const connection of Object.keys(origins)) delete records.connections[connection];
            });
            save();
            creating.delete(agent);
            return { agent };
          } catch (error) {
            for (const step of undo.reverse())
              await Promise.resolve()
                .then(step)
                .catch((failed) => log.error(`Undoing a creation: ${messageOf(failed)}`));
            throw error;
          }
        },

        async list() {
          const actors = await open();
          return {
            agents: await Promise.all(
              Object.entries(records.agents).flatMap(([agent, record]) => {
                const actor = actors.get(agent);
                return actor
                  ? [
                      agentStatus(agent, record.provider).then((status) => ({
                        agent,
                        name: actor.name,
                        status,
                        provider: record.provider,
                        creatable: record.creatable,
                        ...(record.purpose ? { purpose: record.purpose } : {}),
                      })),
                    ]
                  : [];
              }),
            ),
          };
        },
        async get({ agent }) {
          const record = recordOf(agent);
          const { bindings } = await hub.bindings.list({ actor: agent });
          const [name, status, mcp] = await Promise.all([
            nameOf(agent),
            agentStatus(agent, record.provider),
            Promise.all(
              bindings
                .filter((b) => b.consumer === agent && b.interface === TOOLS)
                .map(async (b) => ({
                  slot: b.slot,
                  connection: b.provider,
                  ...(records.connections[b.provider]
                    ? { origin: records.connections[b.provider] as Origin }
                    : {}),
                  status: await connectionStatus(b.provider),
                })),
            ),
          ]);
          return {
            agent,
            name,
            status,
            provider: record.provider,
            creatable: record.creatable,
            ...(record.purpose ? { purpose: record.purpose } : {}),
            instructions: record.instructions,
            skills: record.skills.flatMap((skill) => library.entry(skill) ?? []),
            mcp,
            units: [],
          };
        },
        async start({ agent }) {
          const { provider } = recordOf(agent);
          return named(agentProviders(), provider, "agent provider").call.start({ agent });
        },
        async stop({ agent }) {
          const { provider } = recordOf(agent);
          return named(agentProviders(), provider, "agent provider").call.stop({ agent });
        },
        async expose(input) {
          const record = recordOf(input.agent);
          if ("connection" in input)
            return { slot: await exposeConnection(input.agent, input.connection, input.as) };
          if (!library.has(input.skill))
            throw new Refused("unknown", `Management has no skill ${input.skill}.`);
          if (!record.skills.includes(input.skill)) {
            record.skills.push(input.skill);
            save();
            changed(input.agent);
          }
          return {};
        },
        async unexpose(input) {
          const record = recordOf(input.agent);
          if ("slot" in input) {
            await hub.grants.unexpose({ to: input.agent, slot: input.slot });
            return {};
          }
          if (record.skills.includes(input.skill)) {
            record.skills = record.skills.filter((skill) => skill !== input.skill);
            save();
            changed(input.agent);
          }
          return {};
        },
        /** The connections go first: if one can't, the agent is still here to be tried again. */
        async remove({ agent }) {
          const record = recordOf(agent);
          for (const [connection, origin] of Object.entries(records.connections)) {
            if (origin.madeFor !== agent) continue;
            await removeConnection(connection, origin.provider);
            delete records.connections[connection];
            save();
          }
          await removeAgent(agent, record.provider);
          delete records.agents[agent];
          save();
          return {};
        },
      });

      ctx.exports.connections.implement({
        providers: async () => ({
          providers: await fromEach(mcpProviders(), async ({ actor, call }) => ({
            provider: actor,
            name: await nameOf(actor),
            kinds: (await call.kinds({})).kinds,
          })),
        }),
        // `secrets` go straight to the provider: nothing here keeps or logs them.
        async create({ provider, kind, params, secrets, name }, { caller }) {
          const mcp = named(mcpProviders(), provider, "MCP provider");
          const { connection, target } = await mcp.call.create({
            kind,
            params,
            name,
            ...(secrets ? { secrets } : {}),
          });
          try {
            records.connections[connection] = {
              provider,
              kind,
              target,
              madeBy: caller,
              at: new Date().toISOString(),
            };
            save();
          } catch (error) {
            delete records.connections[connection];
            await closing(connection, () => removeConnection(connection, provider));
            throw error;
          }
          return { connection };
        },
        async list() {
          const actors = await open();
          return {
            connections: await Promise.all(
              Object.entries(records.connections).flatMap(([connection, origin]) => {
                const actor = actors.get(connection);
                return actor
                  ? [
                      connectionStatus(connection).then(({ state }) => ({
                        connection,
                        name: actor.name,
                        state,
                        origin,
                      })),
                    ]
                  : [];
              }),
            ),
          };
        },
        async get({ connection }) {
          const origin = originOf(connection);
          return {
            connection,
            name: await nameOf(connection),
            origin,
            status: await connectionStatus(connection),
          };
        },
        async remove({ connection }) {
          const origin = originOf(connection);
          await removeConnection(connection, origin.provider);
          delete records.connections[connection];
          save();
          return {};
        },
      });

      ctx.exports.skills.implement({
        add: (input) => {
          const added = library.add("path" in input ? readSkillFolder(input.path) : input.files);
          for (const [agent, record] of Object.entries(records.agents))
            if (record.skills.includes(added.name)) changed(agent);
          return added;
        },
        list: () => ({ skills: library.list() }),
        get: ({ name }) => {
          const entry = library.entry(name);
          if (!entry) throw new Refused("unknown", `Management has no skill ${name}.`);
          return {
            ...entry,
            text: library.read(name) as string,
            files: library.paths(name),
            agents: Object.entries(records.agents)
              .filter(([, record]) => record.skills.includes(name))
              .map(([agent]) => agent),
          };
        },
        remove: ({ name }) => {
          if (!library.has(name)) throw new Refused("unknown", `Management has no skill ${name}.`);
          dropSkill(name);
          save();
          return {};
        },
      });
    },
  });

  return {
    async close() {
      client.close();
      await client.closed;
    },
  };
}
