import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { DescribedInterface, JsonSchema } from "@agentorg/sdk";
import { Refused } from "@agentorg/sdk";
import type { Compiled, Job, Reply, SchemaPart } from "./validate-worker.js";

/** A part of an interface with its own schema: a method's input or output, or an event. */
export type Part = { method: string; side: "input" | "output" } | { event: string };

const describe = (part: Part) =>
  "method" in part ? `${part.method} ${part.side}` : `${part.event} event`;

function schemaOf(iface: DescribedInterface, part: Part): JsonSchema | undefined {
  if ("method" in part)
    return Object.hasOwn(iface.methods, part.method)
      ? iface.methods[part.method]?.[part.side]
      : undefined;
  return Object.hasOwn(iface.events, part.event) ? iface.events[part.event] : undefined;
}

const keyOf = (iface: DescribedInterface, part: Part) => `${iface.hash} ${describe(part)}`;

function partsOf(iface: DescribedInterface): Part[] {
  return [
    ...Object.keys(iface.methods).flatMap((method) => [
      { method, side: "input" as const },
      { method, side: "output" as const },
    ]),
    ...Object.keys(iface.events).map((event) => ({ event })),
  ];
}

/** How long checking one value may take, once compiled, before it is refused and its worker replaced. */
export const CHECK_BUDGET_MS = 250;
/**
 * How long compiling an interface's schemas may take, per schema, before the check is refused and
 * its worker replaced. Kept apart from the check's budget, so a first call on a loaded machine
 * isn't refused for compiling.
 */
export const COMPILE_BUDGET_MS = 2000;
/** Workers in the pool: about one per spare core, at least two so one stuck check can't stall all. */
const POOL_SIZE = Math.max(2, Math.min(4, availableParallelism() - 1));

/**
 * What a job ends with: the worker's reply, `late` past its budget (while compiling, or checking),
 * or the pool's failure.
 */
type Late = { late: "compile" | "check" };
type Outcome = Reply | Late | Error;
const isLate = (outcome: Outcome): outcome is Late =>
  typeof outcome === "object" && outcome !== null && "late" in outcome;
interface Slot {
  worker: Worker;
  /** Set once the worker has loaded ajv; only then does it take jobs and their budgets. */
  ready: boolean;
  busy?: {
    job: Job;
    settle(outcome: Outcome): void;
    timer: ReturnType<typeof setTimeout>;
    /** Compiling its schemas, or checking the value. */
    phase: "compile" | "check";
  };
}

/**
 * JSON Schema validation in the 2020-12 dialect, with ajv in strict mode, run in a pool of worker
 * threads: schemas come from Actors, and none may run on the router's thread. Each check has a
 * time budget; past it the check is refused and its worker replaced. Each worker keeps what it has
 * compiled, keyed by the interface's hash.
 */
export class Validators {
  readonly #budgetMs: number;
  readonly #compileBudgetMs: number;
  readonly #slots: Slot[] = [];
  /**
   * Waiting jobs, one queue per Actor the work is for, served in turn. An Actor flooding slow
   * checks delays mostly itself; another Actor's check waits for the jobs already running: about
   * one check budget with two or more workers, longer if one of them is compiling (up to the
   * compile budget per part).
   */
  readonly #queues = new Map<string, { job: Job; settle(outcome: Outcome): void }[]>();
  #nextId = 1;
  /** Set when a worker can't even start: every check fails with it rather than respawning forever. */
  #broken?: Error;

  readonly #workerUrl: URL;

  constructor(
    options: { budgetMs?: number; compileBudgetMs?: number; size?: number; workerUrl?: URL } = {},
  ) {
    this.#budgetMs = options.budgetMs ?? CHECK_BUDGET_MS;
    this.#compileBudgetMs = options.compileBudgetMs ?? COMPILE_BUDGET_MS;
    this.#workerUrl = options.workerUrl ?? new URL("./validate-worker.js", import.meta.url);
    for (let i = 0; i < (options.size ?? POOL_SIZE); i++) this.#slots.push(this.#spawn());
  }

  #spawn(): Slot {
    const worker = new Worker(this.#workerUrl);
    const slot: Slot = { worker, ready: false };
    worker.on("message", (reply: Reply | Compiled | "ready") => {
      if (reply === "ready") {
        slot.ready = true;
        // An idle pool doesn't keep the process alive; a worker with a job does (see #pump).
        worker.unref();
        return this.#pump();
      }
      const busy = slot.busy;
      if (!busy || busy.job.id !== reply.id) return;
      if ("compiled" in reply) {
        // Compiled: from here the check's own, shorter budget runs.
        clearTimeout(busy.timer);
        busy.phase = "check";
        busy.timer = setTimeout(() => this.#replace(slot), this.#budgetMs);
        return;
      }
      clearTimeout(busy.timer);
      slot.busy = undefined;
      worker.unref();
      busy.settle(reply);
      this.#pump();
    });
    // A worker that dies on its own is replaced like one that ran over; one that dies before it
    // is ready means none can start.
    const died = (error?: Error) => {
      if (slot.ready) return this.#replace(slot);
      if (!this.#slots.includes(slot)) return;
      this.#fail(
        new Error(`The schema workers can't start: ${error?.message ?? "the worker exited"}`),
      );
    };
    worker.on("error", died);
    worker.on("exit", () => died());
    return slot;
  }

  #fail(error: Error) {
    this.#broken = error;
    this.close(error);
  }

