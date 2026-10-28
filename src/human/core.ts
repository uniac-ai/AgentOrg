/**
 * The human actor's connection to the core, as the root, through the actor library: it exposes the
 * human's interfaces and calls the interfaces available to the root. Until the core first answers
 * it connects again; once connected, the library reconnects after any drop.
 */

import { type Actor, connectActor, type Exposed } from "../actor/index.ts";
import type { Answer, Offer } from "../domain/model/index.ts";

/** The core did not answer, or refused the root credential. */
export class CoreUnreachable extends Error {}

const MAX_PAUSE_MS = 10_000;

export class Core {
  readonly url: string;
  #actor: Actor | undefined;
  #closed = false;

  constructor(url: string, credential: string, exposed: Exposed[]) {
    this.url = url;
    void this.#open(credential, exposed);
  }

  /** The interfaces available to the root. */
  async available(): Promise<Offer[]> {
    return this.#use((actor) => actor.available());
  }

  /** Call an interface available to the root; the core's refusal comes back as an answer. */
  async call(name: string, input: Record<string, unknown>): Promise<Answer> {
    return this.#use((actor) => actor.call(name, input));
  }

  async close() {
    this.#closed = true;
    await this.#actor?.close();
  }

  async #open(credential: string, exposed: Exposed[]) {
    for (let pause = 250; !this.#closed; pause = Math.min(pause * 2, MAX_PAUSE_MS)) {
      try {
        const actor = await connectActor({
          url: this.url,
          credential,
          exposed,
          name: "agentorg-human",
        });
        if (this.#closed) await actor.close();
        else this.#actor = actor;
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, pause).unref());
      }
    }
  }

  async #use<T>(work: (actor: Actor) => Promise<T>): Promise<T> {
    const actor = this.#actor;
    try {
      if (actor === undefined) throw new Error("not connected yet");
      return await work(actor);
    } catch (error) {
      throw new CoreUnreachable(`the core is not reachable at ${this.url}`, { cause: error });
    }
  }
}
