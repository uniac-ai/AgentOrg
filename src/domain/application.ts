/** Request validation, dispatch, write audit and bounded waits over the available capabilities. */

import { violation } from "../schema.ts";
import type { Audit } from "./audit.ts";
import type { CallRecord, Calls } from "./calls.ts";
import { type Capabilities, type Capability, descriptorsOf } from "./capabilities.ts";
import { Forbidden, Invalid, invalid, NotFound, Refusal } from "./errors.ts";
import type { Answer, ToolDescriptor } from "./model/index.ts";
import type { Invocation } from "./ports.ts";
import type { ActorRow, Registry } from "./registry.ts";
import type { Operation } from "./tools.ts";

export interface Timing {
  /** How long a routed call waits for its result before it answers pending. */
  waitMs: number;
  /** How often a waiting call reports progress. */
  stepMs: number;
}

export function application(
  registry: Registry,
  capabilities: Capabilities,
  calls: Calls,
  audit: Audit,
  timing: Timing,
) {
  function available(actorId: string): ToolDescriptor[] {
    return descriptorsOf(capabilities.list(registry.found(actorId)));
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
      const exposed = capabilities.list(actor);
      const found = exposed
        .map((tool) => tool.interfaces.find((each) => each.offer.call === name))
        .find((each) => each !== undefined);
      if (!found) {
        if (!capabilities.known(name)) audit.record(actor.id, "call", null, "not_found");
        throw new NotFound(`there is no interface ${name}`);
      }
      return "operation" in found
        ? await local(actor, found.operation, input, how, descriptorsOf(exposed))
        : await routed(actor, found, input, how);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return { state: "refused", code: error.code, message: error.message };
    }
  }

  async function local(
    actor: ActorRow,
    operation: Operation,
    input: Record<string, unknown>,
    how: Invocation,
    catalog: ToolDescriptor[],
  ): Promise<Answer> {
    const { name, definition: spec } = operation;
    const parsed = spec.request.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const waiting = {
      stepMs: timing.stepMs,
      signal: how.signal,
      progress: () => how.progress("waiting"),
    };
    let result: Record<string, unknown>;
    try {
      result = (await operation.invoke(actor, parsed.data, { ...waiting, catalog })) as Record<
        string,
        unknown
      >;
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
    found: Capability & { to: string },
    input: Record<string, unknown>,
    how: Invocation,
  ): Promise<Answer> {
    const { input: schema, one_way } = found.offer.interface;
    const name = found.offer.call;
    const problem = violation(schema, input);
    if (problem !== undefined) {
      audit.record(actor.id, "call", null, "invalid");
      throw new Invalid(`the input does not match the input schema of ${name}: ${problem}`);
    }
    const call = calls.create(actor, found.to, found.offer.interface.name, input, how.cause);
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
