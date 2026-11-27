import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Arguments,
  agentProvider,
  agentSettings2,
  agents,
  agents2,
  type ConnectionOrigin,
  type ConnectionStatus,
  capabilityProvider,
  connections,
  type FieldValues,
  type HeldCapability,
  hubActors,
  hubBindings,
  hubGrants,
  type ProvidedStatus,
  skills,
  type Template,
  type Template2,
  tools,
  type Unit,
  unitProvider,
} from "@agentorg/interfaces";
import { describeInterface, type Interface, type Log, Refused, type Slot } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import type { z } from "zod";
import { createActivity } from "./activity.js";
import { type Activity, AGENTS_UNIT, createControl } from "./control.js";
import { schemaOf, secretsSchemaOf, settle } from "./form.js";
import { createMounts, keysOf } from "./mounts.js";
import {
  ALWAYS,
  alwaysOf,
  CONTROL_ROOT,
  fitted,
  SKILL_TOOL,
  skillAsked,
  treeOf,
} from "./settings.js";
import { createSkills, readSkillFolder } from "./skills.js";
import { type AgentRecord, createStacks, Records, slotFieldOf } from "./stack.js";

type Origin = z.infer<typeof ConnectionOrigin>;
type Agents = Slot<typeof agentProvider>["call"];
type Units = Slot<typeof unitProvider>["call"];
type Capabilities = Slot<typeof capabilityProvider>["call"];
type Status = z.infer<typeof ConnectionStatus>;

const FILE = "manager.json";
const ACTIVITY = "activity.jsonl";
/** Who a control call is made as, when it isn't on an agent's own behalf. */
const PERSON_CALLER = "person";
type Handler = (input: unknown, context: { caller: string }) => unknown;
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
  /** Templates of capabilities the app ships, which `agents@2` offers as capabilities. */
  capabilityTemplates?: z.infer<typeof Template2>[];
  log?: Log;
}

export interface Manager {
  /** Leave the Hub. What it keeps stays. */
  close(): Promise<void>;
}

const quiet: Log = { info() {}, warn() {}, error() {} };
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The control unit's name for a change the person makes through `agents@1`, so the control log
 * reads one set of names; none for a call that changes no agent. A creation is named by its
 * template, as control names one; one from a stack alone is `agent_create`.
 */
function changeOf(method: string, input: Record<string, unknown>): string | undefined {
  const stack = input.stack as { template?: string } | undefined;
  const template = typeof input.template === "string" ? input.template : stack?.template;
  switch (method) {
    case "create":
      return template ? `create_${template}` : "agent_create";
    case "start":
    case "stop":
    case "remove":
      return `agent_${method}`;
    case "addUnit":
      return "agent_add_unit";
    case "removeUnit":
      return "agent_remove_unit";
    case "mount":
      return "agent_mount";
    case "unmount":
      return "agent_unmount";
    case "expose":
      return "connection" in input ? "connection_expose" : "skill_expose";
    case "unexpose":
      return "slot" in input ? "connection_unexpose" : "skill_unexpose";
  }
  return undefined;
}

/** The secret values a call carries, in any `secrets` within its input. */
function secretsIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const one of value) secretsIn(one, found);
  else if (value && typeof value === "object")
    for (const [key, inner] of Object.entries(value))
      if (key === "secrets" && inner && typeof inner === "object")
        found.push(...Object.values(inner).filter((one): one is string => typeof one === "string"));
      else secretsIn(inner, found);
  return found;
}
/** The slot a connection is made for by the person: no agent has it yet, so it names nothing. */
const PERSON_SLOT = "tools";
const alreadyGone = (error: unknown) => error instanceof Refused && error.code === "unknown";
/** A skill's or connection's `instance`: the unit of its stack that gave it, if one did. */
const withInstance = (instance: string | undefined) => (instance ? { instance } : {});

/**
 * The records as this version reads them. What an agent holds keeps the members a later version
 * added (`CapabilityRecord`). A member this version doesn't know anywhere else, such as in a saved
 * template, whose members say how an agent is built, is left out, and is gone after this version
 * next saves; the rest is still read, where before all of it was set aside. What was left out is
 * given back, to be said once. This relies on zod reporting `unrecognized_keys` at the object's
 * path, which it does for the records' strict shapes: they hold no union of objects, where it
 * could read a record as another of its kinds.
 */
