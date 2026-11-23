/**
 * The agent's own capabilities: one Cordis root for the executor, and for each agent a context of
 * its own, with the three primitives (`capabilities`, `context`, `record`; see `substrate.ts`) and
 * the bundled capabilities on them (`agent`, `store`, `tools`, `prompt`; see `bundled.ts`). Into it
 * each capability the agent's settings name is mounted, of those the host carries, with its
 * settings; a capability may mount others as its children.
 * The host says the agent's life through `record` as Cordis events (`AGENT_EVENTS`), which a
 * capability hears with `ctx.on`: none can say them itself. A capability's failures are logged,
 * never the agent's.
 */
import type { Part } from "@agentorg/looper";
import type { Log } from "@agentorg/sdk";
import { Context, type Fiber, type FiberState } from "cordis";
import { bundled, type KvStore } from "./bundled.js";
import {
  AGENT_EVENTS,
  AgentRecord,
  Capabilities,
  type Capability,
  type Heard,
  type Held,
  type Host,
  isPlugin,
  type Life,
  type Loop,
  type Pass,
  Passes,
  pluginName,
  type Request,
  type Turn,
} from "./substrate.js";
import { type Candidate, offeredName } from "./tools.js";

export { Agent, type Section } from "./bundled.js";
export {
  AGENT_EVENTS,
  type Capability,
  type Heard,
  type Held,
  type Life,
  type Loop,
  type Pass,
  type Request,
  type Turn,
} from "./substrate.js";

/** Cordis's `FiberState.ACTIVE`: a const enum it declares, which this build can't name. */
const ACTIVE = 2 as FiberState;
/**
 * A plugin part's state, by its fiber's: Cordis's pending (waiting for a service it needs),
 * loading, active and failed. One unloading or disposed is going, and isn't said.
 */
const PLUGIN_STATES = new Map<FiberState, Pick<Held, "state" | "detail">>([
  [0 as FiberState, { state: "down", detail: "It waits for a service it needs." }],
  [1 as FiberState, { state: "down", detail: "It is loading." }],
  [ACTIVE, { state: "mounted" }],
  [3 as FiberState, { state: "failed", detail: "It couldn't be loaded." }],
]);
/** The most functions, and sections, a part's `added` lists: what the contract takes. */
const ADDED_FUNCTIONS = 128;
const ADDED_SECTIONS = 64;
const ADDED_NAME = 64;

/** A plugin, as an agent's settings name it: a capability its executor carries. */
export type AgentPlugin<C = unknown> = Capability<C>;

/** A plugin an agent holds, as its settings name it: one the host carries, with its settings. */
export interface Named {
  name: string;
  settings?: Record<string, unknown>;
}

/**
 * A plugin an agent's settings name that it runs without now, and why: its host doesn't carry it,
 * it didn't load (`said` is what it said), or it needs a service none of the agent's plugins
 * provides. Whoever tells of it words it for their own reader.
 */
export interface Without {
  name: string;
  why: "not carried" | "didn't load" | "needs a service";
  said?: string;
}

/**
 * What an agent's plugins give a turn: their functions, and their sections in order; and those its
 * settings name that it runs without, each with why, in the order named.
 */
export interface Given {
  tools: Candidate[];
  blocks: Part[];
  without: Without[];
}

/** An agent's plugins, as its engine reads them. */
export interface AgentPlugins {
  /** The functions they give the model through `tools` now. */
  tools(): Candidate[];
  /** The sections they add through `prompt` now, in order, each read afresh. */
  blocks(): Part[];
  /** Tell them of the agent's life. */
  life(event: Life, heard?: Heard): void;
  /**
   * Hold the plugins named, all it can of them: one newly named is loaded, one no longer named is
   * unloaded, one named with other settings is loaded again with them, and the rest stay as they
   * are loaded. One it can't hold, it runs without, and says why: a name the host doesn't carry; a
   * plugin that doesn't load, or that needs a service none it holds provides, each then unloaded.
   * Each is tried again when next it is held. It gives what they then give, read before any later
   * change begins.
   */
  hold(named: Named[]): Promise<Given>;
  /** Unload them all: what each registered goes with it. */
  close(): Promise<void>;
  /** Pass a request through every capability's passes, in their order. */
  pass(request: Request): Request;
  /** Read, once a turn before its requests, what each capability's passes give. */
  turn(loop?: Loop): Promise<void>;
  /** A service its capabilities provide now, by name, for its host's own use. */
  service?(name: string): unknown;
  /** The functions its latest request offered, by name: what each part's `added` lists of its own. */
  offered?(names: string[]): void;
}

