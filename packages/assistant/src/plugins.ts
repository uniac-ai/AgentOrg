/**
 * The agent's own plugins: one Cordis root for the executor, and for each agent a context of its
 * own, into which each plugin the agent holds is loaded with that agent's settings. The agent's
 * context has four services, and a plugin names in its `inject` those it uses:
 * - `tools`: functions it gives the model, offered as `<plugin>__<name>`;
 * - `prompt`: sections it adds to what the model is told, each named and ordered;
 * - `store`: its own keys in the agent's durable store;
 * - `agent`: the agent's id.
 * The host says the agent's life to its plugins as Cordis events (`AGENT_EVENTS`), which a plugin
 * hears with `ctx.on`: no plugin can say them through a service.
 * Each service knows which plugin calls it: in a service's method, Cordis gives `this.ctx` as the
 * caller's context, and its fiber is the plugin. What a plugin registers is its own, that agent's
 * alone, and goes when the plugin unloads. Its failures are logged, never the agent's.
 */
import type { kv } from "@agentorg/interfaces";
import type { Part } from "@agentorg/looper";
import type { Log, Slot } from "@agentorg/sdk";
import { Context, type Fiber, type FiberState, Service } from "cordis";
import type { Candidate } from "./tools.js";

type KvStore = Slot<typeof kv>["call"];
/** Cordis's `FiberState.ACTIVE`: a const enum it declares, which this build can't name. */
const ACTIVE = 2 as FiberState;

/**
 * What a plugin hears of the agent's life: one of its pieces of work's turns starting and ending,
 * that work's record before and after it is summarized, the agent going idle with nothing at work,
 * and the agent being stopped, said last, after its turns were cut. `compacted` is said only of a
 * summary that was kept: one that fails or is stopped leaves `compacting` without it.
 */
export type Life = "turnStarted" | "turnEnded" | "compacting" | "compacted" | "idle" | "stopped";

/** What is said with an event of the agent's life: one object, so more can be said later. */
export interface Heard {
  work?: string;
}

/** Each event of the agent's life, by the name a plugin listens for with `ctx.on`. */
export const AGENT_EVENTS = {
  turnStarted: "agent/turn-started",
  turnEnded: "agent/turn-ended",
  compacting: "agent/compacting",
  compacted: "agent/compacted",
  idle: "agent/idle",
  stopped: "agent/stopped",
} as const satisfies Record<Life, string>;

/** A section of what the model is told, as a plugin adds it. */
export interface Section {
  /** Its name, unique among the plugin's sections. */
  name: string;
  /** Read for each request; one that gives nothing adds nothing. Reading it only reads. */
  text: () => string | undefined;
  /** Where it goes among all sections, lowest first; then by plugin and name. 0 if none. */
  order?: number;
  /** The most characters of it kept. */
  max?: number;
}

declare module "cordis" {
  interface Context {
    tools: Tools;
    prompt: Prompt;
    store: Store;
    agent: Agent;
  }
  interface Events {
    "agent/turn-started"(heard: Heard): void;
    "agent/turn-ended"(heard: Heard): void;
    "agent/compacting"(heard: Heard): void;
    "agent/compacted"(heard: Heard): void;
    "agent/idle"(heard: Heard): void;
    "agent/stopped"(heard: Heard): void;
  }
}

/** What the host keeps of one agent's plugins, which its services fill. */
interface Kept {
  agent: string;
  kv: KvStore;
  tools: Map<symbol, Candidate>;
  sections: Map<string, Section & { plugin: string }>;
  /** Each plugin this agent holds, by the fiber it was loaded as, with its name. */
  plugins: Map<Fiber, string>;
  /** The agent's own `agent` service: the sender its life is said with. */
  said?: Agent;
}

/** Where Cordis keeps, on a service as a plugin reaches it, the context it was reached from. */
const CALLER = Symbol.for("cordis.caller");
/**
 * The plugin a service is called by, and the context to tie what it registers to: the one the
 * agent holds that the caller is part of. A plugin's own inner components, and a service a plugin
 * provides, calling it, are that plugin's. Called on the service, as `ctx.store.get(…)`.
 */
