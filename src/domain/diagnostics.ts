/** Bounded run-local observations with a fixed whitelist and no private Message events. */
import { Diagnostic, privateOperation } from "./model/system.ts";

type Observation = Omit<Diagnostic, "at" | "message">;
const messages: Record<Diagnostic["code"], string> = {
  admission_refused: "Connection admission was refused.",
  admission_failed: "Connection admission could not complete.",
  mcp_initialization_failed: "Hub MCP initialization failed.",
  protocol_invalid: "An invalid protocol message was observed.",
  provider_unavailable: "The Provider creation path was unavailable.",
  execution_failed: "Provider creation was not sent or was refused.",
  execution_outcome_unknown: "The Provider creation outcome is unknown.",
  operation_failed: "A Hub operation could not complete.",
  connection_closed: "A Hub transport connection ended.",
};
export function diagnostics(now: () => string) {
  const items: Diagnostic[] = [];
  let dropped = 0;
  return {
    record(event: Observation): void {
      try {
        if (privateOperation(event.operation ?? "")) return;
        const parsed = Diagnostic.safeParse({
          at: now(),
          code: event.code,
          stage: event.stage,
          outcome: event.outcome,
          message: messages[event.code],
          actorId: event.actorId,
          providerId: event.providerId,
          connectionId: event.connectionId,
          operation: event.operation,
          closeCode: event.closeCode,
        });
        if (!parsed.success) return;
        if (items.length === 100) {
          items.shift();
          dropped += 1;
        }
        items.push(parsed.data);
      } catch {
        /* Observation cannot change a business outcome. */
      }
    },
    read(limit: number) {
      return {
        items: items.slice(-limit).reverse(),
        capacity: 100 as const,
        retained: items.length,
        dropped,
        scope: "this_run" as const,
      };
    },
  };
}
export type Diagnostics = ReturnType<typeof diagnostics>;
