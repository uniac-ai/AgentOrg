/**
 * What the agent actor presents to its session. Until the session fills a position, that is
 * `attach` alone, the actor's sign-in. Once it does, it is the position's available interfaces as
 * the core offers them, passed through unchanged, with one exception: a credential that
 * `actor_create` returns is kept in the credential store, and the session sees that it was kept,
 * never the credential.
 */

import { existsSync } from "node:fs";
import { z } from "zod";
import { type Actor, connectActor, connectClient, type Presented } from "../actor/index.ts";
import {
  type Answer,
  Handle,
  Id,
  type InterfaceDescriptor,
  type Offer,
  objectSchema,
  type ResponseOf,
  Text,
} from "../domain/model/index.ts";
import { credentials, readPrivate, rootCredentialPath } from "../home.ts";
import { sessions } from "./sessions.ts";

const AttachRequest = z.strictObject({
  actor: Id.optional().describe("The id of the position your brief names."),
  name: Handle.optional().describe(
    "Only when the user appointed you directly, with no position named: your handle under the user.",
  ),
  purpose: Text.optional().describe("With name: what your position is for."),
});

const Attached = z.strictObject({
  actor: Id.describe("The position you now fill."),
  created: z.boolean().describe("True when attaching created it, under the user."),
});

export const ATTACH: InterfaceDescriptor = {
  name: "attach",
  description: `Fill your position in the organization. Until you do, this is your only tool; once you do, your tools are the position's interfaces.

Give actor, the id your brief names. A session the user started with an appointment, naming no position, gives name and purpose instead, once: that creates its position directly under the user. Then team shows your position, your manager and your reports.`,
  input: objectSchema(AttachRequest, "input"),
  output: objectSchema(Attached, "output"),
  one_way: false,
  long_running: false,
};

const refused = (code: string, message: string): Answer => ({ state: "refused", code, message });

/** The SDK's own limit on a request, which a call that waits longer must lift. */
const DEFAULT_TIMEOUT_SECONDS = 60;

/** Room for a call to answer after the wait it asked for. */
const MARGIN_SECONDS = 30;

export interface AgentOptions {
  coreUrl: string;
  /** The client session this agent serves, when the client names one; it remembers the position. */
  session: string | undefined;
}

export class Agent implements Presented {
  readonly #options: AgentOptions;
  readonly #listeners: (() => void)[] = [];
  #position: Actor | undefined;
  /** The position's offers, as last listed. */
  #offers: Offer[] = [];
  /** Set once the session has filled a position, which `attach` never changes. */
  #filled: string | undefined;

  constructor(options: AgentOptions) {
    this.#options = options;
    if (options.session !== undefined) this.#filled = sessions.position(options.session);
  }

  /** Connect the position this session filled before, if it did; retried until the core answers. */
  async resume(): Promise<void> {
    const actor = this.#filled;
    if (actor === undefined) return;
    const credential = credentials.read(actor);
    if (credential === undefined) return;
    for (let pause = 250; this.#position === undefined; pause = Math.min(pause * 2, 10_000)) {
      try {
        await this.#connect(credential);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, pause).unref());
      }
    }
  }

  async offers(): Promise<Offer[]> {
    if (this.#filled === undefined) return [{ interface: ATTACH, routed: false }];
    return this.#offers;
  }

  onChange(listener: () => void): void {
    this.#listeners.push(listener);
  }

  async call(
    name: string,
    input: Record<string, unknown>,
    options: { progress?: (message: string) => void } = {},
  ): Promise<Answer> {
    if (this.#filled === undefined) {
      if (name !== ATTACH.name) return refused("invalid", "attach to your position first");
      return this.#attach(input);
    }
    const position = this.#position;
    if (position === undefined) {
      if (credentials.read(this.#filled) === undefined) {
        return refused("not_found", `no credential is kept for ${this.#filled}; was it closed?`);
      }
      return refused("unavailable", "the core is not reachable yet; try again shortly");
    }
    const wait = typeof input.wait === "number" ? input.wait : 0;
    const timeout = Math.max(DEFAULT_TIMEOUT_SECONDS, wait + MARGIN_SECONDS);
    try {
      const answer = await position.call(name, input, { ...options, timeoutMs: timeout * 1000 });
      await this.#refresh();
      return this.#withheld(name, answer);
    } catch (error) {
      return refused("unavailable", `the core did not answer: ${(error as Error).message}`);
    }
  }

  async close(): Promise<void> {
    await this.#position?.close();
  }

  async #attach(input: Record<string, unknown>): Promise<Answer> {
    const parsed = AttachRequest.safeParse(input);
    const request = parsed.data ?? {};
    const appointed = request.name !== undefined && request.purpose !== undefined;
    if (!parsed.success || (request.actor === undefined) === !appointed) {
      return refused("invalid", "give actor, or name and purpose");
    }
    let actor = request.actor;
    if (actor === undefined) {
      const created = await this.#createUnderRoot(
        request.name as string,
        request.purpose as string,
      );
      if (created.state !== "done") return created;
      actor = created.value as string;
    }
    const credential = credentials.read(actor);
    if (credential === undefined) {
      return refused(
        "not_found",
        `no credential is kept for ${actor}; is it the id your brief names?`,
      );
    }
    try {
      await this.#connect(credential);
    } catch (error) {
      const again = `attach with actor ${actor} to try again`;
      return refused(
        "unavailable",
        `the core did not accept ${actor}: ${(error as Error).message}; ${again}`,
      );
    }
    this.#filled = actor;
    if (this.#options.session !== undefined) sessions.fill(this.#options.session, actor);
    this.#changed();
    return { state: "done", value: { actor, created: request.actor === undefined } };
  }

  /**
   * Create the session's position under the root, marked as created at attach, with the root's
   * credential, used for that only.
   */
  async #createUnderRoot(name: string, purpose: string): Promise<Answer> {
    const file = rootCredentialPath();
    if (!existsSync(file)) return refused("not_found", `no root credential in ${file}`);
    const root = await connectClient({
      url: this.#options.coreUrl,
      credential: readPrivate(file),
      name: "agentorg-agent",
    });
    try {
      const answer = await root.call("actor_create", { name, purpose, created_at_attach: true });
      if (answer.state !== "done") return answer;
      const created = answer.value as ResponseOf<"actor_create">;
      credentials.write(created.actor.id, created.credential);
      return { state: "done", value: created.actor.id };
    } finally {
      await root.close();
    }
  }

  async #connect(credential: string): Promise<void> {
    const position = await connectActor({
      url: this.#options.coreUrl,
      credential,
      exposed: [],
      name: "agentorg-agent",
    });
    this.#position = position;
    this.#offers = await position.available();
    this.#changed();
  }

  /** List the offers again, since the core tells no caller when they change. */
  async #refresh(): Promise<void> {
    const offers = await this.#position?.available().catch(() => undefined);
    if (offers === undefined || JSON.stringify(offers) === JSON.stringify(this.#offers)) return;
    this.#offers = offers;
    this.#changed();
  }

  /** Keep a created position's credential, and forget a closed one's. */
  #withheld(name: string, answer: Answer): Answer {
    if (answer.state !== "done" || answer.call !== undefined) return answer;
    if (name === "actor_create") {
      const created = answer.value as ResponseOf<"actor_create">;
      credentials.write(created.actor.id, created.credential);
      const credential = `kept by agentorg for ${created.actor.id}; its session attaches with actor ${created.actor.id}`;
      return { ...answer, value: { ...created, credential } };
    }
    if (name === "actor_close") {
      credentials.remove((answer.value as ResponseOf<"actor_close">).actor.id);
    }
    return answer;
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}
