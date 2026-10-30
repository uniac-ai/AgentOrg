/** The web client's actor-library connection, retrying initialization until the core answers. */

import { type Actor, connectActor } from "../../actor/index.ts";
import type { Answer, Offer } from "../../domain/model/index.ts";

/** The core did not answer, or refused the root credential. */
export class CoreUnreachable extends Error {}

const MAX_PAUSE_MS = 10_000;

export class Core {
  readonly url: string;
  #actor: Actor | undefined;
  #closed = false;

  constructor(url: string, actorId: string, credential: string) {
    this.url = url;
    void this.#open(actorId, credential);
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

  async #open(actorId: string, credential: string) {
    for (let pause = 250; !this.#closed; pause = Math.min(pause * 2, MAX_PAUSE_MS)) {
      try {
        const actor = await connectActor({
          url: this.url,
          actorId,
          credential,
          exposed: [],
          name: "agentorg-web",
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
