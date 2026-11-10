import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentProvider,
  agentSettings,
  agents,
  type ConnectionOrigin,
  type ConnectionStatus,
  chat,
  connections,
  type FieldValues,
  hubActors,
  hubBindings,
  hubGrants,
  skills,
  type Template,
  tools,
  type Unit,
  unitProvider,
} from "@agentorg/interfaces";
import { describeInterface, type Interface, type Log, Refused, type Slot } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import type { z } from "zod";
import { createControl } from "./control.js";
import { schemaOf, secretsSchemaOf, settle } from "./form.js";
import { createSkills, readSkillFolder } from "./skills.js";
import { type AgentRecord, createStacks, Records, slotFieldOf } from "./stack.js";

type Origin = z.infer<typeof ConnectionOrigin>;
type Agents = Slot<typeof agentProvider>["call"];
type Units = Slot<typeof unitProvider>["call"];
type Chats = Slot<typeof chat>["call"];
type Status = z.infer<typeof ConnectionStatus>;

const FILE = "manager.json";
const CHAT_WAIT_MS = 2000;
const TOOLS_EXPORT = "tools";

export interface ManagerOptions {
  hubUrl: string;
  /** Its own Actor, bound to `hub.actors@1`, `hub.grants@1` and `hub.bindings@1`, which make it a manager. */
  actorId: string;
  credential: string;
  /** A private folder of its own, which holds its records and the skills. */
  dir: string;
  /** Templates the app ships. */
  templates?: z.infer<typeof Template>[];
  log?: Log;
}

export interface Manager {
  /** Leave the Hub. What it keeps stays. */
  close(): Promise<void>;
}

