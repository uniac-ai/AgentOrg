/**
 * The capabilities every agent is mounted with by its executor, each on the primitives:
 * - `agent`: the agent's id;
 * - `store`: each capability's own keys in the agent's durable store, made with the store the
 *   executor keeps for the agent;
 * - `tools`: functions a capability gives the model, offered as `<capability>__<name>`, through a
 *   pass on `context`;
 * - `prompt`: sections a capability adds to what the model is told, each named and ordered,
 *   through a pass on `context`.
 * Each service knows which capability calls it: in a service's method, Cordis gives the caller's
 * context, and its fiber is the capability. What a capability registers is its own, that agent's
 * alone, and goes when the capability goes.
 */
import type { kv } from "@agentorg/interfaces";
import type { Part } from "@agentorg/looper";
import type { Log, Slot } from "@agentorg/sdk";
import { type Context, Service } from "cordis";
import { type Capability, callerOf, type Host } from "./substrate.js";
import type { Candidate } from "./tools.js";

export type KvStore = Slot<typeof kv>["call"];

/** A section of what the model is told, as a capability adds it. */
export interface Section {
  /** Its name, unique among the capability's sections. */
  name: string;
  /** Read for each request; one that gives nothing adds nothing. Reading it only reads. */
  text: () => string | undefined;
  /** Where it goes among all sections, lowest first; then by capability and name. 0 if none. */
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
}

type Fibers = Host["fibers"];

/** Functions capabilities give the model, each offered as `<capability>__<name>`. */
export class Tools extends Service {
  private kept: { fibers: Fibers; tools: Map<symbol, Candidate> };
  constructor(ctx: Context, kept: { fibers: Fibers; tools: Map<symbol, Candidate> }) {
    super(ctx, "tools");
    this.kept = kept;
  }
  /**
   * Give the model a function until the capability goes, or until the function it gives is
   * called. A turn keeps the functions it was offered: a call that comes after is answered that
   * the function is no longer held, and nothing of the capability runs.
   */
  register(tool: Omit<Candidate, "slot">): () => void {
    const { name: slot, ctx } = callerOf(this.kept.fibers, this);
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

type Kept = Section & { plugin: string };

/** What capabilities add to what the model is told. */
export class Prompt extends Service {
  private kept: { fibers: Fibers; sections: Map<string, Kept> };
  constructor(ctx: Context, kept: { fibers: Fibers; sections: Map<string, Kept> }) {
    super(ctx, "prompt");
    this.kept = kept;
  }
  /**
   * Add a section to every request until the capability goes, or until the function it gives is
   * called. A worker is told sections after the agent's own words and its skills; the front desk,
   * after who it speaks as. A second of the same name from the same capability is refused.
   */
  section(section: Section): () => void {
    const { name: plugin, ctx } = callerOf(this.kept.fibers, this);
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

/** Where a capability's own keys live in the agent's store. */
const STORE = "plugin";
/**
 * Durable keeping: each capability's own keys in the agent's store, under `plugin/<name>/`. A
 * capability going leaves them.
 * Each method is called on the service, as `ctx.store.get(…)`: that is how Cordis names its caller.
 */
export class Store extends Service implements KvStore {
  private kept: { fibers: Fibers; kv: KvStore };
  constructor(ctx: Context, kept: { fibers: Fibers; kv: KvStore }) {
    super(ctx, "store");
    this.kept = kept;
  }
  // Methods, not arrow functions: Cordis gives each call `this.ctx` as the calling capability's.
  private prefix() {
    return `${STORE}/${callerOf(this.kept.fibers, this).name}/`;
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

/** The agent itself, as its capabilities reach it: its id. */
export class Agent extends Service {
  private kept: { agent: string };
  constructor(ctx: Context, kept: { agent: string }) {
    super(ctx, "agent");
    this.kept = kept;
  }
  /** The agent's id. */
  get id() {
    return this.kept.agent;
  }
}

/** By order, then capability, then name: the same at every start. */
const inOrder = (a: Kept, b: Kept) =>
  (a.order ?? 0) - (b.order ?? 0) ||
  a.plugin.localeCompare(b.plugin) ||
  a.name.localeCompare(b.name);

/** The bundled capabilities, made for one agent, in the order they are mounted. */
export function bundled(options: { agent: string; kv: KvStore; fibers: Fibers; log: Log }) {
  const { agent, kv, fibers, log } = options;
  const tools = new Map<symbol, Candidate>();
  const sections = new Map<string, Kept>();
  /** The sections, in order, each read afresh; one that throws is logged and left out. */
  const blocks = (): Part[] =>
    [...sections.values()].sort(inOrder).flatMap(({ plugin, name, text, max }) => {
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
  const serving =
    <T>(service: new (ctx: Context, kept: T) => Service, kept: T) =>
    async (ctx: Context) => {
      await ctx.use(service, kept);
    };
  const capabilities: Capability[] = [
    {
      name: "agent",
      title: "Its id",
      inject: [],
      provide: "agent",
      apply: serving(Agent, { agent }),
    },
    {
      name: "store",
      title: "Store",
      inject: [],
      provide: "store",
      apply: serving(Store, { fibers, kv }),
    },
    {
      name: "tools",
      title: "Tools",
      inject: ["context"],
      provide: "tools",
      async apply(ctx) {
        await ctx.use(Tools, { fibers, tools });
        ctx.context.pass((request) => void request.functions.push(...tools.values()));
      },
    },
    {
      name: "prompt",
      title: "Prompt",
      inject: ["context"],
      provide: "prompt",
      async apply(ctx) {
        await ctx.use(Prompt, { fibers, sections });
        ctx.context.pass((request) => void request.instructions.push(...blocks()));
      },
    },
  ];
  return {
    capabilities,
    provides: ["agent", "store", "tools", "prompt"],
    /** The functions capabilities give through `tools` now. */
    registered: () => [...tools.values()],
    /** The sections they add through `prompt` now, in order, each read afresh. */
    sections: blocks,
  };
}
