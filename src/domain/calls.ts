/**
 * Calls between actors: their records, their delivery into the called actor, and waits on them.
 *
 * A call is recorded as pending before it is delivered. It goes through the called actor's link
 * while the actor is reachable, and again each time the actor comes back while the call is still
 * pending, so delivery is at least once. A long-running interface may take the call as a run,
 * which it finishes hours later. The core waits on the run, asks again after the actor comes back,
 * and delivers the call again when the actor no longer knows the run, as after a restart. A
 * result is checked against the interface's output schema before the call is done.
 */

import type { z } from "zod";
import type { Audit } from "./audit.ts";
import { Conflict, Forbidden, Invalid, NotFound } from "./errors.ts";
import type { Call, Delivery, InterfaceDescriptor, Outcome } from "./model/index.ts";
import { type ActorLink, LinkLost, type Store, UnknownRun } from "./ports.ts";
import { type ActorRow, newId, type Registry } from "./registry.ts";
import { violation } from "./validation.ts";
import type { Route } from "./wiring.ts";

export type CallRecord = z.output<typeof Call>;
type Settled = Pick<CallRecord, "state"> & Partial<Pick<CallRecord, "output" | "error">>;

export class Calls {
  private readonly calls: Store["calls"];
  private readonly registry: Registry;
  private readonly audit: Audit;
  private readonly now: () => string;
  private readonly linkOf: (actor: string) => ActorLink | undefined;
  /** The delivery under way for each call, on the link it uses. */
  private readonly attempts = new Map<string, { link: ActorLink; controller: AbortController }>();
  private readonly waiters = new Map<string, { done: Promise<void>; wake: () => void }>();

  constructor(
    store: Store,
    registry: Registry,
    audit: Audit,
    options: { now: () => string; linkOf: (actor: string) => ActorLink | undefined },
  ) {
    this.calls = store.calls;
    this.registry = registry;
    this.audit = audit;
    this.now = options.now;
    this.linkOf = options.linkOf;
  }

  found(id: string): CallRecord {
    const call = this.calls.get(id);
    if (!call) throw new NotFound(`there is no call ${id}`);
    return call;
  }

  /** Record a call along a route and start delivering it. */
  create(
    from: ActorRow,
    route: Route,
    input: Record<string, unknown>,
    cause: string | null,
  ): CallRecord {
    if (cause !== null && this.calls.get(cause)?.to !== from.id) {
      throw new Invalid(`cause ${cause} is not a call into ${from.name}`);
    }
    const call: CallRecord = {
      id: newId("call"),
      from: from.id,
      to: route.to.id,
      interface: route.interface.name,
      input,
      state: "pending",
      output: null,
      error: null,
      cause,
      run: null,
      created_at: this.now(),
      delivered_at: null,
      settled_at: null,
    };
    this.calls.insert(call);
    this.audit.record(from.id, "call", call.id, "pending");
    this.launch(call.id);
    return call;
  }

  /** Deliver every call pending on an actor, as when it comes back. */
  redeliver(actor: string): void {
    for (const call of this.calls.pendingTo(actor)) this.launch(call.id);
  }

  /** Start a delivery. One that fails unexpectedly leaves the call pending for the next. */
  private launch(id: string): void {
    this.deliver(id).catch(() => {});
  }

  private async deliver(id: string): Promise<void> {
    const call = this.calls.get(id);
    const link = call && this.linkOf(call.to);
    if (call?.state !== "pending" || !link || this.attempts.get(id)?.link === link) return;
    const attempt = { link, controller: new AbortController() };
    this.attempts.set(id, attempt);
    try {
      this.finish(call, await this.exchange(link, call, attempt.controller.signal));
    } catch (error) {
      // A call whose link ended stays pending until the actor is back.
      const ended = error instanceof LinkLost || this.linkOf(call.to) !== link;
      if (!ended && !attempt.controller.signal.aborted) {
        this.settle(call.id, call.to, { state: "failed", error: (error as Error).message });
      }
    } finally {
      if (this.attempts.get(id) === attempt) this.attempts.delete(id);
    }
  }

