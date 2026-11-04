/**
 * What concerns an Actor, read from the audited writes after its position, by the next mover
 * (model §2). On its records: Work given to it or changed by its requester, an answer to its
 * submission, an answer to its ask or the ask's raise, and a message to it. Routed to it: an ask
 * from a report or raised to it while the ask is open and with it, and a submission of Work it
 * requested while the submission waits. A read that finds nothing waits for the next audited
 * write, up to `wait` seconds.
 */

import type { WorkspaceClients } from "@uniac/agentic-workspace";
import type { Form, Work } from "@uniac/agentic-workspace/contracts";
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
type Entry = AuditRow & { actor: string; target: string };
type Event = NonNullable<Work["history"]>[number];

/** A value worked out the first time it is asked for. */
function once<T>(make: () => T): () => T {
  let made: { value: T } | undefined;
  return () => {
    made ??= { value: make() };
    return made.value;
  };
}

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

  /**
   * The history event an entry wrote: the writer's events on its record, counted back from the
   * newest by the writer's later Work and ask writes on it. Asks cancelled with their Work (Q12)
   * have an event but no entry of their own, so they are passed over. A counted event later than
   * the entry, as when an earlier entry was lost, gives way to the writer's last event before it.
   */
  function eventOf(entry: Entry, history: Event[] | undefined): Event | undefined {
    const own = (history ?? []).filter(
      (event) =>
        event.actorID === entry.actor &&
        !(event.action === "cancelled" && "reason" in event.detail),
    );
    const counted = own.at(-1 - audit.writesAfter(entry.id, entry.actor, entry.target));
    return counted && counted.at <= entry.at
      ? counted
      : own.findLast((event) => event.at <= entry.at);
  }

  /** The Actor an open ask waits on: its last raiser's, else its asker's, nearest open manager. */
  function routeOf(ask: Form): string | undefined {
    const origin = ask.raises.at(-1)?.actorID ?? ask.requesterID;
    const manager = registry.get(origin)?.manager;
    return ask.status === "open" && manager ? registry.standIn(manager) : undefined;
  }

  /** The Work's owner just before `event`: the last owner an earlier event gave it, else its creator. */
  function ownerBefore(work: Work, event: Event): string | undefined {
    let owner: string | undefined;
    for (const each of work.history ?? []) {
      if (each === event) return owner;
      const given = each.detail.ownerID;
      owner = typeof given === "string" ? given : (owner ?? each.actorID);
    }
    return owner;
  }

  /** Asks and Work as the caller reads them, with history, each read once per `attention` read. */
  function reader(caller: ActorRow) {
    const asks = new Map<string, Form | undefined>();
    const works = new Map<string, Work | undefined>();
    return {
      ask(id: string) {
        if (!asks.has(id)) {
          const found = read(caller, (clients) => clients.work.get({ askID: id, history: true }));
          if (found && !("formID" in found)) works.set(found.ticketID, found);
          asks.set(
            id,
            found && ("formID" in found ? found : found.asks?.find((each) => each.formID === id)),
          );
        }
        return asks.get(id);
      },
      work(id: string) {
        if (!works.has(id))
          works.set(
            id,
            read(caller, (clients) => {
              const found = clients.work.get({ ticketID: id, history: true });
              return "formID" in found ? undefined : found;
            }),
          );
        return works.get(id);
      },
      /** The open asks routed to the caller, and submitted Work requested in its branch. */
      routed: once(() =>
        all(caller, (clients, after) =>
          clients.work.asks({ routedTo: caller.id, limit: 100, after }),
        ),
      ),
      submitted: once(() =>
        all(caller, (clients, after) =>
          clients.work.list({
            requesterWithin: caller.id,
            status: ["submitted"],
            limit: 100,
            after,
          }),
        ),
      ),
    };
  }

  /** Every page of a list the caller reads; none where it can't read it. */
  function all<T>(
    caller: ActorRow,
    page: (
      clients: WorkspaceClients,
      after: string | undefined,
    ) => { items: T[]; next: string | null },
  ): T[] {
    const items: T[] = [];
    for (let after: string | undefined; ; ) {
      const found = read(caller, (clients) => page(clients, after));
      if (found === undefined) return items;
      items.push(...found.items);
      if (found.next === null) return items;
      after = found.next;
    }
  }

  /** Whether the walk from `actorID` up to its nearest open Actor passes `closed`. */
  function through(actorID: string | null | undefined, closed: string): boolean {
    for (let at = actorID ? registry.get(actorID) : undefined; at; ) {
      if (at.id === closed) return true;
      if (at.closed_at === null) return false;
      at = at.manager === null ? undefined : registry.get(at.manager);
    }
    return false;
  }

  /** What one entry did: the parties and records it touched, and the item it makes, if any. */
  function factOf(caller: ActorRow, entry: Entry, reads: ReturnType<typeof reader>) {
    const touched = {
      actorIDs: [] as (string | null | undefined)[],
      workIDs: [] as string[],
      conversationIDs: [] as string[],
    };
    let kind: Item["kind"] | undefined;
    let title = "";
    const items: { kind: Item["kind"]; title: string; recordID: string }[] = [];
    const id = entry.target;
    if (entry.operation === "message_send") {
      const message = read(caller, (clients) => clients.messages.get({ messageID: id }));
      if (message) {
        touched.actorIDs.push(message.senderID, message.recipientID);
        touched.conversationIDs.push(message.conversationID);
        if (message.recipientID === caller.id) kind = "message";
        title = (message.text.split("\n")[0] ?? "").slice(0, 120);
      }
    } else if (entry.operation === "actor_create" || entry.operation === "actor_close") {
      touched.actorIDs.push(id, registry.get(id)?.manager);
      // A closed Actor's part passes to its nearest open manager (Q10): what was routed to it,
      // or on its way through it, is the caller's now.
      if (entry.operation === "actor_close" && registry.standIn(id) === caller.id) {
        for (const ask of reads.routed())
          if (through(registry.get(ask.raises.at(-1)?.actorID ?? ask.requesterID)?.manager, id))
            items.push({ kind: "ask", title: ask.title, recordID: ask.formID });
        for (const work of reads.submitted())
          if (through(work.requesterID, id))
            items.push({ kind: "review_due", title: work.title, recordID: work.ticketID });
      }
    } else if (entry.operation.startsWith("work_")) {
      // An ask is written by work_update and work_answer with the ask as the entry's target.
      const ask =
        entry.operation === "work_update" || entry.operation === "work_answer"
          ? reads.ask(id)
          : undefined;
      const work = ask ? undefined : reads.work(id);
      if (ask) {
        touched.actorIDs.push(ask.requesterID);
        if (ask.workID) touched.workIDs.push(ask.workID);
        title = ask.title;
        const action = eventOf(entry, ask.history)?.action;
        const asker = ask.requesterID === caller.id;
        const routed = routeOf(ask) === caller.id;
        // Once raised, the ask reaches its route from the raise that sent it there.
        if (action === "created" && routed && ask.raises.length === 0) kind = "ask";
        else if (action === "responded" && asker) kind = "answer";
        else if (action === "raised") {
          const raisedTo = registry.get(entry.actor)?.manager;
          if (asker) kind = "raised";
          else if (routed && raisedTo && registry.standIn(raisedTo) === caller.id) kind = "ask";
        }
      } else if (work) {
        const event = eventOf(entry, work.history);
        const before = event && ownerBefore(work, event);
        touched.workIDs.push(id);
        touched.actorIDs.push(work.ownerID, work.requesterID, before);
        title = work.title;
        const owns = work.ownerID === caller.id;
        if (entry.operation === "work_create" && owns) kind = "assigned";
        // Only its requester, or the requester's stand-in, edits Work on another Actor: giving it
        // to the caller is assigned, and an edit that leaves it the caller's is updated.
        if (entry.operation === "work_update" && owns && event) {
          const given = event.detail.ownerID;
          if ((typeof given === "string" ? given : before) === caller.id)
            kind = before === caller.id ? "updated" : "assigned";
        }
        if (
          entry.operation === "work_submit" &&
          work.status === "submitted" &&
          registry.standIn(work.requesterID) === caller.id
        )
          kind = "review_due";
        // Submitted Work stays as it is until answered, so its owner then made the submission.
        if (entry.operation === "work_answer" && event && before === caller.id) kind = "reviewed";
      }
    }
    if (kind) items.push({ kind, title, recordID: id });
    return { touched, items };
  }

  function examine(caller: ActorRow, entries: AuditRow[]): Omit<Result, "next"> {
    const items = new Map<string, Item>();
    const actorIDs = new Set<string>();
    const workIDs = new Set<string>();
    const conversationIDs = new Set<string>();
    const reads = reader(caller);
    for (const entry of entries) {
      const { actor, target } = entry;
      if (entry.outcome !== "ok" || actor === null || target === null) continue;
      const operation = RENAMED[entry.operation] ?? entry.operation;
      const { touched, items: made } = factOf(
        caller,
        { ...entry, operation, actor, target },
        reads,
      );
      for (const each of touched.actorIDs) if (each) actorIDs.add(each);
      for (const each of touched.workIDs) workIDs.add(each);
      for (const each of touched.conversationIDs) conversationIDs.add(each);
      if (actor === caller.id) continue;
      for (const item of made) {
        // One item per kind and record; a collecting ask's answers, one per responder.
        const key = `${item.kind}:${item.recordID}${item.kind === "answer" ? `:${actor}` : ""}`;
        if (items.has(key)) continue;
        items.set(key, {
          kind: item.kind,
          recordID: item.recordID,
          from: { actorID: actor, name: registry.get(actor)?.name ?? actor },
          title: item.title,
          at: entry.at,
        });
      }
    }
    return {
      items: [...items.values()],
      changed: {
        actorIDs: [...actorIDs],
        workIDs: [...workIDs],
        conversationIDs: [...conversationIDs],
      },
    };
  }

  return {
    tool: bindTool(ATTENTION, {
      attention: async (caller, request, how) => {
        const head = audit.head();
        if (request.since === undefined)
          return {
            items: [],
            changed: { actorIDs: [], workIDs: [], conversationIDs: [] },
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