function callerOf(kept: Kept, service: object): { name: string; ctx: Context } {
  const reached = service as { [CALLER]?: Context; ctx: Context };
  const ctx = reached[CALLER] ?? reached.ctx;
  for (let fiber = ctx.fiber; ; fiber = fiber.parent.fiber) {
    const name = kept.plugins.get(fiber);
    if (name !== undefined) return { name, ctx };
    if (fiber === fiber.parent.fiber) break;
  }
  throw new Error("Only a plugin the agent holds may use its services.");
}

/** Functions plugins give the model, each offered as `<plugin>__<name>`. */
export class Tools extends Service {
  private kept: Kept;
  constructor(ctx: Context, kept: Kept) {
    super(ctx, "tools");
    this.kept = kept;
  }
  /**
   * Give the model a function until the plugin unloads, or until the function it gives is called.
   * A turn keeps the functions it was offered: a call that comes after is answered that the
   * function is no longer held, and nothing of the plugin runs.
   */
  register(tool: Omit<Candidate, "slot">): () => void {
    const { name: slot, ctx } = callerOf(this.kept, this);
    let held = true;
    const run: Candidate["run"] = async (input, group) =>
      held
        ? tool.run(input, group)
        : { output: `The function ${slot}__${tool.name} is no longer held.`, ok: false };
    const gone = ctx.effect(() => {
      const key = Symbol(tool.name);
      this.kept.tools.set(key, { ...tool, slot, run });
      return () => {
        held = false;
        this.kept.tools.delete(key);
      };
    });
    return () => void gone();
  }
}

/** What plugins add to what the model is told. */
export class Prompt extends Service {
  private kept: Kept;
  constructor(ctx: Context, kept: Kept) {
    super(ctx, "prompt");
    this.kept = kept;
  }
  /**
   * Add a section to every request until the plugin unloads, or until the function it gives is
   * called. A worker is told sections after the agent's own words and its skills; the front desk,
   * after who it speaks as. A second of the same name from the same plugin is refused.
   */
  section(section: Section): () => void {
    const { name: plugin, ctx } = callerOf(this.kept, this);
    const key = `${plugin}/${section.name}`;
    if (this.kept.sections.has(key))
      throw new Error(`The plugin ${plugin} has a section named ${section.name} already.`);
    const gone = ctx.effect(() => {
      this.kept.sections.set(key, { ...section, plugin });
      return () => void this.kept.sections.delete(key);
    });
    return () => void gone();
  }
}

/** Where a plugin's own keys live in the agent's store. */
const STORE = "plugin";
/**
 * Durable keeping: each plugin's own keys in the agent's store, under `plugin/<name>/`. A plugin
 * unloading leaves them.
 * Each method is called on the service, as `ctx.store.get(…)`: that is how Cordis names its caller.
 */
export class Store extends Service implements KvStore {
  private kept: Kept;
  constructor(ctx: Context, kept: Kept) {
    super(ctx, "store");
    this.kept = kept;
  }
  // Methods, not arrow functions: Cordis gives each call `this.ctx` as the calling plugin's.
  private prefix() {
    return `${STORE}/${callerOf(this.kept, this).name}/`;
  }
  get({ key }: Parameters<KvStore["get"]>[0]) {
    return this.kept.kv.get({ key: `${this.prefix()}${key}` });
  }
  set({ key, value }: Parameters<KvStore["set"]>[0]) {
    return this.kept.kv.set({ key: `${this.prefix()}${key}`, value });
  }
  delete({ key }: Parameters<KvStore["delete"]>[0]) {
    return this.kept.kv.delete({ key: `${this.prefix()}${key}` });
  }
  async list({ prefix: under = "", after, limit }: Parameters<KvStore["list"]>[0]) {
    const prefix = this.prefix();
    const { keys, next } = await this.kept.kv.list({
      prefix: `${prefix}${under}`,
      ...(after === undefined ? {} : { after: `${prefix}${after}` }),
      ...(limit === undefined ? {} : { limit }),
    });
    const mine = (key: string) => key.slice(prefix.length);
    return { keys: keys.map(mine), next: next === null ? null : mine(next) };
  }
}

