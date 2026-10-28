/**
 * The human's queue: the calls into the user, waiting until the user answers them in the web app.
 * The human's interfaces are long-running, so each call's handler returns a promise that the queue
 * settles with the user's answer, however much later; a call its caller withdraws leaves the queue.
 * The queue lives in memory: after a restart the core delivers every pending call again, which
 * rebuilds it.
 */

import { z } from "zod";
import type { Exposed, Incoming, Reply } from "../actor/index.ts";
import { descriptorOf, INTERFACES, type InterfaceName } from "./interfaces.ts";
import type { Pending } from "./types.ts";

interface Held {
  pending: Pending;
  settled: Promise<Reply>;
  answer: (output: Record<string, unknown>) => void;
}

export class Queue {
  readonly #held = new Map<string, Held>();

  /** The human's interfaces, each handled by holding its calls here until the user answers. */
  readonly exposed: Exposed[] = (Object.keys(INTERFACES) as InterfaceName[]).map((name) => ({
    interface: descriptorOf(name),
    handle: (input, call) => this.#hold(name, input, call),
  }));

  #hold(name: InterfaceName, input: Record<string, unknown>, call: Incoming): Promise<Reply> {
    const parsed = INTERFACES[name].input.safeParse(input);
    if (!parsed.success) throw new Error(`invalid: ${z.prettifyError(parsed.error)}`);
    // Delivery is at least once: a call already held keeps its place and its answer.
    const known = this.#held.get(call.id);
    if (known) return known.settled;
    let answer!: Held["answer"];
    let withdrawn!: (reason: Error) => void;
    const settled = new Promise<Reply>((resolve, reject) => {
      answer = (output) => resolve({ value: output });
      withdrawn = reject;
    });
    this.#held.set(call.id, {
      pending: {
        call: call.id,
        from: call.from,
        cause: call.cause,
        interface: name,
        input: parsed.data,
        received_at: new Date().toISOString(),
      } as Pending,
      settled,
      answer,
    });
    call.signal.addEventListener("abort", () => {
      this.#held.delete(call.id);
      withdrawn(new Error("withdrawn"));
    });
    return settled;
  }

  /** The calls waiting on the user, oldest first. */
  pending(): Pending[] {
    return [...this.#held.values()].map((held) => held.pending);
  }

  /** Complete a waiting call with its output; false when the call no longer waits. */
  complete(call: string, output: Record<string, unknown>): boolean {
    const held = this.#held.get(call);
    if (held === undefined) return false;
    this.#held.delete(call);
    held.answer(output);
    return true;
  }
}
