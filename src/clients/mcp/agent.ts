/**
 * The session's stable attach, interfaces and call tools. Listing and invocation use the
 * attached position's actor client. A credential that
 * `actor_create` returns is kept in the credential store, and the session sees that it was kept,
 * never the credential. Workspace record authority remains with the Hub and package clients.
 */

import { existsSync } from "node:fs";
import { z } from "zod";
import {
  type Actor,
  connectClient,
  type PresentationOptions,
  type Presented,
} from "../../actor/index.ts";
import {
  type Answer,
  Handle,
  Id,
  type InterfaceDescriptor,
  Level,
  objectSchema,
  type ResponseOf,
  Text,
  type ToolDescriptor,
} from "../../domain/model/index.ts";
import { credentials, readPrivate, rootActorPath, rootCredentialPath } from "../../home.ts";
import { sessionName, sessions } from "./sessions.ts";

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
  description: `Fill your position in the organization before listing or calling Hub Tools. A resumed session can acknowledge its same actor; an attached session cannot change actors.

Give actor, the id your brief names. A session the user started with an appointment, naming no position, gives name and purpose instead, once: that creates its position directly under the user. Then team shows your position, your manager and your reports.`,
  input: objectSchema(AttachRequest, "input"),
  output: objectSchema(Attached, "output"),
  one_way: false,
  long_running: false,
};

const CallRequest = z.strictObject({
  name: Text.describe("The interface's call alias returned by interfaces."),
  input: z.record(z.string(), z.unknown()).describe("Input matching that interface's schema."),
});

const InterfacesRequest = z.strictObject({
  name: Text.optional().describe("An interface's call alias, to read its description and schemas."),
});

const INTERFACES: InterfaceDescriptor = {
  name: "interfaces",
  description:
    "List the Hub interfaces this session presents, each with its call alias and a one-line summary. Give name to read one interface's description and input/output schemas before calling an operation whose contract you have not read.",
  input: objectSchema(InterfacesRequest, "input"),
  one_way: false,
  long_running: false,
};

const CALL: InterfaceDescriptor = {
  name: "call",
  description:
    "Invoke a Hub interface as the attached Actor. Use its call alias as name and its input schema from interfaces. The Hub applies the operation's authority and validates its input.",
  input: objectSchema(CallRequest, "input"),
  one_way: false,
  long_running: false,
};

/** What the session's client may show its model about the agent actor's tools as a whole. */
export const INSTRUCTIONS = `These tools make this session a position in an AgentOrg organization: a responsibility with a manager, under the user. Attach before any other action, with the actor id the brief names, or with a name and purpose when the user started the session with no position named. Then use interfaces to list the Hub interfaces this session presents, interfaces {name} to read one's schemas, and call with {name, input} to invoke one. Logical names such as status_set, work_update and form_create are operations through call. How to work in a position is the agentorg skill; without it, read https://github.com/uniac-ai/AgentOrg/blob/main/skills/agentorg/SKILL.md.`;

const refused = (code: string, message: string): Answer => ({ state: "refused", code, message });

export interface AgentOptions {
  coreUrl: string;
  /** The client session this agent serves, when the client names one; it remembers the position. */
  session: string | undefined;
  /** A client that identifies its session on each call instead of at process startup. */
  client?: string;
  /** The organization level whose interfaces `interfaces` presents. */
  level: Level;
}

/** Whether an interface tagged `tag` is presented at `level`; each level contains the one before. */
const presents = (level: Level, tag: Level | undefined) =>
  Level.options.indexOf(tag ?? "organization") <= Level.options.indexOf(level);

export class Agent implements Presented {
  readonly instructions = INSTRUCTIONS;
  readonly #options: AgentOptions;
  #position: Actor | undefined;
  /** Set once the session has filled a position, which `attach` never changes. */
  #filled: string | undefined;
  #session: string | undefined;
  #attaching = false;