/** The agent itself, as its plugins reach it: its id. */
export class Agent extends Service {
  private kept: Kept;
  constructor(ctx: Context, kept: Kept) {
    super(ctx, "agent");
    this.kept = kept;
    kept.said = this;
  }
  /** The agent's id. */
  get id() {
    return this.kept.agent;
  }
}

/**
 * A plugin's part inside an agent: a Cordis component that names in `inject` the services it uses,
 * and may use services the same agent's other plugins provide. What it provides, named in
 * `provide`, is that agent's alone: another agent holding the same plugin has its own.
 */
export interface AgentPlugin<C = unknown> {
  name: string;
  inject: string[];
  provide?: string | string[];
  apply(ctx: Context, config: C): unknown;
}

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
  /** The functions they give the model now. */
  tools(): Candidate[];
  /** The sections they add to a request now, in order, each read afresh. */
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
}

/** An agent with no plugins: nothing given, nothing heard. */
export const NO_PLUGINS: AgentPlugins = {
  tools: () => [],
  blocks: () => [],
  life: () => {},
  hold: async () => ({ tools: [], blocks: [], without: [] }),
  close: async () => {},
};

/**
 * A plugin as an agent holds it: what Cordis gave when it was asked to load, the settings it was
 * asked with, and the fiber it runs as, once it has begun to.
 */
interface Loaded {
  loading: Fiber & PromiseLike<Fiber>;
  settings: string;
  fiber?: Fiber;
}

/** The services every agent's context has, by the names they are provided under. */
const SERVICES = { tools: Tools, prompt: Prompt, store: Store, agent: Agent };
/** By order, then plugin, then name: the same at every start. */
const inOrder = (a: Section & { plugin: string }, b: Section & { plugin: string }) =>
  (a.order ?? 0) - (b.order ?? 0) ||
  a.plugin.localeCompare(b.plugin) ||
  a.name.localeCompare(b.name);

/**
 * The executor's plugin host: one Cordis root, the plugins it carries, by name, and a context of
 * its own for each agent.
 */