  private async exchange(link: ActorLink, call: CallRecord, signal: AbortSignal): Promise<Outcome> {
    if (call.run !== null) {
      try {
        return await link.outcome(call.run, signal);
      } catch (error) {
        if (!(error instanceof UnknownRun)) throw error;
      }
    }
    const delivery: Delivery = {
      call: call.id,
      from: call.from,
      cause: call.cause,
      interface: call.interface,
      input: call.input,
      long_running: this.interfaceOf(call)?.long_running ?? false,
    };
    this.calls.delivered(call.id, this.now());
    const delivered = await link.deliver(delivery, signal);
    if (!("run" in delivered)) return delivered;
    this.calls.setRun(call.id, delivered.run);
    return link.outcome(delivered.run, signal);
  }

  private interfaceOf(call: CallRecord): InterfaceDescriptor | undefined {
    return this.registry.get(call.to)?.interfaces.find((each) => each.name === call.interface);
  }

  /** Settle a call with the actor's outcome, checked against the output schema. */
  private finish(call: CallRecord, outcome: Outcome): void {
    if (!outcome.ok) {
      this.settle(call.id, call.to, { state: "failed", error: outcome.error });
      return;
    }
    const schema = this.interfaceOf(call)?.output;
    const problem =
      schema === undefined
        ? undefined
        : outcome.value === undefined || outcome.value === null
          ? "it has no structured value"
          : violation(schema, outcome.value);
    if (problem !== undefined) {
      this.settle(call.id, call.to, {
        state: "failed",
        error: `the output does not match the output schema of ${call.interface}: ${problem}`,
      });
      return;
    }
    const output = { value: outcome.value ?? null, parts: outcome.parts };
    this.settle(call.id, call.to, { state: "done", output });
  }

  /** Move a pending call to its end, once; a later result for it is dropped. */
  private settle(id: string, actor: string, settled: Settled): boolean {
    const changed = this.calls.settle(id, {
      state: settled.state,
      output: settled.output ?? null,
      error: settled.error ?? null,
      settled_at: this.now(),
    });
    if (!changed) return false;
    this.audit.record(actor, "call", id, settled.state);
    this.waiters.get(id)?.wake();
    this.waiters.delete(id);
    return true;
  }

  /**
   * The call once it settles or `ms` pass, whichever is first, calling `progress` after each step
   * of `stepMs` it is still pending. The caller going away ends the wait, not the call.
   */
  async wait(
    id: string,
    ms: number,
    options: { stepMs: number; progress?: () => Promise<void>; signal?: AbortSignal },
  ): Promise<CallRecord> {
    const deadline = Date.now() + ms;
    for (;;) {
      const left = deadline - Date.now();
      const call = this.found(id);
      if (call.state !== "pending" || left <= 0 || options.signal?.aborted) return call;
      let waiter = this.waiters.get(id);
      if (!waiter) {
        let wake = () => {};
        const done = new Promise<void>((resolve) => {
          wake = resolve;
        });
        waiter = { done, wake };
        this.waiters.set(id, waiter);
      }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        waiter.done,
        new Promise((resolve) => {
          timer = setTimeout(resolve, Math.min(options.stepMs, left));
        }),
      ]);
      clearTimeout(timer);
      if (this.found(id).state === "pending" && Date.now() < deadline) await options.progress?.();
    }
  }

  /** The caller withdraws its pending call; a run the actor holds for it is cancelled. */
  withdraw(actor: ActorRow, id: string): CallRecord {
    const call = this.found(id);
    if (call.from !== actor.id) throw new Forbidden(`only its caller withdraws call ${id}`);
    if (call.state !== "pending") throw new Conflict(`call ${id} is already ${call.state}`);
    this.settle(id, actor.id, { state: "withdrawn" });
    this.stop(call);
    return this.found(id);
  }

  /** End a closed actor's pending calls: those it made are withdrawn, those into it fail. */
  endFor(actor: ActorRow, closer: string): CallRecord[] {
    const own = this.calls.pendingFrom(actor.id);
    const into = this.calls.pendingTo(actor.id);
    for (const call of own) {
      this.settle(call.id, closer, { state: "withdrawn" });
      this.stop(call);
    }
    for (const call of into) {
      this.settle(call.id, closer, { state: "failed", error: `${actor.name} was closed` });
      this.stop(call);
    }
    return [...own, ...into].map((call) => this.found(call.id));
  }

  private stop(call: CallRecord): void {
    const link = this.linkOf(call.to);
    if (call.run !== null && link) void link.cancel(call.run).catch(() => {});
    this.attempts.get(call.id)?.controller.abort();
  }
}
