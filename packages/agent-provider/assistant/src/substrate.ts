/**
 * The agent as a substrate: three primitives in every agent's own Cordis context, on which every
 * capability is built.
 * - `capabilities`: what the agent holds. A capability mounts another, as its child, takes one off,
 *   lists them all with each one's state, and has an abort signal that ends with it.
 * - `context`: what the model is sent. A capability passes each request (its instructions, its
 *   functions and its input) and may change it: by each pass's order, then in the order the agent
 *   holds the capabilities. Once a turn, before its requests, a capability may read what its
 *   passes will give.
 * - `record`: what the agent's loops have seen and done. It says the agent's life as Cordis events
 *   (`AGENT_EVENTS`): a turn starting and ending, with the entries the turn kept of its own and how
 *   it ended, a record being summarized, the agent idle or stopped. A capability reads any of its
 *   agent's conversations from its start, a page at a time, each entry by its id and its words.
 *   Nothing adds to a record but the agent's loops.
 *
 * Nothing here gates: a capability mounts what it is given. What an agent may mount, and when a
 * person is asked, is the policy of the capability that offers it.
 */
import type { Conversed, Item, Part } from "@agentorg/looper";
import { type Context, type Fiber, Service } from "cordis";
import type { Candidate, LeftOut } from "./tools.js";

/**
 * A capability: code mounted in an agent's own Cordis context. It names in `inject` the services
 * it uses, the three primitives' or another capability's, and in `provide` those it offers the
 * others. `apply` is its mount, as Cordis names it; `unmount` runs only when it is taken off,
 * never when its agent stops or closes, so the keys it stored stay unless it removes them there.
 * What it registers goes when it goes.
 */
export interface Capability<A = unknown> {
  name: string;
  /** What a person reads it as; its name if none. */
  title?: string;
  inject: string[];
  provide?: string | string[];
  apply(ctx: Context, args: A): unknown;
  unmount?(ctx: Context): unknown;
}

/**
 * A part of what the agent is made of: a capability it holds, or, with `kind: "plugin"`, a plugin a
 * capability loaded directly, with what that plugin loads in turn. `mounted`, doing its part;
 * `down`, there and saying it can't now, or waiting for a service it needs; `failed`, not there,
 * and the agent runs without it. `detail` says why. `parent` is the capability that mounted it, or
 * that loaded the plugin; none for one mounted from outside the agent.
 */
export interface Held {
  name: string;
  title: string;
  state: "mounted" | "down" | "failed";
  detail?: string;
  parent?: string;
  kind?: "plugin";
  /**
   * What it added to the agent's latest request: the functions offered, by the names they were
   * offered under, and what it told the model, by each section's name.
   */
  added?: { functions: string[]; sections: string[] };
}

/**
 * Which conversation's loop a request is for: its id, and whose conversation it is, `person` or
 * an Actor's id. A request no conversation makes says none.
 */
export type Loop = Conversed;

/**
 * A request as a pass is given it: all of it may be changed, at every request. Keeping what the
 * prompt cache holds is for the capabilities that place things for others, `tools` and `prompt`,
 * not a rule of `context`.
 */
export interface Request {
  loop?: Loop;
  instructions: Part[];
  functions: Candidate[];
  input: Item[];
  /** What a pass couldn't give, and why: the model isn't told of it, the agent's host is. */
  leftOut: LeftOut[];
}
/**
 * A pass over each request the agent's loops make, run to its end before the next: what it throws
 * is logged, and the request goes on.
 */
export type Pass = (request: Request) => void;
/**
 * What a capability reads once a turn, before its requests, for its passes to give: awaited, in
 * the order the passes run. What it throws is logged, and the turn goes on.
 */
export type Turn = (loop: Loop | undefined) => Promise<void> | void;

/**
 * What a capability hears of the agent's life: a piece of work's turn starting and ending, that
 * work's record before and after it is summarized, the agent going idle with nothing at work, and
 * the agent being stopped, said last, after its turns were cut. `compacted` is said only of a
 * summary that was kept.
 */
export type Life = "turnStarted" | "turnEnded" | "compacting" | "compacted" | "idle" | "stopped";

/**
 * What is said with an event of the agent's life: one object, so more can be said later. `work` is
 * the piece of work whose life it is: for a conversation's own loop, the loop's id. A turn's end
 * says how it ended, and the first and last entry of its own it had kept by then, by their ids
 * as `record.read` gives them, none if it kept none: what was said to it is not its own. A call
 * still running as a turn is stopped keeps its result after this is said.
 */