const quiet: Log = { info() {}, warn() {}, error() {} };
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The slot a connection is made for by the person: no agent has it yet, so it names nothing. */
const PERSON_SLOT = "tools";
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
    const empty = { agents: {}, connections: {}, templates: {}, instances: {} };
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
    exports: { agents, connections, skills, settings: agentSettings, tools },
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
      const unitProviders = () => exposed<Units>(unitProvider);
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
      const parentOf = ({ parent }: z.infer<typeof AgentRecord>) =>
        parent
          ? {
              parent: {
                ...parent,
                ...(records.agents[parent.agent] ? {} : { gone: true as const }),
              },
            }
          : {};
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
      const instanceOf = (connection: string) => records.instances[connection] ?? connection;
      const forget = (connection: string) => {
        delete records.connections[connection];
        delete records.instances[connection];
      };
      const connectionStatus = async (connection: string): Promise<Status> => {
        const unit = stacks.unitMaking(connection);
        if (unit) return stacks.connectionStatus(unit, connection);
        const origin = records.connections[connection];
        if (!origin) {
          // Exposed by hand, so no provider is known: the Hub says whether it is there.
          const { connected } = await hub.actors.get({ actorId: connection });
          return { state: connected ? "connected" : "down", tools: [] };
        }
        return stacks.connectionStatus(
          { provider: origin.provider, providerInstance: instanceOf(connection) },
          connection,
        );
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
        const maker = unitProviders().find((one) => one.actor === provider);
        try {
          if (maker) return void (await maker.call.remove({ instance: instanceOf(connection) }));
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
            for (const unit of record.units)
              unit.skills = unit.skills.filter((skill) => skill !== name);
            changed(agent);
          }
      };

      const stacks = createStacks({
        self: options.actorId,
        hub,
        records,
        save,
        library,
        creating,
        log,
        shipped: options.templates ?? [],
        agentProviders,
        unitProviders,
        recordOf,
        openActors: open,
        nameOf,
        changed,
        fromEach,
        exposeConnection,
        closing,
        removeAgent,
      });

      const startAgent = async (agent: string) => {
        const { provider } = recordOf(agent);
        return named(agentProviders(), provider, "agent provider").call.start({ agent });
      };
      const stopAgent = async (agent: string) => {
        const { provider } = recordOf(agent);
        return named(agentProviders(), provider, "agent provider").call.stop({ agent });
      };
      /** Its units and connections go first: if one can't, the agent is here to be tried again. */
      const removeWhole = (agent: string) =>
        stacks.serial(agent, async () => {
          const record = recordOf(agent);
          await stacks.removeAll(agent, record);
          for (const [connection, origin] of Object.entries(records.connections)) {
            if (origin.madeFor !== agent) continue;
            await removeConnection(connection, origin.provider);
            forget(connection);
            save();
          }
          await removeAgent(agent, record.provider);
          delete records.agents[agent];
          save();
          return {};
        });
      /** A child's chat: exposed to management when it is made, which takes a moment to arrive. */
      const chatOf = async (agent: string) => {
        for (let waited = 0; waited < CHAT_WAIT_MS; waited += 20) {
          const found = exposed<Chats>(chat).find((one) => one.actor === agent);
          if (found) return found.call;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Refused("not_connected", "That agent's chat can't be reached now.");
      };
      const control = createControl({
        self: options.actorId,
        records,
        creatingCount: () => creating.size,
        catalog: stacks.catalog,
        boundTo: async (agent) =>
          new Set(
            (await hub.bindings.list({ actor: agent })).bindings
              .filter((binding) => binding.consumer === agent)
              .map((binding) => `${binding.slot} ${binding.provider}`),
          ),
        templates: stacks.allTemplates,
        baseProviderNamed: stacks.baseProviderNamed,
        serial: stacks.serial,
        create: (input, caller, child) => stacks.create(input, caller, child),
        nameOf,
        chatOf,
        statusOf: agentStatus,
        start: startAgent,
        stop: stopAgent,
        remove: removeWhole,
      });
      /** Those who call management: the person. An agent comes through its agents unit instead. */
      const personOnly = <E extends { implement(handlers: never): void }>(exported: E) => ({
        implement(handlers: Parameters<E["implement"]>[0]) {
          const held = handlers as Record<
            string,
            (input: unknown, context: { caller: string }) => unknown
          >;
          exported.implement(
            Object.fromEntries(
              Object.entries(held).map(([method, handler]) => [
                method,
                (input: unknown, context: { caller: string }) => {
                  if (records.agents[context.caller] || creating.has(context.caller))
                    throw new Refused(
                      "forbidden",
                      "An agent reaches this through its agents unit.",
                    );
                  return handler(input, context);
                },
              ]),
            ) as never,
          );
        },
      });

      ctx.exports.tools.implement({
        list: async (_, { caller }) => ({ tools: await control.list(caller) }),
        call: ({ name, arguments: input }, { caller }) => control.call(caller, name, input),
      });

      ctx.exports.settings.implement({
        get: (_, { caller }) => {
          const { instructions, purpose, skills: names } = settingsOf(caller);
          return {
            instructions: purpose
              ? `${instructions}\n\nWhat you are for: ${purpose}`
              : instructions,
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

      personOnly(ctx.exports.agents).implement({
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

        units: () => stacks.units(),
        templates: () => stacks.templates(),
        saveTemplate: (template) => stacks.saveTemplate(template),
        removeTemplate: (input) => stacks.removeTemplate(input),
        check: (input) => stacks.check(input),
        create: (input, { caller }) => stacks.create(input, caller),
        addUnit: (input, { caller }) =>
          stacks.serial(input.agent, () => stacks.addUnit(input, caller)),
        removeUnit: (input) => stacks.serial(input.agent, () => stacks.removeUnit(input)),

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
                        ...(record.template ? { template: record.template } : {}),
                        ...parentOf(record),
                      })),
                    ]
                  : [];
              }),
            ),
          };
        },
        async get({ agent }) {
          const record = recordOf(agent);
          const { units, tools, instanceOfSkill, instanceOfSlot } = await stacks.read(
            agent,
            record,
            connectionStatus,
          );
          const [name, status, mcp] = await Promise.all([
            nameOf(agent),
            agentStatus(agent, record.provider),
            Promise.all(
              tools.map(async (b) => ({
                slot: b.slot,
                connection: b.provider,
                ...(records.connections[b.provider]
                  ? { origin: records.connections[b.provider] as Origin }
                  : {}),
                status: await connectionStatus(b.provider),
                instance: instanceOfSlot(b.slot),
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
            ...(record.template ? { template: record.template } : {}),
            ...parentOf(record),
            instructions: record.instructions,
            skills: record.skills.flatMap((skill) => {
              const entry = library.entry(skill);
              return entry ? [{ ...entry, instance: instanceOfSkill(skill) }] : [];
            }),
            mcp,
            units,
          };
        },
        start: ({ agent }) => startAgent(agent),
        stop: ({ agent }) => stopAgent(agent),
        expose: (input) =>
          stacks.serial(input.agent, async () => {
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
          }),
        unexpose: (input) =>
          stacks.serial(input.agent, async () => {
            const record = recordOf(input.agent);
            if (stacks.fromUnit(record, input))
              throw new Refused("state", "This came with a unit: remove the unit.");
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
          }),
        /** Units and connections go first: if one can't, the agent is still here to be tried again. */
        remove: ({ agent }) => removeWhole(agent),
      });

      personOnly(ctx.exports.connections).implement({
        providers: async () => ({
          providers: (
            await fromEach(unitProviders(), async ({ actor, call }) => ({
              provider: actor,
              name: await nameOf(actor),
              kinds: (
                await call.units({})
              ).units.flatMap((unit) => {
                const slot = slotFieldOf(unit);
                if (!slot) return [];
                const fields = unit.form.filter((field) => field.id !== slot);
                return [
                  {
                    kind: unit.id,
                    title: unit.title,
                    params: JSON.parse(JSON.stringify(schemaOf(fields))),
                    secrets: JSON.parse(JSON.stringify(secretsSchemaOf(fields))),
                  },
                ];
              }),
            }))
          ).filter(({ kinds }) => kinds.length > 0),
        }),
        // `secrets` go straight to the provider: nothing here keeps or logs them.
        async create({ provider, kind, params, secrets = {}, name }, { caller }) {
          const { call } = named(unitProviders(), provider, "connection provider");
          const unit = (await call.units({})).units.find((one) => one.id === kind);
          const slot = unit && slotFieldOf(unit);
          if (!unit || !slot) throw new Refused("invalid", `${provider} offers no ${kind}.`);
          const declared = Object.keys(secrets).filter((id) =>
            unit.form.some((field) => field.id === id && field.value === "secret"),
          );
          const settled = settle(
            unit.form,
            { ...params, [slot]: PERSON_SLOT } as z.infer<typeof FieldValues>,
            declared,
          );
          if (settled.problems.length)
            throw new Refused("invalid", settled.problems.map((one) => one.message).join(" "));
          const applied = await call.apply({
            unit: kind,
            values: settled.values,
            secrets,
            needs: {},
            agent: "person",
            name,
          });
          const [made] = applied.connections;
          if (!made || applied.connections.length !== 1) {
            await call.remove({ instance: applied.instance }).catch(async () => {
              for (const one of applied.connections)
                await hub.actors.close({ actorId: one.connection });
            });
            throw new Refused("failed", `${kind} didn't make one connection.`);
          }
          const { connection, target } = made;
          try {
            records.connections[connection] = {
              provider,
              kind,
              target,
              madeBy: caller,
              at: new Date().toISOString(),
            };
            records.instances[connection] = applied.instance;
            save();
          } catch (error) {
            await closing(connection, () => removeConnection(connection, provider));
            forget(connection);
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
          if (stacks.unitMaking(connection))
            throw new Refused("state", "This connection came with a unit: remove the unit.");
          await removeConnection(connection, origin.provider);
          forget(connection);
          save();
          return {};
        },
      });

      personOnly(ctx.exports.skills).implement({
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
