/** Request validation, dispatch, write audit and bounded waits over the available capabilities. */

import type { Audit } from "./audit.ts";
import type { CallRecord, Calls } from "./calls.ts";
import type { Capabilities, Capability } from "./capabilities.ts";
import type { Claims } from "./claims.ts";
import type { Communication } from "./communication.ts";
import type { Connections } from "./connections.ts";
import { Forbidden, Invalid, invalid, NotFound, Refusal } from "./errors.ts";
import {
  type Answer,
  BUILTINS,
  type BuiltinName,
  type Offer,
  type RequestOf,
  type ResponseOf,
} from "./model/index.ts";
import type { Invocation, Waiting } from "./ports.ts";
import type { Progress } from "./progress.ts";
import type { ActorRow, Registry } from "./registry.ts";
import { violation } from "./validation.ts";
import type { Views } from "./views.ts";

export interface Timing {
  /** How long a routed call waits for its result before it answers pending. */
  waitMs: number;
  /** How often a waiting call reports progress. */
  stepMs: number;
}

type Untyped = (actor: ActorRow, request: unknown, waiting: Waiting) => Promise<unknown>;

type Handlers = {
  [N in BuiltinName]: (
    actor: ActorRow,
    request: RequestOf<N>,
    waiting: Waiting,
  ) => Promise<ResponseOf<N>>;
};

export function application(
  registry: Registry,
  capabilities: Capabilities,
  calls: Calls,
  communication: Communication,
  claims: Claims,
  connections: Connections,
  progress: Progress,
  views: Views,
  audit: Audit,
  timing: Timing,
) {
  const handlers: Handlers = {
    actor_create: async (actor, request) => {
      const { actor: created, credential } = await registry.create(
        actor.id,
        request.name,
        request.purpose,
        request.created_at_attach,
      );
      return { actor: views.actor(created), credential };
    },

    actor_close: async (actor, request) => {
      const { actor: closed, changed } = registry.close(actor, request.actor);
      const ended = changed ? calls.endFor(closed, actor.id) : [];
      if (changed) await connections.disconnect(closed.id);
      return { actor: views.actor(closed), ended_calls: ended };
    },

    progress_set: async (actor, request) => progress.set(actor, request),
    question_ask: async (actor, request) => communication.ask(actor, request),
    question_answer: async (actor, request) => communication.answer(actor, request),
    questions: (actor, request, waiting) => communication.questions(actor, request, waiting),
    team: async (actor, request) => views.team(actor, request),
    progress: async (_actor, request) => views.progress(request),
    message_send: async (actor, request) => communication.send(actor, request),
    messages: (actor, request, waiting) => communication.messages(actor, request, waiting),
    message_read: async (actor, request) => communication.read(actor, request),
    claim: async (actor, request) => claims.claim(actor, request),
    release: async (actor, request) => claims.release(actor, request),

    call_result: async (actor, request, waiting) => {
      const call = calls.found(request.call);
      if (call.from !== actor.id) throw new Forbidden(`only its caller reads call ${call.id}`);
      return calls.wait(call.id, request.wait * 1000, waiting);
    },

    call_withdraw: async (actor, request) => calls.withdraw(actor, request.call),

    activity: async (_actor, request) => ({ entries: audit.list(request.since, request.limit) }),
  };

  function available(actorId: string): Offer[] {
    const actor = registry.found(actorId);
    return actor.closed_at === null ? capabilities.list(actor).map((each) => each.offer) : [];
  }

  async function invoke(
    actorId: string,
    name: string,
    input: Record<string, unknown>,
    how: Invocation,
  ): Promise<Answer> {
    const actor = registry.found(actorId);
    try {
      if (actor.closed_at !== null) throw new Forbidden("the Actor is closed");
      const found = capabilities.list(actor).find((each) => each.offer.interface.name === name);
      if (!found) {
        if (!Object.hasOwn(BUILTINS, name)) audit.record(actor.id, "call", null, "not_found");
        throw new NotFound(`there is no interface ${name}`);
      }
      return "builtin" in found
        ? await builtin(actor, found.builtin, input, how)
        : await routed(actor, found, input, how);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return { state: "refused", code: error.code, message: error.message };
    }
  }

  async function builtin(
    actor: ActorRow,
    name: BuiltinName,
    input: Record<string, unknown>,
    how: Invocation,
  ): Promise<Answer> {
    const spec = BUILTINS[name];
    const parsed = spec.request.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const waiting = {
      stepMs: timing.stepMs,
      signal: how.signal,
      progress: () => how.progress("waiting"),
    };
    let result: Record<string, unknown>;
    try {
      const handler = handlers[name] as Untyped;
      result = (await handler(actor, parsed.data, waiting)) as Record<string, unknown>;
    } catch (error) {
      if (spec.writes && error instanceof Refusal) {
        audit.record(actor.id, name, targetOf(input), error.code);
      }
      throw error;
    }
    if (spec.writes) audit.record(actor.id, name, targetOf(result), "ok");
    return { state: "done", value: result };
  }

  async function routed(
    actor: ActorRow,
    found: Capability & { to: string; interface: string },
    input: Record<string, unknown>,
    how: Invocation,
  ): Promise<Answer> {
    const { name, input: schema, one_way } = found.offer.interface;
    const problem = violation(schema, input);
    if (problem !== undefined) {
      audit.record(actor.id, "call", null, "invalid");
      throw new Invalid(`the input does not match the input schema of ${name}: ${problem}`);
    }
    const call = calls.create(actor, found.to, found.interface, input, how.cause);
    const waitMs = one_way ? 0 : timing.waitMs;
    const settled = await calls.wait(call.id, waitMs, {
      stepMs: timing.stepMs,
      signal: how.signal,
      progress: () => how.progress(`waiting for ${name}`),
    });
    return answerOf(settled);
  }
  return { available, invoke };
}

/** The record a write acted on, as its request or result names it. */
function targetOf(record: Record<string, unknown>): string | null {
  const { id, call, resource, actor } = record as {
    id?: string;
    call?: string;
    resource?: string;
    actor?: string | { id: string };
  };
  return id ?? call ?? resource ?? (typeof actor === "string" ? actor : actor?.id) ?? null;
}

/** A routed call's answer for its caller: the called actor's own result once done. */
function answerOf(call: CallRecord): Answer {
  switch (call.state) {
    case "done":
      return {
        state: "done",
        call: call.id,
        value: call.output?.value ?? null,
        parts: call.output?.parts ?? [],
      };
    case "pending":
      return { state: "pending", call: call.id };
    case "failed":
      return { state: "failed", call: call.id, error: call.error ?? "" };
    case "withdrawn":
      return { state: "withdrawn", call: call.id };
  }
}