export interface Heard {
  work?: string;
  how?: "answered" | "stopped" | "failed";
  first?: string;
  last?: string;
}

/** A page of a conversation's record: its entries, oldest first, and whether more follow them. */
export interface Page {
  /** Each entry by its id, and its words as the looper shows them: a call by its line. */
  entries: { id: string; words: string }[];
  more: boolean;
}

/** Each event of the agent's life, by the name a capability listens for with `ctx.on`. */
export const AGENT_EVENTS = {
  turnStarted: "agent/turn-started",
  turnEnded: "agent/turn-ended",
  compacting: "agent/compacting",
  compacted: "agent/compacted",
  idle: "agent/idle",
  stopped: "agent/stopped",
} as const satisfies Record<Life, string>;

declare module "cordis" {
  interface Context {
    capabilities: Capabilities;
    context: Passes;
    record: AgentRecord;
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

/** What the three primitives reach of the agent's host. */
export interface Host {
  /** Each capability the agent holds, by the fiber it runs as, with its name. */
  fibers: Map<Fiber, string>;
  /** Mount `capability` with `args` as a child of `parent`, which `ctx` is the context of. */
  mount(parent: string, ctx: Context, capability: Capability, args: unknown): Promise<void>;
  unmount(name: string): Promise<void>;
  list(): Held[];
  /** Every capability the agent's settings named last, whoever provides it, by id. */
  named(): string[];
  /** The abort signal of the capability named. */
  signal(name: string): AbortSignal;
  /** What the capability named says of itself now. */
  say(name: string, state: "mounted" | "down", detail?: string): void;
  /** Add a pass of the capability named, until the function it gives is called or it goes. */
  pass(owner: string, ctx: Context, pass: Pass, order: number): () => void;
  /** Add what the capability named reads once a turn, until the function it gives is called or it goes. */
  turn(owner: string, ctx: Context, turn: Turn): () => void;
  /** A page of the record of the agent's conversation `loop`, after the entry `after`. */
  read(loop: Loop, after: string | undefined, limit: number): Promise<Page>;
}

/** Where Cordis keeps, on a service as a capability reaches it, the context it was reached from. */
const CALLER = Symbol.for("cordis.caller");

/**
 * Whether a fiber is a plugin a capability loaded: one with a name of its own that is neither a
 * capability the agent holds nor a service. One with no name, as a block `ctx.inject` runs with an
 * arrow, is part of what loaded it. A named function given to `ctx.inject` reads as a plugin of
 * that name: Cordis says nothing public that tells the two apart.
 */
export const isPlugin = (fibers: Host["fibers"], fiber: Fiber) =>
  Boolean(fiber.runtime?.name) &&
  !fibers.has(fiber) &&
  !((fiber.runtime?.callback as { prototype?: unknown } | undefined)?.prototype instanceof Service);

/** The most characters a part's name has: what a capability's id may. */
const NAME_MAX = 64;
/**
 * A plugin part's name: its own name as a slug, and the number Cordis gave its fiber, which is the
 * same while it runs: unique in the agent.
 */
export function pluginName(fiber: Fiber): string {
  const number = `-${fiber.uid ?? 0}`;
  const slug =
    (fiber.runtime?.name ?? "")
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^[^a-z]+|-+$/g, "") || "plugin";
  return `${slug.slice(0, NAME_MAX - number.length).replace(/-+$/, "")}${number}`;
}

/**
 * The capability a service is called by, the context to tie what it registers to, and the part of
 * the agent that calls it (`part`): the plugin that capability loaded, if the call is from inside
 * one, else the capability. A capability's own inner components, and a service it provides,
 * calling it, are that capability's. Called on the service, as `ctx.store.get(…)`.
 */
export function callerOf(
  fibers: Host["fibers"],
  service: object,
): { name: string; ctx: Context; part: string } {
  const reached = service as { [CALLER]?: Context; ctx: Context };
  const ctx = reached[CALLER] ?? reached.ctx;
  let plugin: Fiber | undefined;
  for (let fiber = ctx.fiber; ; fiber = fiber.parent.fiber) {
    const name = fibers.get(fiber);
    if (name !== undefined) return { name, ctx, part: plugin ? pluginName(plugin) : name };
    // The outermost plugin under the capability is the part: what it loads is part of it.
    if (isPlugin(fibers, fiber)) plugin = fiber;
    if (fiber === fiber.parent.fiber) break;
  }
  throw new Error("Only a plugin the agent holds may use its services.");
}

/**
 * What the agent holds, as a capability reaches it. Each method is called on the service, as
 * `ctx.capabilities.mount(…)`: that is how Cordis names its caller.
 */
export class Capabilities extends Service {
  private host: Host;
  constructor(ctx: Context, host: Host) {
    super(ctx, "capabilities");
    this.host = host;
  }
  /**
   * Mount a capability as the caller's own child: it goes when the caller goes. It settles once
   * the child is mounted, or rejects with why it couldn't be, and the agent runs without it. A
   * child mounted in the caller's own mount that needs a service the caller offers is mounted
   * once the caller's mount ends: this settles at once, and the list says how it went. One of a
   * name the agent holds already is refused, as is one that provides a service its agent can't
   * keep to itself.
   */
  mount(capability: Capability, args?: unknown): Promise<void> {
    const { name, ctx } = callerOf(this.host.fibers, this);
    return this.host.mount(name, ctx, capability, args);
  }
  /** Take a capability off the agent, with all it mounted, each one's `unmount` first. */
  unmount(name: string): Promise<void> {
    callerOf(this.host.fibers, this);
    return this.host.unmount(name);
  }
  /** What the agent holds, in the order it was mounted, each with its state. */
  list(): Held[] {
    callerOf(this.host.fibers, this);
    return this.host.list();
  }
  /**
   * Every capability mounted on the agent, by id, whoever provides it: those it holds, and those a
   * provider outside it made, as its settings named them when its engine last read them. It asks
   * no one.
   */
  named(): string[] {
    callerOf(this.host.fibers, this);
    return this.host.named();
  }
  /** The caller's abort signal: it fires when the caller is taken off, or its agent closes. */
  get signal(): AbortSignal {
    return this.host.signal(callerOf(this.host.fibers, this).name);
  }
  /** Say whether the caller can do its part now, and why not: its state in the list. */
  say(state: "mounted" | "down", detail?: string) {
    this.host.say(callerOf(this.host.fibers, this).name, state, detail);
  }
}

/** What the model is sent, as a capability reaches it: the passes over each request. */
export class Passes extends Service {
  private host: Host;
  constructor(ctx: Context, host: Host) {
    super(ctx, "context");
    this.host = host;
  }
  /**
   * Pass each request the agent's loops make, until the caller goes or the function it gives is
   * called. Passes run by `order`, lowest first, 0 if none; then in the order the agent holds their
   * capabilities: those every agent has, then those its settings name, in the order they name them,
   * each with what it mounted after it.
   */
  pass(pass: Pass, options: { order?: number } = {}): () => void {
    const { name, ctx } = callerOf(this.host.fibers, this);
    return this.host.pass(name, ctx, pass, options.order ?? 0);
  }
  /**
   * Read, once a turn before its requests, what the caller's passes give: what can't be read in a
   * pass, which runs at once. Until the caller goes or the function it gives is called.
   */
  turn(turn: Turn): () => void {
    const { name, ctx } = callerOf(this.host.fibers, this);
    return this.host.turn(name, ctx, turn);
  }
}

/** The most entries a page of a record gives, and how many when none is asked for. */
const PAGE_MAX = 200;
const PAGE = 50;

/**
 * What the agent's loops have seen and done, as a capability reaches it: what the agent's life is
 * said through, so only that agent's capabilities hear it, and its conversations' records.
 */
export class AgentRecord extends Service {
  private host: Host;
  constructor(ctx: Context, host: Host) {
    super(ctx, "record");
    this.host = host;
  }
  /**
   * The record of one of the agent's conversations, by its loop, from its start: the entries
   * after the entry `after`, from its first when none is given, oldest first, `limit` at most (50
   * if none, never more than 200), each by its id and its words; and whether more follow. The
   * next page is after the last entry's id. Refused `unknown` for a conversation its agent doesn't
   * have, or an `after` its record doesn't hold. Called on the service, as `ctx.record.read(…)`.
   */
  read(loop: Loop, page: { after?: string; limit?: number } = {}): Promise<Page> {
    callerOf(this.host.fibers, this);
    const limit = Math.min(Math.max(1, Math.floor(page.limit ?? PAGE)), PAGE_MAX);
    return this.host.read(loop, page.after, limit);
  }
}
