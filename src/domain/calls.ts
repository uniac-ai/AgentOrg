/** Durable calls, delivery attempts, long-running outcomes, settlement, cancellation and waits. */

import type { z } from "zod";
import { violation } from "../schema.ts";
import type { Audit } from "./audit.ts";
import type { Connections } from "./connections.ts";
import { Conflict, Forbidden, Invalid, NotFound } from "./errors.ts";
import type { Call, Delivery, InterfaceDescriptor, Outcome } from "./model/index.ts";
import { type ActorLink, LinkLost, type Store, UnknownRun } from "./ports.ts";
import { type ActorRow, newId } from "./registry.ts";

export type CallRecord = z.output<typeof Call>;
type Settled = Pick<CallRecord, "state"> & Partial<Pick<CallRecord, "output" | "error">>;

export function calls(
  callStore: Store["calls"],
  connections: Pick<Connections, "link" | "interfaces">,
  audit: Audit,
  now: () => string,
) {
  /** The delivery under way for each call, on the link it uses. */
  const attempts = new Map<string, { link: ActorLink; controller: AbortController }>();
  const waiters = new Map<string, { done: Promise<void>; wake: () => void }>();

  function found(id: string): CallRecord {
    const call = callStore.get(id);
    if (!call) throw new NotFound(`there is no call ${id}`);
    return call;
  }

  /** Record a call along a route and start delivering it. */
  function create(
    from: ActorRow,
    to: string,
    name: string,
    input: Record<string, unknown>,
    cause: string | null,
  ): CallRecord {
    if (cause !== null && callStore.get(cause)?.to !== from.id) {
      throw new Invalid(`cause ${cause} is not a call into ${from.name}`);
    }
    const call: CallRecord = {
      id: newId("call"),
      from: from.id,
      to,
      interface: name,
      input,
      state: "pending",
      output: null,
      error: null,
      cause,
      run: null,
      created_at: now(),
      delivered_at: null,
      settled_at: null,
    };
    callStore.insert(call);
    audit.record(from.id, "call", call.id, "pending");
    launch(call.id);
    return call;
  }

  /** Deliver every call pending on an actor, as when it comes back. */
  function redeliver(actor: string): void {
    for (const call of callStore.pendingTo(actor)) launch(call.id);
  }

  /** Start a delivery. One that fails unexpectedly leaves the call pending for the next. */
  function launch(id: string): void {
    deliver(id).catch(() => {});
  }

  async function deliver(id: string): Promise<void> {
    const call = callStore.get(id);
    const link = call && connections.link(call.to);
    if (call?.state !== "pending" || !link || attempts.get(id)?.link === link) return;
    const attempt = { link, controller: new AbortController() };
    attempts.set(id, attempt);
    try {
      const outcome = await exchange(link, call, attempt.controller.signal);
      if (
        attempts.get(id) === attempt &&
        connections.link(call.to) === link &&
        !attempt.controller.signal.aborted
      )
        finish(call, outcome);
    } catch (error) {
      // A call whose link ended stays pending until the actor is back.
      const ended = error instanceof LinkLost || connections.link(call.to) !== link;
      if (!ended && !attempt.controller.signal.aborted) {
        settle(call.id, call.to, { state: "failed", error: (error as Error).message });
      }
    } finally {
      if (attempts.get(id) === attempt) attempts.delete(id);
    }
  }

  async function exchange(
    link: ActorLink,
    call: CallRecord,
    signal: AbortSignal,
  ): Promise<Outcome> {
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
      long_running: interfaceOf(call)?.long_running ?? false,
    };
    callStore.delivered(call.id, now());
    const delivered = await link.deliver(delivery, signal);
    if (connections.link(call.to) !== link || signal.aborted)
      throw new LinkLost("delivery owner changed");
    if (!("run" in delivered)) return delivered;
    callStore.setRun(call.id, delivered.run);
    return link.outcome(delivered.run, signal);
  }

  /** Delivery and settlement use the actor's latest advertised contract. */
  function interfaceOf(call: CallRecord): InterfaceDescriptor | undefined {
    return connections.interfaces(call.to).find((each) => each.name === call.interface);
  }

  /** Settle a call with the actor's outcome, checked against the output schema. */
  function finish(call: CallRecord, outcome: Outcome): void {
    if (!outcome.ok) {
      settle(call.id, call.to, { state: "failed", error: outcome.error });
      return;
    }
    const schema = interfaceOf(call)?.output;
    const problem =
      schema === undefined
        ? undefined
        : outcome.value === undefined || outcome.value === null
          ? "it has no structured value"
          : violation(schema, outcome.value);
    if (problem !== undefined) {
      settle(call.id, call.to, {
        state: "failed",
        error: `the output does not match the output schema of ${call.interface}: ${problem}`,
      });
      return;
    }
    const output = { value: outcome.value ?? null, parts: outcome.parts };
    settle(call.id, call.to, { state: "done", output });
  }

  /** Move a pending call to its end, once; a later result for it is dropped. */
  function settle(id: string, actor: string, settled: Settled): boolean {
    const changed = callStore.settle(id, {
      state: settled.state,
      output: settled.output ?? null,
      error: settled.error ?? null,
      settled_at: now(),
    });
    if (!changed) return false;
    audit.record(actor, "call", id, settled.state);
    waiters.get(id)?.wake();
    waiters.delete(id);
    return true;
  }

  /**
   * The call once it settles or `ms` pass, whichever is first, calling `progress` after each step
   * of `stepMs` it is still pending. The caller going away ends the wait, not the call.
   */
  async function wait(
    id: string,
    ms: number,
    options: { stepMs: number; progress?: () => Promise<void>; signal?: AbortSignal },
  ): Promise<CallRecord> {
    const deadline = Date.now() + ms;
    for (;;) {
      const left = deadline - Date.now();
      const call = found(id);
      if (call.state !== "pending" || left <= 0 || options.signal?.aborted) return call;
      let waiter = waiters.get(id);
      if (!waiter) {
        let wake = () => {};
        const done = new Promise<void>((resolve) => {
          wake = resolve;
        });
        waiter = { done, wake };
        waiters.set(id, waiter);
      }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        waiter.done,
        new Promise((resolve) => {
          timer = setTimeout(resolve, Math.min(options.stepMs, left));
        }),
      ]);
      clearTimeout(timer);
      if (found(id).state === "pending" && Date.now() < deadline) await options.progress?.();
    }
  }

  /** The caller withdraws its pending call; a run the actor holds for it is cancelled. */
  function withdraw(actor: ActorRow, id: string): CallRecord {
    const call = found(id);
    if (call.from !== actor.id) throw new Forbidden(`only its caller withdraws call ${id}`);
    if (call.state !== "pending") throw new Conflict(`call ${id} is already ${call.state}`);
    settle(id, actor.id, { state: "withdrawn" });
    stop(call);
    return found(id);
  }

  /** End a closed actor's pending calls: those it made are withdrawn, those into it fail. */
  function endFor(actor: ActorRow, closer: string): CallRecord[] {
    const own = callStore.pendingFrom(actor.id);
    const into = callStore.pendingTo(actor.id);
    for (const call of own) {
      settle(call.id, closer, { state: "withdrawn" });
      stop(call);
    }
    for (const call of into) {
      settle(call.id, closer, { state: "failed", error: `${actor.name} was closed` });
      stop(call);
    }
    return [...own, ...into].map((call) => found(call.id));
  }

  function stop(call: CallRecord): void {
    const link = connections.link(call.to);
    if (call.run !== null && link) void link.cancel(call.run).catch(() => {});
    attempts.get(call.id)?.controller.abort();
  }
  return { found, create, redeliver, wait, withdraw, endFor };
}

export type Calls = ReturnType<typeof calls>;
