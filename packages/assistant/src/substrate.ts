/**
 * The agent as a substrate: three primitives in every agent's own Cordis context, on which every
 * capability is built.
 * - `capabilities`: what the agent holds. A capability mounts another, as its child, takes one off,
 *   lists them all with each one's state, and has an abort signal that ends with it.
 * - `context`: what the model is sent. A capability passes each request (its instructions, its
 *   functions and its input) and may change it, in the order the capabilities were mounted.
 * - `record`: what the agent's loops have seen and done. It says the agent's life as Cordis events
 *   (`AGENT_EVENTS`): a turn starting and ending, a record being summarized, the agent idle or
 *   stopped. Reading a loop's record and adding to it come with the first capability that reads it.
 *
 * Nothing here gates: a capability mounts what it is given. What an agent may mount, and when a
 * person is asked, is the policy of the capability that offers it.
 */
import type { Item, Part } from "@agentorg/looper";
import { type Context, type Fiber, Service } from "cordis";
import type { Candidate } from "./tools.js";

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
 * A capability as the agent holds it: `mounted`, doing its part; `down`, mounted and saying it
 * can't now; `failed`, not mounted, and the agent runs without it. `detail` says why. `parent` is
 * the capability that mounted it, none for one mounted from outside the agent.
 */
export interface Held {
  name: string;
  title: string;
  state: "mounted" | "down" | "failed";
  detail?: string;
  parent?: string;
  /**
   * What it added to the last request, in characters: to the instructions, and to the functions.
   * Not kept yet.
   */
  added?: { instructions: number; functions: number };
}

/**
 * Which conversation's loop a request is for: its id, and whose conversation it is, `person` or
 * an Actor's id. Said once the looper tells it.
 */
export interface Loop {
  id: string;
  with: string;
}

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
}
/**
 * A pass over each request the agent's loops make, run to its end before the next: what it throws
 * is logged, and the request goes on.
 */
export type Pass = (request: Request) => void;

/**
 * What a capability hears of the agent's life: a piece of work's turn starting and ending, that
 * work's record before and after it is summarized, the agent going idle with nothing at work, and
 * the agent being stopped, said last, after its turns were cut. `compacted` is said only of a
 * summary that was kept.
 */
export type Life = "turnStarted" | "turnEnded" | "compacting" | "compacted" | "idle" | "stopped";

/**
 * What is said with an event of the agent's life: one object, so more can be said later. Once the
 * looper tells them, a turn's end says how it ended and which entries were its own.
 */
export interface Heard {
  work?: string;
  how?: "answered" | "stopped" | "failed";
  first?: string;
  last?: string;
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
  /** The abort signal of the capability named. */
  signal(name: string): AbortSignal;
  /** What the capability named says of itself now. */
  say(name: string, state: "mounted" | "down", detail?: string): void;
  /** Add a pass of the capability named, until the function it gives is called or it goes. */
  pass(owner: string, ctx: Context, pass: Pass): () => void;
}

/** Where Cordis keeps, on a service as a capability reaches it, the context it was reached from. */
const CALLER = Symbol.for("cordis.caller");
/**
 * The capability a service is called by, and the context to tie what it registers to: the one the
 * agent holds that the caller is part of. A capability's own inner components, and a service it
 * provides, calling it, are that capability's. Called on the service, as `ctx.store.get(…)`.
 */
export function callerOf(fibers: Host["fibers"], service: object): { name: string; ctx: Context } {
  const reached = service as { [CALLER]?: Context; ctx: Context };
  const ctx = reached[CALLER] ?? reached.ctx;
  for (let fiber = ctx.fiber; ; fiber = fiber.parent.fiber) {
    const name = fibers.get(fiber);
    if (name !== undefined) return { name, ctx };
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
   * Pass each request the agent's loops make, in the order the capabilities were mounted, until
   * the caller goes or the function it gives is called.
   */
  pass(pass: Pass): () => void {
    const { name, ctx } = callerOf(this.host.fibers, this);
    return this.host.pass(name, ctx, pass);
  }
}

/**
 * What the agent's loops have seen and done, as a capability reaches it. For now it is what the
 * agent's life is said through, so only that agent's capabilities hear it.
 */
export class AgentRecord extends Service {
  constructor(ctx: Context) {
    super(ctx, "record");
  }
}
