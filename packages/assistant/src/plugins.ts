/**
 * The agent's own plugins: one Cordis root for the executor, and for each agent a context of its
 * own, into which each plugin the agent holds is loaded with that agent's settings. The agent's
 * context has four services, and a plugin names in its `inject` those it uses:
 * - `tools`: functions it gives the model, offered as `<plugin>__<name>`;
 * - `prompt`: sections it adds to what the model is told, each named and ordered;
 * - `store`: its own keys in the agent's durable store;
 * - `agent`: the agent's id, and its life, said as Cordis events (`AgentEvents`).
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
  /** The agent's own `agent` service, which says its life. */
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
  /** Give the model a function until the plugin unloads, or until the function it gives is called. */
  register(tool: Omit<Candidate, "slot">): () => void {
    const { name: slot, ctx } = callerOf(this.kept, this);
    const gone = ctx.effect(() => {
      const key = Symbol(tool.name);
      this.kept.tools.set(key, { ...tool, slot });
      return () => void this.kept.tools.delete(key);
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

/** The agent itself: its id, and its life, said to its own plugins only. */
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
  /**
   * Tell the agent's plugins of its life. Each listener is called; none is awaited; what fails is
   * given to `failed`. Said with this service as its sender, so only the plugins in its agent's
   * context hear it.
   */
  say(event: Life, heard: Heard, failed: (error: unknown) => void) {
    // One object, which no listener can change under the next.
    this.ctx
      .parallel(this, AGENT_EVENTS[event], Object.freeze({ ...heard }))
      .catch((error: unknown) =>
        error instanceof AggregateError ? error.errors.forEach(failed) : failed(error),
      );
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

/** A plugin an agent holds, with its settings. */
export interface Held {
  // biome-ignore lint/suspicious/noExplicitAny: each plugin's settings are its own.
  plugin: AgentPlugin<any>;
  config?: unknown;
}

/** An agent's plugins, as its engine reads them. */
export interface AgentPlugins {
  /** The functions they give the model now. */
  tools(): Candidate[];
  /** The sections they add to a request now, in order, each read afresh. */
  blocks(): Part[];
  /** Tell them of the agent's life. */
  life(event: Life, heard?: Heard): void;
  /** Unload them all: what each registered goes with it. */
  close(): Promise<void>;
}

/** An agent with no plugins: nothing given, nothing heard. */
export const NO_PLUGINS: AgentPlugins = {
  tools: () => [],
  blocks: () => [],
  life: () => {},
  close: async () => {},
};

/** The services every agent's context has, by the names they are provided under. */
const SERVICES = { tools: Tools, prompt: Prompt, store: Store, agent: Agent };
/** By order, then plugin, then name: the same at every start. */
const inOrder = (a: Section & { plugin: string }, b: Section & { plugin: string }) =>
  (a.order ?? 0) - (b.order ?? 0) ||
  a.plugin.localeCompare(b.plugin) ||
  a.name.localeCompare(b.name);

/** The executor's plugin host: one Cordis root, a context of its own for each agent. */
export function createPluginHost(log: Log) {
  const root = new Context();
  return {
    /** Load the plugins `agent` holds, each with its settings, in a context of the agent's own. */
    async open(agent: string, options: { store: KvStore; plugins: Held[] }): Promise<AgentPlugins> {
      if (options.plugins.length === 0) return NO_PLUGINS;
      const kept: Kept = {
        agent,
        kv: options.store,
        tools: new Map(),
        sections: new Map(),
        plugins: new Map(),
      };
      // Each plugin as the host loads it: what it is, and the fiber it runs as, named as the agent
      // holds it, so its services know it, and its own components, as that plugin.
      const asHeld = (plugin: AgentPlugin) => ({
        name: plugin.name,
        inject: plugin.inject,
        ...(plugin.provide === undefined ? {} : { provide: plugin.provide }),
        apply(ctx: Context, config: unknown) {
          kept.plugins.set(ctx.fiber, plugin.name);
          return plugin.apply(ctx, config);
        },
      });
      // The agent's own context: its four services, and every service its plugins provide, each
      // isolated in it under a label of its own (Cordis keeps a service by its label), so its
      // plugins share them and no other agent sees them.
      const provided = new Set([
        ...Object.keys(SERVICES),
        ...options.plugins.flatMap(({ plugin }) => [plugin.provide ?? []].flat()),
      ]);
      let own: Context = root;
      for (const name of provided) own = own.isolate(name);
      const loaded: Fiber[] = [];
      const unload = () => Promise.all(loaded.reverse().map((fiber) => fiber.dispose()));
      try {
        for (const service of Object.values(SERVICES)) {
          const fiber = own.use(service, kept);
          loaded.push(fiber);
          await fiber;
        }
        for (const { plugin, config } of options.plugins) {
          const fiber = own.use(asHeld(plugin), config);
          loaded.push(fiber);
          await fiber;
        }
        // One that waits for a service none of the agent's plugins provides would never apply.
        const waiting = options.plugins.filter(
          (_, i) => loaded[Object.keys(SERVICES).length + i]?.state !== ACTIVE,
        );
        if (waiting.length)
          throw new Error(
            `${waiting.map(({ plugin }) => plugin.name).join(", ")} needs a service none of the agent's plugins provides.`,
          );
      } catch (error) {
        await unload();
        throw error;
      }
      return {
        tools: () => [...kept.tools.values()],
        blocks: () =>
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
          }),
        life(event, heard = {}) {
          kept.said?.say(event, heard, (error) =>
            log.warn("A plugin failed on the agent's life.", {
              agent,
              event,
              error: String(error),
            }),
          );
        },
        async close() {
          await unload();
          kept.tools.clear();
          kept.sections.clear();
          kept.plugins.clear();
          delete kept.said;
        },
      };
    },
  };
}
