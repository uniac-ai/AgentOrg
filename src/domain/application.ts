/** Validation, invocation and write audit for the explicit Hub Tool operations. */

import type { Audit } from "./audit.ts";
import { type Capabilities, descriptorsOf } from "./capabilities.ts";
import { Forbidden, invalid, NotFound, Refusal } from "./errors.ts";
import type { Answer, ToolDescriptor } from "./model/index.ts";
import type { Invocation } from "./ports.ts";
import type { Registry } from "./registry.ts";

export function application(registry: Registry, capabilities: Capabilities, audit: Audit) {
  function available(actorId: string): ToolDescriptor[] {
    return registry.found(actorId).closed_at === null ? descriptorsOf(capabilities.list()) : [];
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
      const found = capabilities
        .list()
        .flatMap((tool) => tool.interfaces)
        .find((each) => each.offer.call === name);
      if (!found) {
        audit.record(actor.id, "call", null, "not_found");
        throw new NotFound(`there is no interface ${name}`);
      }
      const operation = found.operation;
      const spec = operation.definition;
      const parsed = spec.request.safeParse(input);
      if (!parsed.success) throw invalid(parsed.error.issues);
      let result: Record<string, unknown>;
      try {
        result = (await operation.invoke(actor, parsed.data, how)) as Record<string, unknown>;
      } catch (error) {
        if (spec.writes && error instanceof Refusal)
          audit.record(actor.id, name, targetOf(input), error.code);
        throw error;
      }
      if (spec.writes) audit.record(actor.id, name, targetOf(result), "ok");
      return { state: "done", value: result };
    } catch (error) {
      if (!(error instanceof Refusal))
        throw new Error("Hub operation failed; a write outcome may be unknown");
      return { state: "refused", code: error.code, message: error.message };
    }
  }
  return { available, invoke };
}

function targetOf(record: Record<string, unknown>): string | null {
  const { id, call, resource, actor, messageID, ticketID, formID } = record as {
    id?: string;
    call?: string;
    resource?: string;
    actor?: string | { id: string };
    messageID?: string;
    ticketID?: string;
    formID?: string;
  };
  return (
    id ??
    messageID ??
    ticketID ??
    formID ??
    call ??
    resource ??
    (typeof actor === "string" ? actor : actor?.id) ??
    null
  );
}