function withoutLater(parsed: unknown) {
  const left: string[] = [];
  for (;;) {
    const read = Records.safeParse(parsed);
    if (read.success) return { read: read.data, left };
    const { issues } = read.error;
    if (!issues.every((issue) => issue.code === "unrecognized_keys")) throw read.error;
    let dropped = false;
    for (const issue of issues) {
      const at = issue.path.reduce<unknown>(
        (value, key) => (value as Record<PropertyKey, unknown> | undefined)?.[key],
        parsed,
      ) as Record<string, unknown> | undefined;
      for (const key of issue.keys)
        if (at && key in at) {
          delete at[key];
          left.push([...issue.path, key].join("."));
          dropped = true;
        }
    }
    if (!dropped) throw read.error;
  }
}

/**
 * Run management as an Actor exporting `agents@1`, `connections@1`, `skills@1`, as `settings`,
 * `agent.settings@2`, and, as `skillTools`, a `tools@1` whose one tool, `skill`, reads a skill's
 * files, exposed to each agent at `settings`. It keeps only what the Hub can't know. A provider is
 * connected by exposing its export to this Actor: the Hub's slots are the list of them, and what
 * is exposed to an agent is the Hub's bindings. No status is stored, and no secret reaches it to
 * keep. Each agent's provider is given what is mounted on the agent, with `agent.provider@2`'s
 * `mounted`: when it is made, whenever that changes, and whenever the provider is there anew.
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
      capabilityTemplates: {},
      instances: {},
      copies: {},
      uncopied: [],
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
      const parsed = JSON.parse(raw);
      const { read, left } = withoutLater(parsed);
      if (left.length > 0)
        log.warn("Management's records hold what a later version wrote: left out.", { left });
      // From before copies were kept: its units' skills are still to be taken as copies, each
      // when its text is one its provider shipped.
      if (parsed && typeof parsed === "object" && !("copies" in parsed))
        read.uncopied = [
          ...new Set(
            Object.values(read.agents).flatMap((agent) =>
              agent.units.flatMap((unit) => unit.skills),
            ),
          ),
        ];
      return read;
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
  /** Keep a line of the control log. Its failure is its own: it never fails what it records. */
  const note = (entry: Activity) => {
    try {
      activity.add(entry);
    } catch {
      // Nothing else to do.
    }
  };
  /** Agents being made: they can read their settings, and nothing else can see them yet. */
  const creating = new Map<string, z.infer<typeof AgentRecord>>();

  const client = await connect({
    hubUrl: options.hubUrl,
    actorId: options.actorId,
    credential: options.credential,
    slots: { actors: hubActors, grants: hubGrants, bindings: hubBindings },
    exports: {
      agents,
      agents2,
      connections,
      skills,
      settings: agentSettings2,
      tools,
      skillTools: tools,
    },
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
      const capabilityProviders = () => exposed<Capabilities>(capabilityProvider);
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
      /**
       * What is mounted on an agent now, as its settings answer it and its provider is given it:
       * the tree, with the words management tells it of itself and the skills exposed to it, each
       * with what its `ALWAYS.md` says, so the agent reads nothing for it.
       */
      const listOf = (agent: string) => {
        const record = settingsOf(agent);
        const { instructions, purpose, parent, skills: names } = record;
        // A message from its maker says it is from its id: this says whose that is, while the
        // maker is here. Its name is the maker's own words, kept to one line.
        const maker = parent && records.agents[parent.agent] ? parent : undefined;
        const told = [
          instructions,
          ...(purpose ? [`What you are for: ${purpose}`] : []),
          ...(maker
            ? [
                `You were made by the agent ${JSON.stringify(maker.name.replace(/\s+/g, " ").trim())} (${maker.agent}). Its messages to you say they are from ${maker.agent}.`,
              ]
            : []),
        ].join("\n\n");
        const exposed = names.flatMap((name) => {
          const entry = library.entry(name);
          const always = entry && alwaysOf(library.read(name, ALWAYS));
          return entry ? [always ? { ...entry, always } : entry] : [];
        });
        return treeOf(record, options.actorId, told, exposed);
      };
      /** Each agent's giving now, so each is given its list after the one before has answered. */
      const giving = new Map<string, Promise<void>>();
      /**
       * Give an agent's provider what is mounted on the agent now, and settle once it has answered:
       * the list is made as it goes, so the last given is the newest. A provider that isn't there,
       * or doesn't answer, is given every list when it is there again: that is logged, and
       * nothing fails for it.
       */
      const give = (agent: string) => {
        const done = (giving.get(agent) ?? Promise.resolve()).then(async () => {
          const record = creating.get(agent) ?? records.agents[agent];
          const provider = agentProviders().find((one) => one.actor === record?.provider);
          if (!provider) return;
          try {
            await provider.call.mounted({ agent, mounted: listOf(agent) });
          } catch (error) {
            log.warn(`Giving an agent what is mounted on it: ${messageOf(error)}`, { agent });
          }
        });
        giving.set(agent, done);
        void done.then(() => {
          if (giving.get(agent) === done) giving.delete(agent);
        });
        return done;
      };
      /** Give every agent of `actor`, or of every agent provider there now, its list. */
      const giveAll = (actor?: string) => {
        for (const [agent, record] of Object.entries(records.agents))
          if (actor === undefined || record.provider === actor) void give(agent);
      };
      /**
       * What is mounted on the agent changed: it is told so, and its provider is given its list.
       * It settles once the provider has answered.
       */
      const changed = (agent: string) => {
        ctx.exports.settings.emit("changed", {}, { to: agent });
        return give(agent);
      };
      const originOf = (connection: string) => {
        const origin = records.connections[connection];
        if (!origin) throw new Refused("unknown", `Management has no connection ${connection}.`);
        return origin;
      };
      const agentStatus = async (
        agent: string,
        provider: string,
      ): Promise<z.infer<typeof ProvidedStatus>> => {
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
      /** Delete a skill, and settle once each agent it was exposed to has been given that. */
      const dropSkill = (name: string) => {
        library.remove(name);
        delete records.copies[name];
        records.uncopied = records.uncopied.filter((one) => one !== name);
        const told: Promise<void>[] = [];
        for (const [agent, record] of Object.entries(records.agents))
          if (record.skills.includes(name)) {
            record.skills = record.skills.filter((skill) => skill !== name);
            for (const unit of record.units)
              unit.skills = unit.skills.filter((skill) => skill !== name);
            told.push(changed(agent));
          }
        return Promise.all(told);
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
        give,
        listOf,
        fromEach,
        exposeConnection,
        reachPerson: async (provider, exported) =>
          (await hub.grants.expose({ provider, export: exported, to: PERSON_CALLER })).slot,
        unreachPerson: async (slot, provider) => {
          const { bindings } = await hub.bindings.list({ actor: PERSON_CALLER });
          if (!bindings.some((one) => one.slot === slot && one.provider === provider)) return;
          await hub.grants.unexpose({ to: PERSON_CALLER, slot }).catch((error) => {
            if (!alreadyGone(error)) throw error;
          });
        },
        closing,
        removeAgent,
      });

      const mounts = createMounts({
        self: options.actorId,
        records,
        save,
        log,
        recordOf,
        serial: stacks.serial,
        providers: capabilityProviders,
        changed,
        give,
        wire: (agent, record, root, made, skillOf) =>
          stacks.wireMade(agent, record, root, made, skillOf),
        unwire: (agent, record, root) => stacks.unwireMade(agent, record, root),
        reachControl: async (agent, reach) => {
          if (reach) await stacks.reachManagement(agent);
          else {
            await stacks.unreachManagement(agent);
            await stacks.unreachAgents(agent);
          }
        },
        settleControl: (record, given, by) => stacks.settleControl(record, given as never, by),
        wireControl: (agent, record) => stacks.wireControl(agent, record),
        nameOf,
      });
      /**
       * Mount through `mount`, and once control is mounted, have the agent reach the agents its
       * arguments let it, as an AgentOrg control unit added does.
       */
      const mountReaching = async <T extends { mounted: string } | { problems: unknown[] }>(
        agent: string,
        capability: string,
        mount: () => Promise<T>,
      ) => {
        const made = await mount();
        // Control itself, or as one of a template's.
        const control = recordOf(agent).mounted.find((one) => one.capability === CONTROL_ROOT);
        if (
          "mounted" in made &&
          control &&
          (capability === CONTROL_ROOT || control.parent === made.mounted)
        )
          await stacks.reachAgents((_, reaching) => reaching === agent);
        return made;
      };
      /** What capability providers offer, each naming its provider: control's arguments are management's. */
      const offered = async () =>
        (
          await fromEach(capabilityProviders(), async ({ actor, call }) =>
            (await call.capabilities({})).capabilities.map((one) => ({ ...one, provider: actor })),
          )
        ).flat();
      const withControl = async <T extends { id: string; arguments: unknown }>(all: T[]) => {
        const schema = all.some((one) => one.id === CONTROL_ROOT)
          ? await stacks.controlSchema()
          : undefined;
        return all.map((one) =>
          one.id === CONTROL_ROOT && schema ? { ...one, arguments: schema as never } : one,
        );
      };

      /** An agent's own provider, which runs it and keeps its model. */
      const makerOf = (agent: string) =>
        named(agentProviders(), recordOf(agent).provider, "agent provider").call;
      const startAgent = async (agent: string) => makerOf(agent).start({ agent });
      const stopAgent = async (agent: string) => makerOf(agent).stop({ agent });
      /** Its units and connections go first: if one can't, the agent is here to be tried again. */
      const removeWhole = (agent: string) =>
        stacks.serial(agent, async () => {
          const record = recordOf(agent);
          await mounts.unmountAll(agent, record);
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
          // Those it made are told of it no more.
          await Promise.all(
            Object.entries(records.agents).flatMap(([made, one]) =>
              one.parent?.agent === agent ? [give(made)] : [],
            ),
          );
          return {};
        });
      /**
       * An agent's conversations reach the person. The Hub keeps that across an update of either
       * end, and drops it when the agent stops offering them, so it is made again each time it
       * connects: nothing changes when it is there.
       */
      const reachChats = async (agent: string) => {
        const record = records.agents[agent];
        if (!record || !(await hub.actors.get({ actorId: agent })).connected) return;
        await hub.grants.expose({ provider: agent, export: record.chat, to: PERSON_CALLER });
      };
      const reaching = (agent: string) =>
        void reachChats(agent).catch((error) => log.warn(`Reaching a chat: ${messageOf(error)}`));
      ctx.slots.actors.on("changed", ({ actor }) => reaching(actor));
      // And for those that connected while management was away, once it can ask.
      ctx.slots.actors.onBind(() => {
        for (const agent of Object.keys(records.agents)) reaching(agent);
      });
      /** The same for the person's slots to what agents hold: made again when one has gone. */
      /**
       * Have every agent hold what its creatable gives it of itself, where it doesn't yet: one pass
       * at a time, and asked again while one runs, one more after it.
       */
      let owning: Promise<void> | undefined;
      let owningAgain = false;
      const owns = () => {
        if (owning) {
          owningAgain = true;
          return;
        }
        owning = (async () => {
          do {
            owningAgain = false;
            await stacks.holdOwns().catch((error) => {
              if (!alreadyGone(error))
                log.warn(`Holding what agents give themselves: ${messageOf(error)}`);
            });
            // An agent that now holds its own Work is reached by the one that made it.
            await stacks.reachAgents();
          } while (owningAgain);
        })().finally(() => {
          owning = undefined;
        });
      };
      /**
       * Bring the skills units gave up to date: one pass at a time, and one more after it for
       * whatever asked while it ran.
       */
      let refreshingNow: Promise<void> | undefined;
      let refreshAgain = false;
      const refreshing = () => {
        if (refreshingNow) {
          refreshAgain = true;
          return refreshingNow;
        }
        refreshingNow = (async () => {
          do {
            refreshAgain = false;
            await stacks
              .refreshSkills()
              .catch((error) => log.warn(`Bringing skills up to date: ${messageOf(error)}`));
          } while (refreshAgain);
        })().finally(() => {
          refreshingNow = undefined;
        });
        return refreshingNow;
      };
      const holding = (actor?: string) =>
        void (async () => {
          // One that has closed, or isn't back yet, has nothing to reach, and the agent that
          // made it reaches its Work no more until it is back.
          if (actor && !(await hub.actors.get({ actorId: actor })).connected)
            return void (await stacks.reachAgents((reached) => reached === actor));
          // A unit provider that is back may serve newer skills than were copied here.
          if (actor && unitProviders().some((one) => one.actor === actor)) void refreshing();
          // An agent provider that is back holds nothing of what is mounted on its agents.
          giveAll(actor);
          await Promise.all([
            stacks.holdOwns(actor),
            stacks.reachHeld(actor),
            stacks.reachControl(actor),
            stacks.reachSkills(actor),
          ]);
          await stacks.reachAgents(
            (reached, holder) => !actor || reached === actor || holder === actor,
          );
        })().catch((error) => {
          if (!alreadyGone(error)) log.warn(`Reaching what an agent holds: ${messageOf(error)}`);
        });
      ctx.slots.actors.on("changed", ({ actor }) => holding(actor));
      // And all of them once management can make a slot: what the Hub dropped while it was away.
      ctx.slots.grants.onBind(() => holding());
      // An agent provider exposed to it says what its agents hold of themselves: an agent made
      // before its creatable gave one holds it from then on.
      ctx.onExposed(owns);
      // And a unit provider exposed to it may serve newer skills than were copied here.
      ctx.onExposed(() => void refreshing());
      // And an agent provider exposed to it anew, as at management's start, is given its agents'
      // lists.
      let providersNow = new Set<string>();
      ctx.onExposed(() => {
        const now = new Set(agentProviders().map(({ actor }) => actor));
        for (const actor of now) if (!providersNow.has(actor)) giveAll(actor);
        providersNow = now;
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
      /**
       * Those who call management: the person. An agent comes through its control unit instead,
       * except to the methods `open` names, which answer whoever is bound to them.
       */
      const personOnly = <E extends { implement(handlers: never): void }>(
        exported: E,
        name: keyof typeof personHandlers,
        open: string[] = [],
      ) => ({
        implement(handlers: Parameters<E["implement"]>[0]) {
          const held = handlers as Record<string, Handler>;
          personHandlers[name] = held;
          exported.implement(
            Object.fromEntries(
              Object.entries(held).map(([method, handler]) => [
                method,
                async (input: unknown, context: { caller: string }) => {
                  if (
                    !open.includes(method) &&
                    (records.agents[context.caller] || creating.has(context.caller))
                  )
                    throw new Refused(
                      "forbidden",
                      "An agent reaches this through its control unit.",
                    );
                  // The person's own change to an agent is kept in the control log, as control's
                  // are; control's own calls reach these handlers directly, and are logged there.
                  const asked = input as Record<string, unknown>;
                  const tool = name === "agents" ? changeOf(method, asked) : undefined;
                  if (!tool) return handler(input, context);
                  const about = typeof asked.agent === "string" ? asked.agent : undefined;
                  const { caller } = context;
                  try {
                    const output = (await handler(input, context)) as {
                      agent?: unknown;
                      problems?: { message: string }[];
                    };
                    const target =
                      about ?? (typeof output?.agent === "string" ? output.agent : undefined);
                    // A mount whose arguments didn't fit made nothing: it was refused.
                    if (output?.problems)
                      note({
                        caller,
                        tool,
                        outcome: "refused",
                        ...(target ? { target } : {}),
                        reason: output.problems
                          .map((one) => one.message)
                          .join(" ")
                          .slice(0, 2000),
                      });
                    else note({ caller, tool, outcome: "done", ...(target ? { target } : {}) });
                    return output;
                  } catch (error) {
                    note({
                      caller,
                      tool,
                      outcome: "refused",
                      ...(about ? { target: about } : {}),
                      // A provider's refusal may echo what it was given: no secret is kept.
                      reason: secretsIn(input)
                        .filter((secret) => secret.length > 0)
                        .reduce((text, secret) => text.split(secret).join("…"), messageOf(error))
                        .slice(0, 2000),
                    });
                    throw error;
                  }
                },
              ]),
            ) as never,
          );
        },
      });

      ctx.exports.tools.implement({
        list: async (_, { caller }) => ({ tools: await control.list(caller) }),
        call: ({ name, arguments: input }, { caller }) => control.call(caller, name, input),
        // A control call leaves nothing running.
        stop: () => ({}),
      });

      /**
       * A file of a skill exposed to the agent calling, `SKILL.md` if no `path`: refused `unknown`
       * when the skill isn't exposed to it or has no such file.
       */
      const skillFile = (caller: string, name: string, file?: string) => {
        const text =
          agentOf(caller) && settingsOf(caller).skills.includes(name)
            ? library.read(name, file)
            : undefined;
        if (text === undefined)
          throw new Refused("unknown", `No skill ${name} with that file is exposed to you.`);
        return text;
      };

      ctx.exports.settings.implement({
        get: (_, { caller }) => ({ mounted: listOf(caller) }),
        skill: ({ name, path: file }, { caller }) => ({ text: skillFile(caller, name, file) }),
      });

      // Its one tool, listed to an agent while a skill it is told of is exposed to it.
      ctx.exports.skillTools.implement({
        list: (_, { caller }) => ({
          tools:
            agentOf(caller) && settingsOf(caller).skills.some((name) => library.has(name))
              ? [SKILL_TOOL]
              : [],
        }),
        call: ({ name, arguments: input }, { caller }) => {
          if (name !== SKILL_TOOL.name) throw new Refused("unknown", `There is no tool ${name}.`);
          const asked = skillAsked(input);
          return { output: fitted(skillFile(caller, asked.name, asked.path)) };
        },
        // Reading leaves nothing running.
        stop: () => ({}),
      });

      personOnly(ctx.exports.agents, "agents", [
        "get",
        "capabilities",
        "mount",
        "unmount",
      ]).implement({
        capabilities: async () => ({ capabilities: await withControl(await offered()) }),
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
        async addUnit(input, { caller }) {
          const added = await stacks.serial(input.agent, () => stacks.addUnit(input, caller));
          // An agents unit added reaches the agents it may talk to.
          if (input.unit.unit === AGENTS_UNIT)
            await stacks.reachAgents((_, holder) => holder === input.agent);
          return added;
        },
        removeUnit: (input) => stacks.serial(input.agent, () => stacks.removeUnit(input)),
        activity: (input) => activity.read(input),
        async live({ agent, instance, surface, mode }) {
          const record = recordOf(agent);
          const unit = record.units.find((one) => one.instance === instance);
          // A capability mounted through management, by its mount: what its provider made is
          // opened through the provider's `live`, under the id it gave the mount, as a unit's is.
          const mount = record.mounted.find((one) => one.mounted === instance && one.made);
          const made = unit
            ? { provider: unit.provider, instance: unit.providerInstance }
            : mount && { provider: mount.provider, instance: mount.providerMounted };
          if (!made || made.provider === options.actorId)
            throw new Refused("unknown", `${agent} has nothing like that to open live.`);
          const provider = unitProviders().find((one) => one.actor === made.provider);
          if (!provider) throw new Refused("not_connected", "Its provider can't be reached now.");
          return provider.call.live({ instance: made.instance, surface, mode });
        },

        async list() {
          const actors = await open();
          return {
            agents: await Promise.all(
              Object.entries(records.agents).flatMap(([agent, record]) => {
                const actor = actors.get(agent);
                return actor
                  ? [
                      agentStatus(agent, record.provider).then(({ state, detail }) => ({
                        agent,
                        name: actor.name,
                        status: { state, ...(detail ? { detail } : {}) },
                        provider: record.provider,
                        creatable: record.creatable,
                        ...(record.purpose ? { purpose: record.purpose } : {}),
                        ...(record.avatar ? { avatar: record.avatar } : {}),
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
          const { units, tools, instanceOfSkill, instanceOfSlot, capabilities } = await stacks.read(
            agent,
            record,
          );
          const [name, { mounted: held, ...status }, mcp, outside] = await Promise.all([
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
                ...withInstance(instanceOfSlot(b.slot)),
              })),
            ),
            mounts.outside(agent, record),
          ]);
          return {
            agent,
            name,
            status,
            provider: record.provider,
            creatable: record.creatable,
            ...(record.purpose ? { purpose: record.purpose } : {}),
            ...(record.avatar ? { avatar: record.avatar } : {}),
            ...(record.template ? { template: record.template } : {}),
            ...parentOf(record),
            instructions: record.instructions,
            skills: record.skills.flatMap((skill) => {
              const entry = library.entry(skill);
              return entry ? [{ ...entry, ...withInstance(instanceOfSkill(skill)) }] : [];
            }),
            mcp,
            units,
            capabilities,
            mounted: mounts.tree(record, held, outside),
            // Everything it is made of, as the agent says it, while it can be asked.
            ...(held ? { composition: held } : {}),
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
              await changed(input.agent);
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
              await changed(input.agent);
            }
            return {};
          }),
        /** Units and connections go first: if one can't, the agent is still here to be tried again. */
        remove: ({ agent }) => removeWhole(agent),
        mount: (input, { caller }) =>
          mountReaching(input.agent, input.capability, () => mounts.mount(input, caller)),
        unmount: (input) => mounts.unmount(input),
      });

      /**
       * `agents@2`: an agent made empty and what is mounted on it, each call answered the same,
       * whoever calls. What it carries over from `agents@1` is answered by the same handlers.
       */
      const first = personHandlers.agents as Record<
        string,
        (input: unknown, info: { caller: string }) => Promise<unknown>
      >;
      /** The `agents@1` handler of a method, which `agents@2` answers the same. */
      const handlerOf = (method: string) => {
        const handler = first[method];
        if (!handler) throw new Refused("unimplemented", `agents@1 has no ${method}.`);
        return handler;
      };
      const carried = (method: string) => (input: unknown, info: { caller: string }) =>
        handlerOf(method)(input, info) as never;
      const shippedTemplates = options.capabilityTemplates ?? [];
      /** The templates of capabilities: those shipped, each in its place where one is saved under its id. */
      const templateList = () => {
        const saved = records.capabilityTemplates;
        return [
          ...shippedTemplates.map((one) => saved[one.id] ?? { ...one, shipped: true as const }),
          ...Object.values(saved).filter(
            (one) => !shippedTemplates.some(({ id }) => id === one.id),
          ),
        ];
      };
      /** Each provider's name on the Hub, by its id. */
      const namesOf = async (listed: { provider: string }[]) =>
        new Map(
          await Promise.all(
            [...new Set(listed.map(({ provider }) => provider))].map(
              async (actor) => [actor, await nameOf(actor)] as const,
            ),
          ),
        );
      type Json = z.infer<typeof Arguments>[string];
      /**
       * A template as a capability management offers: its arguments have one property for each
       * capability it lists, by key, that capability's own arguments, needing only what the
       * template leaves empty. None while something it lists isn't on offer.
       */
      const asCapability = (
        template: z.infer<typeof Template2>,
        listed: { id: string; provider: string; arguments: Record<string, Json> }[],
        names: Map<string, string>,
      ) => {
        const keys = keysOf(template);
        const properties: Record<string, Json> = {};
        const required: string[] = [];
        for (const [at, one] of template.capabilities.entries()) {
          const defined = listed.find(
            ({ id, provider }) => id === one.capability && names.get(provider) === one.provider,
          );
          if (!defined) return undefined;
          const key = keys[at] as string;
          const needs = (
            Array.isArray(defined.arguments.required) ? defined.arguments.required : []
          )
            .map(String)
            .filter((name) => one.arguments[name] === undefined);
          properties[key] = { ...defined.arguments, required: needs };
          if (needs.length) required.push(key);
        }
        return {
          id: template.id,
          title: template.title,
          description: template.description,
          arguments: { type: "object" as const, properties, required, additionalProperties: false },
          provider: options.actorId,
        };
      };
      ctx.exports.agents2.implement({
        async create({ name, purpose, avatar }, { caller }) {
          // On the agents' executor: what every agent holds, and nothing mounted.
          const [base] = (
            (await handlerOf("creatable")({}, { caller })) as {
              creatables: { provider: string; id: string }[];
            }
          ).creatables;
          if (!base) throw new Refused("not_connected", "No agent provider is connected.");
          return stacks.create(
            {
              stack: { base: { provider: base.provider, creatable: base.id }, units: [] },
              name,
              ...(purpose ? { purpose } : {}),
              ...(avatar ? { avatar } : {}),
            } as never,
            caller,
          );
        },
        remove: ({ agent }) => removeWhole(agent),
        async list(input, info) {
          const { agents: listed } = (await handlerOf("list")(input, info)) as {
            agents: Record<string, unknown>[];
          };
          return {
            agents: listed.map(({ creatable: _, template: __, ...one }) => one) as never,
          };
        },
        async get(input, info) {
          const {
            creatable: _,
            template: __,
            units: ___,
            mounted = [],
            ...rest
          } = (await handlerOf("get")(input, info)) as Record<string, unknown> & {
            mounted?: unknown[];
            composition?: z.infer<typeof HeldCapability>[];
          };
          // Each mounted as a template's names the template's mount.
          const { agent } = input as { agent: string };
          const parents = new Map(
            recordOf(agent).mounted.flatMap(({ mounted: id, parent }) =>
              parent ? [[id, parent] as const] : [],
            ),
          );
          return {
            ...rest,
            mounted: (mounted as { mounted: string }[]).map((one) => {
              const parent = parents.get(one.mounted);
              return parent ? { ...one, parent } : one;
            }),
          } as never;
        },
        async capabilities() {
          const listed = await withControl(await offered());
          const names = await namesOf(listed);
          return {
            capabilities: [
              ...listed,
              ...templateList().flatMap((template) => {
                const offer = asCapability(template, listed, names);
                return offer ? [offer] : [];
              }),
            ],
          };
        },
        mount(input, { caller }) {
          if (input.provider !== options.actorId)
            return mountReaching(input.agent, input.capability, () => mounts.mount(input, caller));
          const template = templateList().find((one) => one.id === input.capability);
          if (!template)
            throw new Refused("unknown", `Management offers no template ${input.capability}.`);
          return mountReaching(input.agent, input.capability, () =>
            mounts.mountTemplate(
              { agent: input.agent, template, arguments: input.arguments },
              caller,
            ),
          );
        },
        unmount: (input) => mounts.unmount(input),
        templates: () => ({ templates: templateList() }),
        async saveTemplate(template) {
          // Never a secret: each it lists is looked up, to tell its secrets apart.
          const listed = await offered();
          const names = await namesOf(listed);
          for (const one of template.capabilities) {
            const defined = listed.find(
              ({ id, provider }) => id === one.capability && names.get(provider) === one.provider,
            );
            if (!defined)
              throw new Refused(
                "not_connected",
                `${one.provider} offers no ${one.capability} now, so its secrets can't be told apart.`,
              );
            const properties = defined.arguments.properties as Record<string, unknown> | undefined;
            const secret = Object.keys(one.arguments).find(
              (name) => (properties?.[name] as { secret?: unknown } | undefined)?.secret === true,
            );
            if (secret)
              throw new Refused(
                "forbidden",
                `A template never keeps a secret: ${one.capability}'s ${secret} is given as it is mounted.`,
              );
          }
          records.capabilityTemplates[template.id] = template;
          save();
          return {};
        },
        removeTemplate({ id }) {
          if (records.capabilityTemplates[id]) {
            delete records.capabilityTemplates[id];
            save();
            return {};
          }
          if (shippedTemplates.some((one) => one.id === id))
            throw new Refused("forbidden", "It came with the app: it can't be removed.");
          throw new Refused("unknown", `There is no template ${id}.`);
        },
        start: carried("start"),
        stop: carried("stop"),
        activity: carried("activity"),
        live: carried("live"),
        models: carried("models"),
        setModel: carried("setModel"),
        expose: carried("expose"),
        unexpose: carried("unexpose"),
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
                // One that builds a capability is for an agent to hold: not a kind to connect.
                if (!slot || unit.capability) return [];
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
          // A connection made for no agent has no agent to hold what the unit builds.
          if (unit.capability)
            throw new Refused(
              "invalid",
              `${unit.title} builds a ${unit.capability.title}, which an agent holds: add it to an agent.`,
            );
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
        add: async (input, { caller }) => {
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
            // An agent's own: no unit's copy any more.
            delete records.copies[added.name];
            records.uncopied = records.uncopied.filter((one) => one !== added.name);
            records.authors.skills[added.name] = agent;
            save();
            return added;
          }
          const added = library.add("path" in input ? readSkillFolder(input.path) : input.files);
          // The person's own: no unit's copy any more, and never brought up to date.
          delete records.copies[added.name];
          records.uncopied = records.uncopied.filter((one) => one !== added.name);
          // Replaced by the person, it's the person's.
          delete records.authors.skills[added.name];
          save();
          await Promise.all(
            Object.entries(records.agents).flatMap(([agent, record]) =>
              record.skills.includes(added.name) ? [changed(agent)] : [],
            ),
          );
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
        remove: async ({ name }, { caller }) => {
          const agent = agentOf(caller);
          if (!library.has(name) || (agent && records.authors.skills[name] !== agent))
            throw new Refused("unknown", `Management has no skill ${name}.`);
          const told = dropSkill(name);
          delete records.authors.skills[name];
          save();
          await told;
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