  constructor(options: AgentOptions) {
    this.#options = options;
    this.#session = options.session;
    if (this.#session !== undefined) this.#filled = sessions.position(this.#session);
  }

  /** Connect the position this session filled before, if it did; retried until the core answers. */
  async resume(): Promise<void> {
    const actor = this.#filled;
    if (actor === undefined) return;
    const credential = credentials.read(actor);
    if (credential === undefined) return;
    for (let pause = 250; this.#position === undefined; pause = Math.min(pause * 2, 10_000)) {
      try {
        await this.#connect(actor, credential);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, pause).unref());
      }
    }
  }

  async offers(): Promise<ToolDescriptor[]> {
    return [
      {
        id: "agentorg",
        name: "agentorg",
        interfaces: [ATTACH, INTERFACES, CALL].map((descriptor) => ({
          interface: descriptor,
          call: descriptor.name,
          read_only: descriptor === INTERFACES,
        })),
      },
    ];
  }

  onChange(): void {
    // The adapter's catalog is fixed; interfaces reads the current Hub Tools.
  }

  async call(
    name: string,
    input: Record<string, unknown>,
    options: PresentationOptions = {},
  ): Promise<Answer> {
    const identity = await this.#identify(options.session);
    if (identity !== undefined) return identity;
    if (this.#filled === undefined) {
      if (name !== ATTACH.name) return refused("invalid", "attach to your position first");
      if (this.#attaching) return refused("unavailable", "an attachment is already in progress");
      this.#attaching = true;
      try {
        return await this.#attach(input);
      } finally {
        this.#attaching = false;
      }
    }
    const position = this.#position;
    if (position === undefined) {
      if (credentials.read(this.#filled) === undefined) {
        return refused("not_found", `no credential is kept for ${this.#filled}; was it closed?`);
      }
      return refused("unavailable", "the core is not reachable yet; try again shortly");
    }
    if (position.ended !== undefined) {
      return refused("unavailable", "this position's connection has ended");
    }
    if (name === ATTACH.name) {
      return input.actor === this.#filled && Object.keys(input).length === 1
        ? { state: "done", value: { actor: this.#filled, created: false } }
        : refused("forbidden", "this session already fills a position; it cannot change actors");
    }
    if (name === INTERFACES.name) {
      const request = InterfacesRequest.safeParse(input);
      if (!request.success) return refused("invalid", "interfaces takes an optional name");
      return this.#interfaces(position, request.data.name);
    }
    if (name !== CALL.name)
      return refused("not_found", `there is no adapter tool ${name}; use call`);
    const parsed = CallRequest.safeParse(input);
    if (!parsed.success) return refused("invalid", "call requires name and an input object");
    return this.#invoke(position, parsed.data.name, parsed.data.input, options);
  }

  async #invoke(
    position: Actor,
    name: string,
    input: Record<string, unknown>,
    options: PresentationOptions,
  ): Promise<Answer> {
    const answer = await position.call(name, input, { progress: options.progress });
    return this.#withheld(name, answer);
  }

  async close(): Promise<void> {
    await this.#position?.close();
  }

  /** The presented interfaces' aliases and summaries, or one interface's whole descriptor. */
  async #interfaces(position: Actor, name: string | undefined): Promise<Answer> {
    let tools: ToolDescriptor[];
    try {
      tools = await position.available();
    } catch {
      return refused("unavailable", "the Hub did not list available Tools");
    }
    const level = this.#options.level;
    const offers = tools.flatMap((tool) =>
      tool.interfaces.filter((offer) => presents(level, offer.level)),
    );
    if (name === undefined) {
      const summaryOf = (description = "") => description.split("\n\n")[0] ?? "";
      return {
        state: "done",
        value: {
          level,
          interfaces: offers.map((offer) => ({
            name: offer.call,
            summary: summaryOf(offer.interface.description),
          })),
        },
      };
    }
    const offer = offers.find((each) => each.call === name);
    if (offer === undefined)
      return refused("not_found", `${name} is not presented at the ${level} level`);
    const { description, input, output } = offer.interface;
    return {
      state: "done",
      value: {
        name,
        description,
        input,
        ...(output === undefined ? {} : { output }),
        read_only: offer.read_only,
      },
    };
  }

  /** Bind once from call context, then recover only that conversation's saved position. */
  async #identify(id: string | undefined): Promise<Answer | undefined> {
    const client = this.#options.client;
    if (client === undefined) return undefined;
    const session = sessionName(client, id);
    if (session === undefined) {
      return refused("invalid", "the client must identify its occupant session on every call");
    }
    if (this.#session !== undefined) {
      return this.#session === session
        ? undefined
        : refused("forbidden", "this adapter is bound to another occupant session");
    }
    this.#session = session;
    this.#filled = sessions.position(session);
    const actor = this.#filled;
    const credential = actor === undefined ? undefined : credentials.read(actor);
    if (actor !== undefined && credential !== undefined) {
      try {
        await this.#connect(actor, credential);
      } catch {
        void this.resume();
      }
    }
    return undefined;
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
      await this.#connect(actor, credential);
    } catch (error) {
      const again = `attach with actor ${actor} to try again`;
      return refused(
        "unavailable",
        `the core did not accept ${actor}: ${(error as Error).message}; ${again}`,
      );
    }
    this.#filled = actor;
    if (this.#session !== undefined) {
      sessions.fill(this.#session, actor);
      // Delivery starts from now: what happened before the session attached is not its input.
      // Without it, the waiter starts from whenever it first reads.
      const now = await this.#position?.call("attention", {}).catch(() => undefined);
      if (now?.state === "done")
        sessions.advanceInbox(this.#session, (now.value as { next: string }).next);
    }
    return { state: "done", value: { actor, created: request.actor === undefined } };
  }

  /**
   * Create the session's position under the root with the root's credential, used for that only.
   */
  async #createUnderRoot(name: string, purpose: string): Promise<Answer> {
    const file = rootCredentialPath();
    if (!existsSync(file)) return refused("not_found", `no root credential in ${file}`);
    const identity = rootActorPath();
    if (!existsSync(identity)) return refused("not_found", `no root actor id in ${identity}`);
    const root = await connectClient({
      url: this.#options.coreUrl,
      actorId: readPrivate(identity),
      credential: readPrivate(file),
      name: "agentorg-agent",
    });
    try {
      const answer = await root.call("actor_create", { name, purpose });
      if (answer.state !== "done") return answer;
      const created = answer.value as ResponseOf<"actor_create">;
      credentials.write(created.actor.id, created.credential);
      return { state: "done", value: created.actor.id };
    } finally {
      await root.close();
    }
  }

  async #connect(actorId: string, credential: string): Promise<void> {
    const position = await connectClient({
      url: this.#options.coreUrl,
      actorId,
      credential,
      name: "agentorg-agent",
    });
    this.#position = position;
  }

  /** Keep a created position's credential, and forget a closed one's. */
  #withheld(name: string, answer: Answer): Answer {
    if (answer.state !== "done") return answer;
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
}
