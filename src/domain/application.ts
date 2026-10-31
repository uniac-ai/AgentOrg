/** Validation, invocation and write audit for the explicit Hub Tool operations. */

import type { Audit } from "./audit.ts";
import { type Capabilities, descriptorsOf } from "./capabilities.ts";
import type { Connections } from "./connections.ts";
import type { Diagnostics } from "./diagnostics.ts";
import { Forbidden, invalid, NotFound, Refusal } from "./errors.ts";
import type { Answer, ToolDescriptor } from "./model/index.ts";
import { privateOperation } from "./model/system.ts";
import type { Invocation } from "./ports.ts";
import type { Registry } from "./registry.ts";

export function application(
  registry: Registry,
  capabilities: Capabilities,
  audit: Audit,
  connections: Connections,
  diagnostics: Diagnostics,
) {
  function available(actorId: string, connectionId?: string): ToolDescriptor[] {
    if (connectionId !== undefined) connections.assertActor(connectionId, actorId);
    return registry.found(actorId).closed_at === null ? descriptorsOf(capabilities.list()) : [];
  }
  async function invoke(
    actorId: string,
    name: string,
    input: Record<string, unknown>,
    how: Invocation,
  ): Promise<Answer> {
    const actor = registry.found(actorId);
    let release: (() => void) | undefined;
    let operationName: string | undefined;
    try {
      if (actor.closed_at !== null) throw new Forbidden("the Actor is closed");
      if (how.connectionId !== undefined)
        release = connections.beginInvocation(how.connectionId, actorId);
      const found = capabilities
        .list()
        .flatMap((tool) => tool.interfaces)
        .find((each) => each.offer.call === name);
      if (!found) {
        audit.record(actor.id, "call", null, "not_found");
        throw new NotFound(`there is no interface ${name}`);
      }
      const operation = found.operation;
      operationName = operation.name;
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
      if (operationName !== undefined && !privateOperation(operationName))
        diagnostics.record({
          code: "operation_failed",
          stage: "invocation",
          outcome: error instanceof Refusal ? "refused" : "unknown",
          actorId: actor.id,
          connectionId: how.connectionId,
          operation: operationName,
        });
      if (!(error instanceof Refusal))
        throw new Error("Hub operation failed; a write outcome may be unknown");
      return { state: "refused", code: error.code, message: error.message };
    } finally {
      release?.();
    }
  }
  return { available, invoke };
}

function targetOf(record: Record<string, unknown>): string | null {
  const { id, call, resource, actor, messageID, ticketID, formID, connectionId } = record as {
    id?: string;
    call?: string;
    resource?: string;
    actor?: string | { id: string };
    messageID?: string;
    ticketID?: string;
    formID?: string;
    connectionId?: string;
  };
  return (
    id ??
    connectionId ??
    messageID ??
    ticketID ??
    formID ??
    call ??
    resource ??
    (typeof actor === "string" ? actor : actor?.id) ??
    null
  );
}