  #replace(slot: Slot) {
    const index = this.#slots.indexOf(slot);
    if (index < 0) return;
    const busy = slot.busy;
    slot.busy = undefined;
    if (busy) clearTimeout(busy.timer);
    this.#slots[index] = this.#spawn();
    void slot.worker.terminate();
    busy?.settle({ late: busy.phase });
    this.#pump();
  }

  /** Hand waiting jobs to idle ready workers, until either runs out. */
  #pump() {
    for (;;) {
      const slot = this.#slots.find((candidate) => candidate.ready && !candidate.busy);
      if (!slot) return;
      const next = this.#next();
      if (!next) return;
      // The budget runs from when a ready worker takes the job, not while it waits. Compiling gets
      // its own budget, per schema; the check's starts when the worker says it has compiled.
      const budget = this.#compileBudgetMs * Math.max(1, next.job.parts.length);
      const timer = setTimeout(() => this.#replace(slot), budget);
      slot.busy = { ...next, timer, phase: "compile" };
      slot.worker.ref();
      try {
        slot.worker.postMessage(next.job);
      } catch (error) {
        // A value too deep to copy to a worker fails its check; the worker never saw it and is
        // free again for the next job.
        clearTimeout(timer);
        slot.busy = undefined;
        slot.worker.unref();
        next.settle({
          id: next.job.id,
          ok: false,
          stage: "check",
          message: `it can't be checked (${error instanceof Error ? error.message : String(error)})`,
        });
      }
    }
  }

  /** The next job in turn: the first Actor's oldest, after which that Actor goes to the back. */
  #next() {
    for (const [actor, queue] of this.#queues) {
      this.#queues.delete(actor);
      const next = queue.shift();
      if (queue.length) this.#queues.set(actor, queue);
      if (next) return next;
    }
    return undefined;
  }

  #run(actor: string, parts: SchemaPart[], check?: Job["check"]): Promise<Outcome> {
    if (this.#broken) return Promise.resolve(this.#broken);
    if (!this.#slots.length) return Promise.resolve(new Error("The validators are closed."));
    return new Promise((settle) => {
      const queue = this.#queues.get(actor) ?? [];
      this.#queues.set(actor, queue);
      queue.push({ job: { id: this.#nextId++, parts, ...(check ? { check } : {}) }, settle });
      this.#pump();
    });
  }

  /**
   * Compile every schema of an interface, on behalf of the Actor that declared it; one that won't
   * compile, or compiles too slowly, is `invalid`.
   */
  async prepare(actor: string, iface: DescribedInterface): Promise<void> {
    const reply = await this.#run(
      actor,
      partsOf(iface).map((part) => ({ key: keyOf(iface, part), schema: schemaOf(iface, part) })),
    );
    if (reply instanceof Error) throw reply;
    if (isLate(reply))
      throw new Refused(
        "invalid",
        `${iface.id}'s schemas took over ${this.#compileBudgetMs} ms each to compile.`,
      );
    if (!reply.ok) throw new Refused("invalid", `${iface.id}: ${reply.message}`);
  }

  /** Whether the part exists on the interface. */
  has(iface: DescribedInterface, part: Part): boolean {
    return schemaOf(iface, part) !== undefined;
  }

  /**
   * Check a value against a part's schema, in the turn of `actor`, the Actor the work is for. A
   * caller's misfit is `invalid` (nothing ran); a provider's is `bad_output` (it ran and broke the
   * contract). A check over the budget is refused the same way.
   */
  async check(
    actor: string,
    iface: DescribedInterface,
    part: Part,
    value: unknown,
    code: "invalid" | "bad_output",
  ): Promise<void> {
    const schema = schemaOf(iface, part);
    if (schema === undefined) throw new Refused("invalid", `${iface.id} has no ${describe(part)}.`);
    const key = keyOf(iface, part);
    const reply = await this.#run(actor, [{ key, schema }], { key, value });
    if (reply instanceof Error) throw reply;
    if (isLate(reply))
      throw new Refused(
        code,
        reply.late === "compile"
          ? `${iface.id} ${describe(part)}: its schema took over ${this.#compileBudgetMs} ms to compile.`
          : `${iface.id} ${describe(part)}: the check took over ${this.#budgetMs} ms.`,
      );
    if (reply.ok) return;
    if (reply.stage === "compile")
      throw new Refused("invalid", `${iface.id} ${describe(part)}: ${reply.message}`);
    throw new Refused(code, `${iface.id} ${describe(part)}: ${reply.message}`);
  }

  /** Stop every worker; checks in flight or waiting fail. */
  close(error = new Error("The validators are closed.")): void {
    const slots = this.#slots.splice(0);
    for (const slot of slots) {
      if (slot.busy) clearTimeout(slot.busy.timer);
      slot.busy?.settle(error);
      void slot.worker.terminate();
    }
    const waiting = [...this.#queues.values()].flat();
    this.#queues.clear();
    for (const job of waiting) job.settle(error);
  }
}
