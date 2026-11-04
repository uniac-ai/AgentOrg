/**
 * What concerns an Actor, read from the audited writes after its position: answers to its asks,
 * new asks from its direct reports, Work assigned to it, reviews due and done, and Messages to it.
 * A read that finds nothing waits for the next audited write, up to `wait` seconds.
 */

import type { WorkspaceClients } from "@uniac/agentic-workspace";
import type { Form } from "@uniac/agentic-workspace/contracts";
import type { Audit } from "./audit.ts";
import { Invalid, Refusal } from "./errors.ts";
import { ATTENTION, type ResponseOf } from "./model/index.ts";
import type { ActorRow, AuditRow } from "./ports.ts";
import type { Registry } from "./registry.ts";
import { bindTool } from "./tools.ts";
import type { Workspace } from "./workspace.ts";

export { ATTENTION as definition } from "./model/index.ts";

type Result = ResponseOf<"attention">;
type Item = Result["items"][number];

/** The audit entries one read examines; a full batch returns at once and the next read goes on. */
const BATCH = 500;
/** The operations 0.5.0 audited, as the writes that replace them, so a resumed read keeps them. */
const RENAMED: Record<string, string> = {
  form_create: "work_update",
  form_close: "work_update",
  form_respond: "work_answer",
  work_review: "work_answer",
};

export function attention(registry: Registry, audit: Audit, workspace: Workspace) {
  /** A record the caller can read, or undefined where it can't. */
  function read<T>(caller: ActorRow, operation: (clients: WorkspaceClients) => T): T | undefined {
    try {
      return workspace.run(caller, operation);
    } catch (error) {
      if (error instanceof Refusal) return undefined;
      throw error;
    }
  }

  /** The ask with this ID, if it is one the caller can read. */
  function askOf(caller: ActorRow, id: string) {
    return read(caller, (clients) => {
      const found = clients.work.get({ askID: id });
      return "formID" in found ? found : found.asks?.find((ask) => ask.formID === id);
    });
  }

  /** The item an entry by another Actor makes for the caller, if any. */
  function itemOf(
    caller: ActorRow,
    entry: AuditRow & { actor: string; target: string },
    ask: Form | undefined,
  ) {
    const id = entry.target;
    const work = (history = false) =>
      read(caller, (clients) => {
        const found = clients.work.get({ ticketID: id, history });
        return "formID" in found ? undefined : found;
      });
    switch (entry.operation) {
      case "work_create": {
        const created = work();
        return created?.ownerID === caller.id
          ? { kind: "assigned" as const, title: created.title }
          : undefined;
      }
      case "work_update": {
        // A new ask is for the asker's manager; a closed one makes nothing.
        if (ask)
          return ask.status === "open" && registry.get(entry.actor)?.manager === caller.id
            ? { kind: "ask" as const, title: ask.title }
            : undefined;
        // Only its requester reassigns Work; its latest edit names the owner it gave.
        const updated = work();
        if (updated?.ownerID !== caller.id || updated.requesterID !== entry.actor) return undefined;
        const edit = work(true)?.history?.findLast((each) => each.actorID === entry.actor);
        return edit?.detail.ownerID === caller.id
          ? { kind: "assigned" as const, title: updated.title }
          : undefined;
      }
      case "work_submit": {
        const submitted = work();
        return submitted?.requesterID === caller.id && submitted.status === "submitted"
          ? { kind: "review_due" as const, title: submitted.title }
          : undefined;
      }
      case "work_answer": {
        // An answer to an ask is the asker's; a raise, by an Actor with no answer on it, is the
        // raiser's manager's; an answer to a submission is the owner's review.
        if (ask && Object.hasOwn(ask.responses, entry.actor))
          return ask.requesterID === caller.id
            ? { kind: "answer" as const, title: ask.title }
            : undefined;
        if (ask)
          return ask.status === "open" && registry.get(entry.actor)?.manager === caller.id
            ? { kind: "ask" as const, title: ask.title }
            : undefined;
        const reviewed = work();
        return reviewed?.ownerID === caller.id
          ? { kind: "reviewed" as const, title: reviewed.title }
          : undefined;
      }
      case "message_send": {
        const message = read(caller, (clients) => clients.messages.get({ messageID: id }));
        return message?.recipientID === caller.id
          ? { kind: "message" as const, title: (message.text.split("\n")[0] ?? "").slice(0, 120) }
          : undefined;
      }
      default:
        return undefined;
    }
  }

  function examine(caller: ActorRow, entries: AuditRow[]): Omit<Result, "next"> {
    const items = new Map<string, Item>();
    const workIDs = new Set<string>();
    const formIDs = new Set<string>();
    for (const audited of entries) {
      const entry = { ...audited, operation: RENAMED[audited.operation] ?? audited.operation };
      const { actor, target } = entry;
      if (entry.outcome !== "ok" || actor === null || target === null) continue;
      // Asks are written through work_update and work_answer, with the ask as the target.
      const ask =
        entry.operation === "work_update" || entry.operation === "work_answer"
          ? askOf(caller, target)
          : undefined;
      if (ask) formIDs.add(target);
      else if (entry.operation.startsWith("work_")) workIDs.add(target);
      if (actor === caller.id) continue;
      const found = itemOf(caller, { ...entry, actor, target }, ask);
      if (found === undefined || items.has(`${found.kind}:${target}`)) continue;
      items.set(`${found.kind}:${target}`, {
        kind: found.kind,
        recordID: target,
        from: { actorID: actor, name: registry.get(actor)?.name ?? actor },
        title: found.title,
        at: entry.at,
      });
    }
    return {
      items: [...items.values()],
      changed: { actorIDs: [], workIDs: [...workIDs], formIDs: [...formIDs] },
    };
  }

  return {
    tool: bindTool(ATTENTION, {
      attention: async (caller, request, how) => {
        const head = audit.head();
        if (request.since === undefined)
          return {
            items: [],
            changed: { actorIDs: [], workIDs: [], formIDs: [] },
            next: `${head}`,
          };
        let position = Number(request.since);
        if (position > head) throw new Invalid("since: beyond this Hub's position");
        const deadline = Date.now() + request.wait * 1000;
        for (;;) {
          const entries = audit.list(position, BATCH);
          position = entries.at(-1)?.id ?? position;
          const found = examine(caller, entries);
          const remaining = deadline - Date.now();
          const changed = Object.values(found.changed).some((ids) => ids.length > 0);
          if (found.items.length > 0 || changed || entries.length === BATCH || remaining <= 0)
            return { ...found, next: `${position}` };
          if (how.signal.aborted) return { ...found, next: `${position}` };
          // No await separates the read above from waiting here, so no write slips between.
          await audit.next(how.signal, remaining);
        }
      },
    }),
  };
}
