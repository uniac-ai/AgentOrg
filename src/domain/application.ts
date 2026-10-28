/**
 * What an actor may do: its available interfaces, and what calling one does. A built-in runs at
 * once. Another actor's interface becomes a routed call: its input is checked against that
 * interface's input schema, the call is recorded and delivered, and the caller waits for a bounded
 * time, with progress, for its result. A call still pending then answers pending, as does a call
 * into a one-way interface at once, and the caller reads it later with `call_result`.
 */

import type { Audit } from "./audit.ts";
import type { Handlers, Waiting } from "./builtins.ts";
import type { CallRecord, Calls } from "./calls.ts";
import { Invalid, invalid, NotFound, Refusal } from "./errors.ts";
import {
  type Answer,
  BUILTIN_NAMES,
  BUILTINS,
  type BuiltinName,
  type Offer,
  objectSchema,
} from "./model/index.ts";
import type { Application, Invocation } from "./ports.ts";
import type { ActorRow, Registry } from "./registry.ts";
import { violation } from "./validation.ts";
import { route, routes } from "./wiring.ts";

export interface Timing {
  /** How long a routed call waits for its result before it answers pending. */
  waitMs: number;
  /** How often a waiting call reports progress. */
  stepMs: number;
}

const BUILTIN_OFFERS: Record<BuiltinName, Offer> = Object.fromEntries(
  BUILTIN_NAMES.map((name) => [
    name,
    {
      interface: {
        name,
        description: BUILTINS[name].description,
        input: objectSchema(BUILTINS[name].request, "input"),
        output: objectSchema(BUILTINS[name].response, "output"),
        one_way: false,
        long_running: false,
      },
      routed: false,
      read_only: !BUILTINS[name].writes,
    },
  ]),
) as Record<BuiltinName, Offer>;

const isBuiltin = (name: string): name is BuiltinName => Object.hasOwn(BUILTINS, name);

type Untyped = (actor: ActorRow, request: unknown, waiting: Waiting) => Promise<unknown>;

export class AvailableInterfaces implements Application {
  private readonly registry: Registry;
  private readonly calls: Calls;
  private readonly handlers: Handlers;
  private readonly audit: Audit;
  private readonly timing: Timing;

  constructor(registry: Registry, calls: Calls, handlers: Handlers, audit: Audit, timing: Timing) {
    this.registry = registry;
    this.calls = calls;
    this.handlers = handlers;
    this.audit = audit;
    this.timing = timing;
  }

  available(actorId: string): Offer[] {
    const actor = this.registry.found(actorId);
    const own = BUILTIN_NAMES.filter((name) => !BUILTINS[name].rootOnly || actor.manager === null);
    const routed = routes(this.registry, actor).map(({ name, interface: offered }) => ({
      interface: { ...offered, name },
      routed: true,
    }));
    return [...own.map((name) => BUILTIN_OFFERS[name]), ...routed];
  }

  async invoke(
    actorId: string,
    name: string,
    input: Record<string, unknown>,
    how: Invocation,
  ): Promise<Answer> {
    const actor = this.registry.found(actorId);
    try {
      return isBuiltin(name)
        ? await this.builtin(actor, name, input, how)
        : await this.routed(actor, name, input, how);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return { state: "refused", code: error.code, message: error.message };
    }
  }

  private async builtin(
    actor: ActorRow,
    name: BuiltinName,
    input: Record<string, unknown>,
    how: Invocation,
  ): Promise<Answer> {
    const spec = BUILTINS[name];
    if (spec.rootOnly && actor.manager !== null)
      throw new NotFound(`there is no interface ${name}`);
    const parsed = spec.request.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const waiting = {
      stepMs: this.timing.stepMs,
      signal: how.signal,
      progress: () => how.progress("waiting"),
    };
    let result: Record<string, unknown>;
    try {
      const handler = this.handlers[name] as Untyped;
      result = (await handler(actor, parsed.data, waiting)) as Record<string, unknown>;
    } catch (error) {
      if (spec.writes && error instanceof Refusal) {
        this.audit.record(actor.id, name, targetOf(input), error.code);
      }
      throw error;
    }
    if (spec.writes) this.audit.record(actor.id, name, targetOf(result), "ok");
    return { state: "done", value: result };
  }

  private async routed(
    actor: ActorRow,
    name: string,
    input: Record<string, unknown>,
    how: Invocation,
  ): Promise<Answer> {
    const found = route(this.registry, actor, name);
    const refuse = (refusal: Refusal) => {
      this.audit.record(actor.id, "call", null, refusal.code);
      return refusal;
    };
    if (!found) throw refuse(new NotFound(`there is no interface ${name}`));
    const problem = violation(found.interface.input, input);
    if (problem !== undefined) {
      throw refuse(new Invalid(`the input does not match the input schema of ${name}: ${problem}`));
    }
    const call = this.calls.create(actor, found, input, how.cause);
    const waitMs = found.interface.one_way ? 0 : this.timing.waitMs;
    const settled = await this.calls.wait(call.id, waitMs, {
      stepMs: this.timing.stepMs,
      signal: how.signal,
      progress: () => how.progress(`waiting for ${name}`),
    });
    return answerOf(settled);
  }
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
