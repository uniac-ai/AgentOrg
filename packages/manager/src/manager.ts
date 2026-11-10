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
import { createActivity } from "./activity.js";
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
const ACTIVITY = "activity.jsonl";
/** Who a control call is made as, when it isn't on an agent's own behalf. */
const PERSON_CALLER = "person";
type Handler = (input: unknown, context: { caller: string }) => unknown;
const CHAT_WAIT_MS = 2000;
const CHAT = "chat@1";
/** What one agent may add of its own, at most. */
const AGENT_CONNECTIONS = 16;
const AGENT_SKILLS = 32;
const AGENT_SKILL_BYTES = 1024 * 1024;
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
    const empty = {
      agents: {},
      connections: {},
      templates: {},
      instances: {},
      authors: { skills: {}, templates: {} },
    };
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
  const activity = createActivity(join(dir, ACTIVITY));
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
      /** The caller when it's an agent, which reaches these only through its control unit. */
      const agentOf = (caller: string) =>
        records.agents[caller] || creating.has(caller) ? caller : undefined;
      /** A skill an agent added is seen by it and the agents below it, until the person shares it. */
      const seesSkill = (caller: string, name: string) => {
        const author = records.authors.skills[name];
        if (!author || !agentOf(caller)) return true;
        const seen = new Set<string>();
        for (let at: string | undefined = caller; at && !seen.has(at); ) {
          if (at === author) return true;
          seen.add(at);
          at = records.agents[at]?.parent?.agent;
        }
        return false;
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
      /** An agent's own provider, which holds what management doesn't: its model. */
      const makerOf = (agent: string) =>
        named(agentProviders(), recordOf(agent).provider, "agent provider").call;
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
          // What it wrote or saved is the person's now.
          for (const kept of [records.authors.skills, records.authors.templates])
            for (const [name, author] of Object.entries(kept))
              if (author === agent) delete kept[name];
          save();
          return {};
        });
      /** A child's chat: exposed to management when it is made, which takes a moment to arrive. */
      const chatOf = async (agent: string) => {
        const exposedChat = () => exposed<Chats>(chat).find((one) => one.actor === agent);
        if (!exposedChat()) {
          // One the person made: its chat is reached as the person reaches it.
          const { bindings } = await hub.bindings.list({ actor: PERSON_CALLER });
          const theirs = bindings.find(
            (one) =>
              one.provider === agent && one.interface === CHAT && one.consumer === PERSON_CALLER,
          );
          if (theirs)
            await hub.grants
              .expose({ provider: agent, export: theirs.export, to: options.actorId })
              .catch((error) => log.warn(`Reaching a chat: ${messageOf(error)}`));
        }
        for (let waited = 0; waited < CHAT_WAIT_MS; waited += 20) {
          const found = exposed<Chats>(chat).find((one) => one.actor === agent);
          if (found) return found.call;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Refused("not_connected", "That agent's chat can't be reached now.");
      };
      /**
       * An agent's chats reach the person, and management too for an agent another agent made. The
       * Hub drops both when the agent comes back offering its chats in another shape, as after an
       * upgrade, so they are made again each time it connects: nothing changes when they are there.
       */
      const reachChats = async (agent: string) => {
        const record = records.agents[agent];
        if (!record || !(await hub.actors.get({ actorId: agent })).connected) return;
        for (const to of [PERSON_CALLER, ...(record.parent ? [options.actorId] : [])])
          await hub.grants.expose({ provider: agent, export: record.chat, to });
      };
      const reaching = (agent: string) =>
        void reachChats(agent).catch((error) => log.warn(`Reaching a chat: ${messageOf(error)}`));
      ctx.slots.actors.on("changed", ({ actor }) => reaching(actor));
      // And for those that connected while management was away, once it can ask.
      ctx.slots.actors.onBind(() => {
        for (const agent of Object.keys(records.agents)) reaching(agent);
      });
      /** The person's own handlers, which an agent's control tools call after their checks. */
      const personHandlers: Partial<
        Record<"agents" | "connections" | "skills", Record<string, Handler>>
      > = {};
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
        // Held to the interface's own input, as the person's calls are by the Hub.
        person: async (iface, method, input, caller = PERSON_CALLER) => {
          const handler = personHandlers[iface]?.[method];
          const spec = (
            { agents, connections, skills }[iface].methods as Record<string, { input: z.ZodType }>
          )[method];
          if (!handler || !spec) throw new Refused("unimplemented", `${iface} has no ${method}.`);
          return handler(spec.input.parse(input), { caller });
        },
        hasSkill: (name, caller) => library.has(name) && seesSkill(caller, name),
        templateAuthor: (id) => records.authors.templates[id],
        madeBy: (connection) => records.connections[connection]?.madeBy,
        log: (entry) => activity.add(entry),
      });
      /** Those who call management: the person. An agent comes through its control unit instead. */
      const personOnly = <E extends { implement(handlers: never): void }>(
        exported: E,
        name: keyof typeof personHandlers,
      ) => ({
        implement(handlers: Parameters<E["implement"]>[0]) {
          const held = handlers as Record<string, Handler>;
          personHandlers[name] = held;
          exported.implement(
            Object.fromEntries(
              Object.entries(held).map(([method, handler]) => [
                method,
                (input: unknown, context: { caller: string }) => {
                  if (records.agents[context.caller] || creating.has(context.caller))
                    throw new Refused(
                      "forbidden",
                      "An agent reaches this through its control unit.",
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

      personOnly(ctx.exports.agents, "agents").implement({
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
        saveTemplate: (template, { caller }) => stacks.saveTemplate(template, agentOf(caller)),
        removeTemplate: (input, { caller }) => stacks.removeTemplate(input, agentOf(caller)),
        check: (input) => stacks.check(input),
        create: (input, { caller }) => stacks.create(input, caller),
        addUnit: (input, { caller }) =>
          stacks.serial(input.agent, () => stacks.addUnit(input, caller)),
        removeUnit: (input) => stacks.serial(input.agent, () => stacks.removeUnit(input)),
        activity: (input) => activity.read(input),
        async live({ agent, instance, surface, mode }) {
          const unit = recordOf(agent).units.find((one) => one.instance === instance);
          if (!unit || unit.provider === options.actorId)
            throw new Refused("unknown", `${agent} has nothing like that to open live.`);
          const provider = unitProviders().find((one) => one.actor === unit.provider);
          if (!provider) throw new Refused("not_connected", "Its provider can't be reached now.");
          return provider.call.live({ instance: unit.providerInstance, surface, mode });
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
        models: ({ agent }) => makerOf(agent).models({ agent }),
        setModel: (input) => makerOf(input.agent).setModel(input),
        expose: (input, { caller }) =>
          stacks.serial(input.agent, async () => {
            const record = recordOf(input.agent);
            if ("connection" in input)
              return { slot: await exposeConnection(input.agent, input.connection, input.as) };
            if (!library.has(input.skill) || !seesSkill(caller, input.skill))
              throw new Refused("unknown", `Management has no skill ${input.skill}.`);
            // The person giving an agent's skill to anyone shares it: it's the person's now.
            if (!agentOf(caller)) delete records.authors.skills[input.skill];
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

      personOnly(ctx.exports.connections, "connections").implement({
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
          const agent = agentOf(caller);
          if (
            agent &&
            Object.values(records.connections).filter((one) => one.madeBy === agent).length >=
              AGENT_CONNECTIONS
          )
            throw new Refused(
              "limit",
              `An agent can add at most ${AGENT_CONNECTIONS} connections.`,
            );
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
              // One an agent made goes with it.
              ...(agent ? { madeFor: agent } : {}),
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
        async remove({ connection }, { caller }) {
          const origin = originOf(connection);
          if (agentOf(caller) && origin.madeBy !== caller)
            throw new Refused("unknown", `You have no connection ${connection}.`);
          if (stacks.unitMaking(connection))
            throw new Refused("state", "This connection came with a unit: remove the unit.");
          await removeConnection(connection, origin.provider);
          forget(connection);
          save();
          return {};
        },
      });

      personOnly(ctx.exports.skills, "skills").implement({
        add: (input, { caller }) => {
          const agent = agentOf(caller);
          if (agent) {
            // An agent writes a skill of its own: it can't read a folder, or replace one there is.
            if ("path" in input) throw new Refused("forbidden", "An agent gives a skill as files.");
            const named = library.nameOf(input.files);
            if (library.has(named))
              throw new Refused("state", `There is a skill ${named} already.`);
            if (
              Object.values(records.authors.skills).filter((one) => one === agent).length >=
              AGENT_SKILLS
            )
              throw new Refused("limit", `An agent can write at most ${AGENT_SKILLS} skills.`);
            const bytes = Object.values(input.files).reduce(
              (sum, text) => sum + Buffer.byteLength(text),
              0,
            );
            if (bytes > AGENT_SKILL_BYTES)
              throw new Refused("limit", "An agent's skill can be at most 1 MB.");
            const added = library.add(input.files, named);
            records.authors.skills[added.name] = agent;
            save();
            return added;
          }
          const added = library.add("path" in input ? readSkillFolder(input.path) : input.files);
          // Replaced by the person, it's the person's.
          delete records.authors.skills[added.name];
          for (const [agent, record] of Object.entries(records.agents))
            if (record.skills.includes(added.name)) changed(agent);
          return added;
        },
        list: (_, { caller }) => ({
          skills: library.list().filter((one) => seesSkill(caller, one.name)),
        }),
        get: ({ name }, { caller }) => {
          const entry = seesSkill(caller, name) ? library.entry(name) : undefined;
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
        remove: ({ name }, { caller }) => {
          const agent = agentOf(caller);
          if (!library.has(name) || (agent && records.authors.skills[name] !== agent))
            throw new Refused("unknown", `Management has no skill ${name}.`);
          dropSkill(name);
          delete records.authors.skills[name];
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
