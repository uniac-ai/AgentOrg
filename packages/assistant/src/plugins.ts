/**
 * The agent's own plugins: one Cordis root for the executor, and for each agent a context of its
 * own, into which each plugin the agent holds is loaded with that agent's settings. A plugin's part
 * inside the agent reaches four things through `ctx.agent`: functions it gives the model, blocks it
 * adds to every request, a store of its own, and the agent's life. What it registers is that agent's
 * alone, and goes when the agent's context closes. A plugin hears the core; it never changes how the
 * core works, and its failures are logged, never the agent's.
 */
import type { kv } from "@agentorg/interfaces";
import type { Part } from "@agentorg/looper";
import type { Log, Slot } from "@agentorg/sdk";
import { Context, type Fiber, type FiberState } from "cordis";
import type { Candidate } from "./tools.js";

type Store = Slot<typeof kv>["call"];
/** Cordis's `FiberState.ACTIVE`: a const enum it declares, which this build can't name. */
const ACTIVE = 2 as FiberState;

/**
 * What a plugin hears of the agent's life: one of its pieces of work's turns starting and ending,
 * that work's record before and after it is summarized, the agent going idle with nothing at work,
 * and the agent being stopped, said last, after its turns were cut. `compacted` is said only of a
 * summary that was kept: one that fails or is stopped leaves `compacting` without it.
 */
export type Life = "turnStarted" | "turnEnded" | "compacting" | "compacted" | "idle" | "stopped";

/** What a plugin's part inside an agent is given, as `ctx.agent`. */
export interface AgentPart {
  /** The agent's id. */
  readonly agent: string;
  /** Give the model a function, offered as `<plugin>__<name>`; it gives how to take it back. */
  tool(tool: Omit<Candidate, "slot">): () => void;
  /**
   * Add a block to every request after the agent's own words and its skills, read afresh for each
   * request; one that gives nothing adds nothing. It gives how to take it back. It may be read
   * when no request follows, so reading it only reads.
   */
  block(text: () => string | undefined, max?: number): () => void;
  /** Its own store, apart from the agent's records and from every other plugin's. */
  readonly store: Store;
  /**
   * Hear the agent's life. What a listener is given is one object, so more can be said of an event
   * later: `work` names the piece of work a turn or a summary is of.
   */
  on(event: Life, listener: (heard: Heard) => unknown): () => void;
}

/** What is said with an event of the agent's life. */
export interface Heard {
  work?: string;
}

declare module "cordis" {
  interface Context {
    agent: AgentPart;
  }
}

/**
 * A plugin's part inside an agent: a Cordis component that uses `ctx.agent`, and may use services
 * the same agent's other plugins provide. What it provides, named in `provide`, is that agent's
 * alone: another agent holding the same plugin has its own. A service not named there would be
 * every agent's, so a plugin names all it provides.
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
  /** The blocks they add to a request now, each read afresh. */
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

/** Where a plugin's own store lives in the agent's. */
const STORE = "plugin";
/** The agent's store as one plugin sees it: only its own keys, under `plugin/<name>/`. */
function storeOf(store: Store, name: string): Store {
  const prefix = `${STORE}/${name}/`;
  const own = (key: string) => `${prefix}${key}`;
  return {
    get: ({ key }) => store.get({ key: own(key) }),
    set: ({ key, value }) => store.set({ key: own(key), value }),
    delete: ({ key }) => store.delete({ key: own(key) }),
    async list({ prefix: under = "", after, limit }) {
      const { keys, next } = await store.list({
        prefix: `${prefix}${under}`,
        ...(after === undefined ? {} : { after: own(after) }),
        ...(limit === undefined ? {} : { limit }),
      });
      const mine = (key: string) => key.slice(prefix.length);
      return { keys: keys.map(mine), next: next === null ? null : mine(next) };
    },
  };
}

/** The executor's plugin host: one Cordis root, a context of its own for each agent. */
export function createPluginHost(log: Log) {
  const root = new Context();
  return {
    /** Load the plugins `agent` holds, each with its settings and a store of its own. */
    async open(agent: string, options: { store: Store; plugins: Held[] }): Promise<AgentPlugins> {
      if (options.plugins.length === 0) return NO_PLUGINS;
      const tools = new Map<symbol, Candidate>();
      const blocks = new Map<
        symbol,
        { owner: string; text: () => string | undefined; max?: number }
      >();
      const listeners = new Map<Life, Set<(heard: Heard) => unknown>>();
      const loaded: { fiber: Fiber; release: () => void }[] = [];
      const partOf = (name: string): AgentPart => ({
        agent,
        tool(tool) {
          const key = Symbol(tool.name);
          tools.set(key, { ...tool, slot: name });
          return () => void tools.delete(key);
        },
        block(text, max) {
          const key = Symbol(name);
          blocks.set(key, { owner: `plugin:${name}`, text, ...(max === undefined ? {} : { max }) });
          return () => void blocks.delete(key);
        },
        store: storeOf(options.store, name),
        on(event, listener) {
          const set = listeners.get(event) ?? new Set();
          listeners.set(event, set);
          set.add(listener);
          return () => void set.delete(listener);
        },
      });
      // The agent's own context: every service its plugins provide is isolated in it, each under a
      // label of its own (Cordis keeps a service by its label), so its plugins share them and no
      // other agent sees them.
      const provided = new Set(
        options.plugins.flatMap(({ plugin }) => [plugin.provide ?? []].flat()),
      );
      let own: Context = root;
      for (const name of provided) own = own.isolate(name);
      try {
        for (const { plugin, config } of options.plugins) {
          // Each plugin its own `agent`: the store and the name it registers under are its own.
          const ctx = own.isolate("agent");
          const release = ctx.provide("agent", partOf(plugin.name));
          const fiber = ctx.use(plugin, config);
          loaded.push({ fiber, release });
          await fiber;
        }
        // One that waits for a service none of the agent's plugins provides would never apply.
        const waiting = options.plugins.filter((_, i) => loaded[i]?.fiber.state !== ACTIVE);
        if (waiting.length)
          throw new Error(
            `${waiting.map(({ plugin }) => plugin.name).join(", ")} needs a service none of the agent's plugins provides.`,
          );
      } catch (error) {
        await Promise.all(loaded.map(({ fiber }) => fiber.dispose()));
        for (const { release } of loaded) release();
        throw error;
      }
      return {
        tools: () => [...tools.values()],
        blocks: () =>
          [...blocks.values()].flatMap(({ owner, text, max }) => {
            let words: string | undefined;
            try {
              words = text();
            } catch (error) {
              log.warn("A plugin's block couldn't be read; the request goes without it.", {
                agent,
                owner,
                error: String(error),
              });
            }
            return words ? [{ owner, text: words, ...(max === undefined ? {} : { max }) }] : [];
          }),
        life(event, heard = {}) {
          for (const listener of listeners.get(event) ?? []) {
            const failed = (error: unknown) =>
              log.warn("A plugin failed on the agent's life.", {
                agent,
                event,
                error: String(error),
              });
            try {
              const done = listener({ ...heard });
              if (done instanceof Promise) done.catch(failed);
            } catch (error) {
              failed(error);
            }
          }
        },
        async close() {
          await Promise.all(loaded.map(({ fiber }) => fiber.dispose()));
          for (const { release } of loaded) release();
          tools.clear();
          blocks.clear();
          listeners.clear();
        },
      };
    },
  };
}