// biome-ignore lint/suspicious/noExplicitAny: each plugin's settings are its own.
export function createPluginHost(log: Log, carried: AgentPlugin<any>[] = []) {
  const root = new Context();
  const byName = new Map(carried.map((plugin) => [plugin.name, plugin]));
  // What an agent's context keeps to itself: its four services, and every service a plugin it may
  // come to hold provides, each isolated under a label of its own (Cordis keeps a service by its
  // label), so its plugins share them and no other agent sees them.
  const provided = new Set([
    ...Object.keys(SERVICES),
    ...carried.flatMap((plugin) => [plugin.provide ?? []].flat()),
  ]);
  return {
    /** Give `agent` a context of its own, with its four services: it holds no plugin until told. */
    async open(agent: string, options: { store: KvStore }): Promise<AgentPlugins> {
      const kept: Kept = {
        agent,
        kv: options.store,
        tools: new Map(),
        sections: new Map(),
        plugins: new Map(),
      };
      // Each plugin as the host loads it: what it is, and the fiber it runs as, named as the agent
      // holds it, so its services know it, and its own components, as that plugin.
      const asHeld = (plugin: AgentPlugin, one: Loaded) => ({
        name: plugin.name,
        inject: plugin.inject,
        ...(plugin.provide === undefined ? {} : { provide: plugin.provide }),
        apply(ctx: Context, config: unknown) {
          one.fiber = ctx.fiber;
          kept.plugins.set(ctx.fiber, plugin.name);
          return plugin.apply(ctx, config);
        },
      });
      let own: Context = root;
      for (const name of provided) own = own.isolate(name);
      const services: Fiber[] = [];
      for (const service of Object.values(SERVICES)) {
        const fiber = own.use(service, kept);
        services.push(fiber);
        await fiber;
      }
      /** Each plugin it holds, by name. */
      const held = new Map<string, Loaded>();
      const unload = async (name: string) => {
        const one = held.get(name);
        if (!one) return;
        held.delete(name);
        await one.loading.dispose();
        if (one.fiber) kept.plugins.delete(one.fiber);
      };
      // None is judged until all have settled: one that waits for another's service loads once
      // that one has, whatever the order they were named in, and loads again when that one is
      // loaded again.
      const settle = async () => {
        for (let moving = true; moving; ) {
          moving = false;
          for (const { loading } of held.values()) {
            if (!loading.inertia) continue;
            moving = true;
            await loading.inertia.catch(() => {});
          }
        }
      };
      /** What it couldn't hold of `named`, each with why; it holds all the rest. */
      const hold = async (named: Named[]): Promise<Without[]> => {
        const without = new Map<string, Without>();
        for (const { name } of named)
          if (!byName.has(name)) without.set(name, { name, why: "not carried" });
        const wanted = new Map(
          named
            .filter(({ name }) => byName.has(name))
            .map(({ name, settings }) => [name, { key: JSON.stringify(settings ?? {}), settings }]),
        );
        for (const [name, { settings }] of [...held])
          if (wanted.get(name)?.key !== settings) await unload(name);
        for (const [name, { key, settings }] of wanted) {
          if (held.has(name)) continue;
          const one = { settings: key } as Loaded;
          one.loading = own.use(asHeld(byName.get(name) as AgentPlugin, one), settings);
          held.set(name, one);
        }
        await settle();
        // One that failed is unloaded; then one left waiting for a service, which may be one that
        // failed, never loads, and is unloaded too.
        for (const [name, { loading }] of [...held]) {
          const failed = await loading.then(
            () => undefined,
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          );
          if (failed === undefined) continue;
          without.set(name, { name, why: "didn't load", said: failed });
          await unload(name);
        }
        await settle();
        for (const [name, { loading }] of [...held]) {
          if (loading.state === ACTIVE) continue;
          without.set(name, { name, why: "needs a service" });
          await unload(name);
        }
        return named.flatMap(({ name }) => without.get(name) ?? []);
      };
      const tools = () => [...kept.tools.values()];
      const blocks = () =>
        [...kept.sections.values()].sort(inOrder).flatMap(({ plugin, name, text, max }) => {
          const owner = `plugin:${plugin}/${name}`;
          let words: string | undefined;
          try {
            words = text();
          } catch (error) {
            log.warn("A plugin's section couldn't be read; the request goes without it.", {
              agent,
              owner,
              error: String(error),
            });
          }
          return words ? [{ owner, text: words, ...(max === undefined ? {} : { max }) }] : [];
        });
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
        // The host says the agent's life, with the agent's own `agent` service as the sender, so
        // only the plugins in its context hear it. Each listener is called and none is awaited;
        // each that fails is logged. They are given one object, which none can change under the
        // next.
        life(event, heard = {}) {
          if (!kept.said) return;
          const failed = (error: unknown) =>
            log.warn("A plugin failed on the agent's life.", {
              agent,
              event,
              error: String(error),
            });
          own
            .parallel(kept.said, AGENT_EVENTS[event], Object.freeze({ ...heard }))
            .catch((error: unknown) =>
              error instanceof AggregateError ? error.errors.forEach(failed) : failed(error),
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
            for (const name of [...held.keys()].reverse()) await unload(name);
            await Promise.all(services.reverse().map((fiber) => fiber.dispose()));
            kept.tools.clear();
            kept.sections.clear();
            kept.plugins.clear();
            delete kept.said;
          }),
      };
    },
  };
}