/** An agent's own context, as its executor holds it: what its engine reads, and more. */
export interface AgentContext extends AgentPlugins {
  /** What the agent holds now, in the order it was mounted, each with its state. */
  list(): Held[];
  /**
   * Mount a capability of the executor's own, as the bundled ones are: no settings name it, and
   * holding what they name leaves it. It settles once it is mounted, or rejects with why, and the
   * agent runs without it.
   */
  mount(capability: Capability, args?: unknown): Promise<void>;
}

/** An agent with no plugins: nothing given, nothing heard. */
export const NO_PLUGINS: AgentPlugins = {
  tools: () => [],
  blocks: () => [],
  life: () => {},
  hold: async () => ({ tools: [], blocks: [], without: [] }),
  close: async () => {},
  pass: (request) => request,
  turn: async () => {},
};

/** One capability as the agent holds it, from when it is asked to mount until it goes. */
interface Entry {
  capability: Capability;
  title: string;
  /** Mounted by the host for every agent, from the agent's settings, or by another capability. */
  kind: "bundled" | "named" | "child";
  parent?: string;
  /** Its settings as named, to tell a change. */
  key: string;
  loading: Fiber & PromiseLike<Fiber>;
  fiber?: Fiber;
  ctx?: Context;
  controller: AbortController;
  /** What it says of itself now, once it has. */
  said?: { state: "mounted" | "down"; detail?: string };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The executor's capability host: one Cordis root, the plugins it carries, by name, and a context
 * of its own for each agent.
 */
// biome-ignore lint/suspicious/noExplicitAny: each plugin's settings are its own.
export function createPluginHost(log: Log, carried: AgentPlugin<any>[] = []) {
  const root = new Context();
  const byName = new Map(carried.map((plugin) => [plugin.name, plugin]));
  return {
    /**
     * Give `agent` a context of its own, with the primitives and the bundled capabilities.
     * `provides` names the services the executor's own capabilities may provide, which the
     * agent's context keeps to itself as it does the bundled ones'.
     */
    async open(
      agent: string,
      options: { store: KvStore; provides?: string[] },
    ): Promise<AgentContext> {
      const fibers: Host["fibers"] = new Map();
      /** Each capability by name, in the order they were mounted. */
      const entries = new Map<string, Entry>();
      /** Each that couldn't be mounted, and why, until it is tried again. */
      const failed = new Map<string, Held & { from: Entry["kind"] }>();
      const passes: { owner: string; pass: Pass; order: number }[] = [];
      /** What each part added to the latest request, by its name. */
      let added = new Map<string, { functions: string[]; sections: string[] }>();
      /** The functions the latest request offered, once there was one. */
      let offeredNow: Set<string> | undefined;
      const turns: { owner: string; turn: Turn }[] = [];
      /** The plugins its settings named last, in the order they named them. */
      let namedOrder: string[] = [];
      const made = bundled({ agent, kv: options.store, fibers, log });

      /** Everything under `name`, deepest first. */
      const under = (name: string): string[] =>
        [...entries.values()]
          .filter((one) => one.parent === name)
          .flatMap((one) => [...under(one.capability.name), one.capability.name]);
      /**
       * A capability as Cordis loads it: named as the agent holds it, with its own signal. Cordis
       * applies it again when a service it needs comes back, having disposed what it mounted: each
       * apply has a signal of its own, and mounts its children afresh.
       */
      const asHeld = (capability: Capability, entry: Entry) => ({
        name: capability.name,
        inject: capability.inject,
        ...(capability.provide === undefined ? {} : { provide: capability.provide }),
        apply(ctx: Context, args: unknown) {
          for (const one of under(capability.name)) {
            const held = entries.get(one);
            entries.delete(one);
            if (held?.fiber) fibers.delete(held.fiber);
          }
          if (entry.fiber) fibers.delete(entry.fiber);
          entry.fiber = ctx.fiber;
          entry.ctx = ctx;
          fibers.set(ctx.fiber, capability.name);
          const controller = new AbortController();
          entry.controller = controller;
          ctx.effect(() => () => controller.abort());
          return capability.apply(ctx, args);
        },
      });
      const start = (
        at: Context,
        capability: Capability,
        args: unknown,
        kind: Entry["kind"],
        parent?: string,
      ) => {
        const entry = {
          capability,
          title: capability.title ?? capability.name,
          kind,
          ...(parent === undefined ? {} : { parent }),
          key: JSON.stringify(args ?? {}),
          controller: new AbortController(),
        } as Entry;
        entry.loading = at.use(asHeld(capability, entry), args);
        failed.delete(capability.name);
        entries.set(capability.name, entry);
        return entry;
      };
      /**
       * Take one off, with all it mounted: with `taken`, each one's `unmount` first, deepest first;
       * not when the agent closes.
       */
      const drop = async (name: string, taken: boolean) => {
        const entry = entries.get(name);
        if (!entry) return;
        const all = [...under(name), name];
        if (taken)
          for (const one of all) {
            const held = entries.get(one);
            if (!held?.ctx || !held.capability.unmount) continue;
            try {
              await held.capability.unmount(held.ctx);
            } catch (error) {
              log.warn("A capability failed as it was taken off.", {
                agent,
                capability: one,
                error: messageOf(error),
              });
            }
          }
        await entry.loading.dispose();
        for (const one of all) {
          const held = entries.get(one);
          entries.delete(one);
          if (held?.fiber) fibers.delete(held.fiber);
          for (const [key, value] of failed) if (value.parent === one) failed.delete(key);
        }
      };
      // None is judged until all have settled: one that waits for another's service loads once
      // that one has, whatever the order they were asked in, and loads again when that one is.
      const settle = async () => {
        for (let moving = true; moving; ) {
          moving = false;
          for (const { loading } of entries.values()) {
            if (!loading.inertia) continue;
            moving = true;
            await loading.inertia.catch(() => {});
          }
        }
      };
      /** Why it isn't mounted, if it isn't: what it said, or that a service it needs isn't there. */
      const fault = async (entry: Entry) => {
        const said = await entry.loading.then(
          () => undefined,
          (error: unknown) => messageOf(error),
        );
        if (said !== undefined) return { why: "didn't load" as const, said };
        if (entry.loading.state !== ACTIVE) return { why: "needs a service" as const };
        return undefined;
      };
      const failing = (entry: Entry, detail: string) =>
        failed.set(entry.capability.name, {
          name: entry.capability.name,
          title: entry.title,
          state: "failed",
          detail,
          from: entry.kind,
          ...(entry.parent === undefined ? {} : { parent: entry.parent }),
        });
      const NEEDS = "It needs a service none of the agent's capabilities provides.";

      // What an agent's context keeps to itself: the primitives, the bundled capabilities, and
      // every service a plugin it may come to hold provides, each isolated under a label of its own
      // (Cordis keeps a service by its label), so its capabilities share them and no other agent
      // sees them. A child a capability mounts provides only among these.
      const kept = new Set([
        "capabilities",
        "context",
        "record",
        ...made.provides,
        ...(options.provides ?? []),
        ...carried.flatMap((plugin) => [plugin.provide ?? []].flat()),
      ]);
      let own: Context = root;
      for (const name of kept) own = own.isolate(name);

      const host: Host = {
        fibers,
        /**
         * A child is judged once it has settled. One that waits for a service while its parent is
         * still mounting may be waiting for what its parent offers, which is there once the
         * parent's mount ends: it is judged then, with the rest, and the list says how it went.
         */
        async mount(parent, ctx, capability, args) {
          const { name } = capability;
          if (entries.has(name)) throw new Error(`The agent holds ${name} already.`);
          const alone = [capability.provide ?? []].flat().find((one) => !kept.has(one));
          if (alone)
            throw new Error(`${name} provides ${alone}, which its agent can't keep to itself.`);
          const entry = start(ctx, capability, args, "child", parent);
          while (entry.loading.inertia) await entry.loading.inertia.catch(() => {});
          const why = await fault(entry);
          if (!why) return;
          if (why.why === "needs a service" && entries.get(parent)?.loading.state !== ACTIVE)
            return;
          await drop(name, false);
          const detail = why.why === "didn't load" ? why.said : NEEDS;
          failing(entry, detail);
          throw new Error(detail);
        },
        unmount: (name) => drop(name, true),
        list: () => {
          const loaded = pluginsOf();
          return [
            ...[...entries.values()]
              .filter((one) => one.loading.state === ACTIVE)
              .flatMap(({ capability, title, parent, said, fiber }): Held[] => [
                {
                  name: capability.name,
                  title,
                  state: said?.state ?? ("mounted" as const),
                  ...(said?.detail ? { detail: said.detail } : {}),
                  ...(parent === undefined ? {} : { parent }),
                  ...addedBy(capability.name),
                },
                ...((fiber && loaded.get(fiber)) ?? []).flatMap((plugin): Held[] => {
                  const state = PLUGIN_STATES.get(plugin.state);
                  if (!state) return [];
                  const name = pluginName(plugin);
                  return [
                    {
                      name,
                      title: plugin.runtime?.name ?? name,
                      ...state,
                      parent: capability.name,
                      kind: "plugin",
                      ...addedBy(name),
                    },
                  ];
                }),
              ]),
            ...[...failed.values()].map(({ from: _, ...held }) => held),
          ];
        },
        signal(name) {
          const entry = entries.get(name);
          if (!entry) throw new Error(`The agent holds no ${name}.`);
          return entry.controller.signal;
        },
        say(name, state, detail) {
          const entry = entries.get(name);
          if (entry) entry.said = { state, ...(detail ? { detail } : {}) };
        },
        pass(owner, ctx, pass, order) {
          const one = { owner, pass, order };
          const gone = ctx.effect(() => {
            passes.push(one);
            return () => void passes.splice(passes.indexOf(one), 1);
          });
          return () => void gone();
        },
        turn(owner, ctx, turn) {
          const one = { owner, turn };
          const gone = ctx.effect(() => {
            turns.push(one);
            return () => void turns.splice(turns.indexOf(one), 1);
          });
          return () => void gone();
        },
      };

      const services: Fiber[] = [];
      const record = own.use(AgentRecord);
      for (const fiber of [own.use(Capabilities, host), own.use(Passes, host), record]) {
        services.push(fiber);
        await fiber;
      }
      /** The agent's own `record` service: the sender its life is said with. */
      let said: AgentRecord | undefined = own.get("record") as AgentRecord;

      for (const capability of made.capabilities) start(own, capability, undefined, "bundled");
      await settle();
      for (const entry of entries.values()) {
        const why = await fault(entry);
        if (why) throw new Error(`The agent's ${entry.capability.name} didn't mount.`);
      }

      /**
       * The order the agent holds its capabilities in: those every agent has, in the order they
       * were mounted, then those its settings name, in the order they name them, each followed by
       * what it mounted. One loaded again with other settings keeps its place.
       */
      const holding = () => {
        const top = [...entries.values()].filter((one) => one.parent === undefined);
        const named = (one: Entry) =>
          one.kind === "named" ? namedOrder.indexOf(one.capability.name) : -1;
        const tops = [
          ...top.filter((one) => one.kind !== "named"),
          ...top.filter((one) => one.kind === "named").sort((a, b) => named(a) - named(b)),
        ];
        const below = (name: string): string[] =>
          [...entries.values()]
            .filter((one) => one.parent === name)
            .flatMap((one) => [one.capability.name, ...below(one.capability.name)]);
        return tops.flatMap((one) => [one.capability.name, ...below(one.capability.name)]);
      };
      /** Each request through every pass: by its order, then the order the agent holds them in. */
      const run = (request: Request): Request => {
        const order = holding();
        const ordered = [...passes].sort(
          (a, b) => a.order - b.order || order.indexOf(a.owner) - order.indexOf(b.owner),
        );
        // What each part added, by what gave it: the part that registered it through `tools` or
        // `prompt`, else the capability whose pass added it.
        const now = new Map<string, { functions: string[]; sections: string[] }>();
        const into = (part: string) => {
          const one = now.get(part) ?? { functions: [], sections: [] };
          now.set(part, one);
          return one;
        };
        for (const { owner, pass } of ordered) {
          const [functions, told] = [request.functions.length, request.instructions.length];
          try {
            pass(request);
          } catch (error) {
            log.warn("A capability's pass failed; the request goes on without what it did.", {
              agent,
              capability: owner,
              error: messageOf(error),
            });
          }
          for (const fn of request.functions.slice(functions))
            into(made.partOf(fn) ?? owner).functions.push(offeredName(fn.slot, fn.name));
          for (const part of request.instructions.slice(told))
            into(made.partOf(part) ?? owner).sections.push(made.sectionOf(part) ?? part.owner);
        }
        added = now;
        return request;
      };
      /** What a part added to the latest request, of what that request offered; none before one. */
      const addedBy = (part: string): Pick<Held, "added"> => {
        if (!offeredNow) return {};
        const offered = offeredNow;
        const one = added.get(part);
        const names = (list: string[]) => [
          ...new Set(list.map((name) => name.slice(0, ADDED_NAME))),
        ];
        return {
          added: {
            functions: names((one?.functions ?? []).filter((name) => offered.has(name))).slice(
              0,
              ADDED_FUNCTIONS,
            ),
            sections: names(one?.sections ?? []).slice(0, ADDED_SECTIONS),
          },
        };
      };
      /**
       * The plugins each of the agent's capabilities loaded, under the capability's fiber, in the
       * order Cordis numbered them. One under another plugin is part of that one, and isn't here.
       */
      const pluginsOf = () => {
        const loaded = new Map<Fiber, Fiber[]>();
        for (const runtime of root.registry.values())
          for (const fiber of runtime.fibers) {
            if (!isPlugin(fibers, fiber)) continue;
            for (let up = fiber.parent.fiber; ; up = up.parent.fiber) {
              if (fibers.has(up)) {
                loaded.set(up, [...(loaded.get(up) ?? []), fiber]);
                break;
              }
              if (isPlugin(fibers, up) || up === up.parent.fiber) break;
            }
          }
        for (const list of loaded.values()) list.sort((a, b) => (a.uid ?? 0) - (b.uid ?? 0));
        return loaded;
      };
      /** What every capability reads once a turn, one after another, in the order they hold. */
      const turn = async (loop?: Loop) => {
        const order = holding();
        const ordered = [...turns].sort((a, b) => order.indexOf(a.owner) - order.indexOf(b.owner));
        for (const { owner, turn: read } of ordered)
          try {
            await read(loop);
          } catch (error) {
            log.warn("A capability couldn't read what its passes give; the turn goes on.", {
              agent,
              capability: owner,
              error: messageOf(error),
            });
          }
      };
      const tools = made.registered;
      const blocks = made.sections;

      /** What it couldn't hold of `named`, each with why; it holds all the rest. */
      const hold = async (named: Named[]): Promise<Without[]> => {
        namedOrder = named.map(({ name }) => name);
        const without = new Map<string, Without>();
        for (const [name, held] of failed) if (held.from === "named") failed.delete(name);
        for (const { name } of named)
          if (!byName.has(name)) {
            without.set(name, { name, why: "not carried" });
            failed.set(name, {
              name,
              title: name,
              state: "failed",
              detail: "Its executor doesn't carry it.",
              from: "named",
            });
          }
        const wanted = new Map(
          named
            .filter(({ name }) => byName.has(name))
            .map(({ name, settings }) => [name, { key: JSON.stringify(settings ?? {}), settings }]),
        );
        for (const entry of [...entries.values()])
          if (entry.kind === "named" && wanted.get(entry.capability.name)?.key !== entry.key)
            await drop(entry.capability.name, true);
        for (const [name, { settings }] of wanted) {
          if (entries.has(name)) continue;
          start(own, byName.get(name) as AgentPlugin, settings, "named");
        }
        await settle();
        // One that failed is unloaded; then one left waiting for a service, which may be one that
        // failed, never loads, and is unloaded too.
        for (const entry of [...entries.values()]) {
          if (entry.kind !== "named") continue;
          const why = await fault(entry);
          if (why?.why !== "didn't load") continue;
          without.set(entry.capability.name, { name: entry.capability.name, ...why });
          await drop(entry.capability.name, false);
          failing(entry, why.said);
        }
        await settle();
        for (const entry of [...entries.values()]) {
          if (entry.kind !== "named" || entry.loading.state === ACTIVE) continue;
          without.set(entry.capability.name, {
            name: entry.capability.name,
            why: "needs a service",
          });
          await drop(entry.capability.name, false);
          failing(entry, NEEDS);
        }
        // A child mounted in its parent's mount, judged now that its parent's mount has ended.
        for (const entry of [...entries.values()]) {
          if (entry.kind !== "child" || !entries.has(entry.capability.name)) continue;
          const why = await fault(entry);
          if (!why) continue;
          await drop(entry.capability.name, false);
          failing(entry, why.why === "didn't load" ? why.said : NEEDS);
        }
        return named.flatMap(({ name }) => without.get(name) ?? []);
      };

      /** One change at a time, in the order they were asked; none once it is closed. */
      let closed = false;
      let changing: Promise<unknown> = Promise.resolve();
      const inTurn = <T>(change: () => Promise<T>) => {
        const done = changing.then(change);
        changing = done.catch(() => {});
        return done;
      };
      return {
        tools,
        blocks,
        list: host.list,
        pass: run,
        turn,
        service: (name) => own.get(name),
        offered: (names) => {
          offeredNow = new Set(names);
        },
        mount: (capability, args) =>
          inTurn(async () => {
            const { name } = capability;
            if (closed) throw new Error("The agent is closed.");
            if (entries.has(name)) throw new Error(`The agent holds ${name} already.`);
            const entry = start(own, capability, args, "bundled");
            await settle();
            const why = await fault(entry);
            if (!why) return;
            await drop(name, false);
            const detail = why.why === "didn't load" ? why.said : NEEDS;
            failing(entry, detail);
            throw new Error(detail);
          }),
        // The host says the agent's life, with the agent's own `record` service as the sender, so
        // only the capabilities in its context hear it. Each listener is called and none is
        // awaited; each that fails is logged. They are given one object, which none can change
        // under the next.
        life(event, heard = {}) {
          if (!said) return;
          const failedOn = (error: unknown) =>
            log.warn("A plugin failed on the agent's life.", {
              agent,
              event,
              error: String(error),
            });
          own
            .parallel(said, AGENT_EVENTS[event], Object.freeze({ ...heard }))
            .catch((error: unknown) =>
              error instanceof AggregateError ? error.errors.forEach(failedOn) : failedOn(error),
            );
        },
        hold: (named) =>
          inTurn(async () => {
            const without = closed ? [] : await hold(named);
            return { tools: tools(), blocks: blocks(), without };
          }),
        close: () =>
          inTurn(async () => {
            closed = true;
            for (const name of [...entries.keys()].reverse())
              if (!entries.get(name)?.parent) await drop(name, false);
            await Promise.all(services.reverse().map((fiber) => fiber.dispose()));
            entries.clear();
            failed.clear();
            fibers.clear();
            said = undefined;
          }),
      };
    },
  };
}
