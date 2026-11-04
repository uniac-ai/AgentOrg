/** Organization hierarchy, actual admitted connection presence and each Actor's report. */

import { type Form, type Work, WorkspaceError } from "@uniac/agentic-workspace/contracts";
import type { Actors } from "./actors.ts";
import type { Audit } from "./audit.ts";
import { type RequestOf, type ResponseOf, TEAM } from "./model/index.ts";
import type { ActorRow } from "./ports.ts";
import type { Registry } from "./registry.ts";
import { bindTool } from "./tools.ts";
import type { Workspace } from "./workspace.ts";

export { TEAM as definition } from "./model/index.ts";

type View = ResponseOf<"actor_view">;
type Position = ResponseOf<"team">["positions"][number];
type Headline = Position["headline"];
/** A Work's state: done, review, waiting on its owner's ask, not started, else active. */
type WorkState = "done" | "review" | "waiting" | "open" | "active";
const WORKSTREAM = ["active", "blocked", "submitted", "changes_requested"] as const;
/** Up to this many positions, each reads its own Work rather than the organization's. */
const FEW = 20;
/** Work that isn't finished, not started included. */
const UNFINISHED = ["open", "active", "blocked", "submitted", "changes_requested"] as const;
const oldestFirst = <T extends { createdAt: string }>(items: T[]) =>
  items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));

/** Every page of a list, each read continuing from the last. */
function all<T>(read: (after: string | undefined) => { items: T[]; next: string | null }): T[] {
  const items: T[] = [];
  for (let after: string | undefined; ; ) {
    const page = read(after);
    items.push(...page.items);
    if (page.next === null) return items;
    after = page.next;
  }
}

/**
 * A Work's state from its status and its owner's open ask on it: submitted Work is in review even
 * with an ask, and a stored `blocked` is active.
 */
function workState(work: Work, ask: Form | undefined): WorkState {
  if (work.status === "accepted") return "done";
  if (work.status === "submitted") return "review";
  if (ask !== undefined) return "waiting";
  return work.status === "open" ? "open" : "active";
}

/** Changes were requested on its current submission; it stays so after the owner resumes. */
const changesRequested = (work: Work) =>
  work.review?.verdict === "changes_requested" &&
  work.review.submissionID === work.submission?.submissionID;

/** How urgent Work is for a headline: waiting, review, changes requested, then active. */
const urgency = (state: "waiting" | "review" | "active", work: Work) =>
  state === "waiting" ? 0 : state === "review" ? 1 : changesRequested(work) ? 2 : 3;

/** A list item, `-`, `*`, `+`, `1.` or `1)`, with an optional box: `[ ]`, `[x]` or `[X]`. */
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*\S)\s*$/;

/** A text's first sentence, on one line. */
function sentence(text: string): string | undefined {
  const line = text.replace(/\s+/g, " ").trim();
  return line ? (/^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line) : undefined;
}

/**
 * Its current step, else the first sentence of its progress. Progress is a paragraph, then a
 * list; once any item has a box, the first item not checked `- [x]` is current.
 */
function step(progress: string | undefined): string | undefined {
  if (!progress) return undefined;
  const lines = progress.split("\n");
  const start = lines.findIndex((line) => ITEM.test(line));
  const items = (start < 0 ? [] : lines.slice(start)).flatMap((line) => {
    const found = ITEM.exec(line);
    return found ? [{ box: found[1], text: found[2] as string }] : [];
  });
  const current = items.some((item) => item.box !== undefined)
    ? items.find((item) => item.box?.toLowerCase() !== "x")
    : undefined;
  return current?.text ?? sentence(lines.slice(0, start < 0 ? undefined : start).join("\n"));
}

/** The most urgent among the workstreams: blocked, waiting, review, then active. */
function stateOf(workstreams: View["workstreams"]): View["state"] {
  const states = workstreams.map((work) =>
    work.status === "blocked"
      ? "blocked"
      : work.status === "submitted"
        ? "review"
        : work.status === "active" && work.asks.length > 0
          ? "waiting"
          : "active",
  );
  return (
    (["blocked", "waiting", "review", "active"] as const).find((state) => states.includes(state)) ??
    "idle"
  );
}

export function team(
  registry: Registry,
  actors: Pick<Actors, "view">,
  audit: Pick<Audit, "lastWrite">,
  workspace: Workspace,
) {
  /**
   * The start and its open reports to `depth`, each with its state, headline and ask counts. Up to
   * `FEW` positions read their own Work, more read the organization's once, and open asks are one
   * pass.
   */
  function readTeam(caller: ActorRow, request: RequestOf<"team">): ResponseOf<"team"> {
    const start = request.actor === undefined ? caller : registry.found(request.actor);
    const rows: ActorRow[] = [];
    const visit = (at: ActorRow, depth: number) => {
      rows.push(at);
      if (depth > 0) for (const report of registry.reports(at.id)) visit(report, depth - 1);
    };
    visit(start, request.depth);
    // The subtree filters walk each row's managers on every page, so the Hub filters instead: a
    // few positions read their own Work, and more read every Actor's unfinished Work once.
    const few = rows.length <= FEW;
    const positions = workspace.run(caller, ({ work, forms }) => {
      const list = (
        filter: Omit<NonNullable<Parameters<typeof work.list>[0]>, "after" | "limit">,
      ) => all((after) => work.list({ ...filter, limit: 100, after }));
      const live = few
        ? rows.flatMap((row) => list({ ownerID: row.id, status: [...UNFINISHED] }))
        : list({ status: [...UNFINISHED] });
      // Asks stay one pass: branchAsks counts the asks at every depth below each position.
      const open = oldestFirst(all((after) => forms.list({ status: ["open"], limit: 100, after })));
      const latest = (actorID: string) =>
        work.list({ ownerID: actorID, status: ["accepted"], order: "recent", limit: 1 }).items[0];
      const recent = few
        ? undefined
        : work.list({ status: ["accepted"], order: "recent", limit: 100 });
      /** The last Work it finished; past the most recent page, its own latest. */
      const finished = (actorID: string) =>
        recent === undefined
          ? latest(actorID)
          : (recent.items.find((item) => item.ownerID === actorID) ??
            (recent.next === null ? undefined : latest(actorID)));
      /** Open asks below each Actor: each counts once for every manager above its asker. */
      const below = new Map<string, number>();
      for (const ask of open)
        for (let at = registry.get(ask.requesterID); at?.manager; at = registry.get(at.manager))
          below.set(at.manager, (below.get(at.manager) ?? 0) + 1);
      const named = (actorID: string) =>
        actorID === caller.id ? "you" : (registry.get(actorID)?.name ?? actorID);
      const titled = (ticketID: string) => {
        const found = live.find((item) => item.ticketID === ticketID);
        if (found) return found.title;
        try {
          return work.get({ ticketID }).title;
        } catch (error) {
          if (error instanceof WorkspaceError && error.code === "not_found") return "other Work";
          throw error;
        }
      };
      const clause = (item: Work, state: WorkState, ask: Form | undefined): Headline["clause"] => {
        if (ask) return { kind: ask.approval ? "approval" : "ask", text: ask.title };
        if (state === "review")
          return { kind: "review", text: `with ${named(item.requesterID)} for review` };
        const on = item.waitsOn;
        if (on)
          return {
            kind: "waits",
            text:
              "text" in on ? on.text : "actorID" in on ? named(on.actorID) : titled(on.ticketID),
          };
        const text = step(item.progress);
        return text === undefined ? null : { kind: "step", text };
      };
      return rows.map((row): Position => {
        const items = live
          .filter((item) => item.ownerID === row.id)
          .map((item) => {
            const ask = open.find(
              (each) => each.workID === item.ticketID && each.requesterID === item.ownerID,
            );
            return { item, ask, state: workState(item, ask) };
          });
        const ranked = items
          .flatMap(({ item, ask, state }) =>
            state === "done" || state === "open"
              ? []
              : [{ item, ask, state, rank: urgency(state, item) }],
          )
          .sort(
            (left, right) =>
              left.rank - right.rank || right.item.updatedAt.localeCompare(left.item.updatedAt),
          );
        const [subject] = ranked;
        const last = finished(row.id);
        return {
          ...actors.view(row),
          state: subject?.state ?? "idle",
          headline: {
            subject: subject
              ? { ticketID: subject.item.ticketID, title: subject.item.title, state: subject.state }
              : null,
            clause: subject ? clause(subject.item, subject.state, subject.ask) : null,
            more: Math.max(ranked.length - 1, 0),
            notStarted: items.filter((each) => each.state === "open").length,
            finished: last
              ? {
                  ticketID: last.ticketID,
                  title: last.title,
                  at: last.completedAt ?? last.updatedAt,
                }
              : null,
          },
          asks: open.filter((ask) => ask.requesterID === row.id).length,
          branchAsks: below.get(row.id) ?? 0,
          lastActiveAt: audit.lastWrite(row.id) ?? null,
        };
      });
    });
    return { root: (registry.root() as ActorRow).id, positions };
  }

  function view(caller: ActorRow, request: RequestOf<"actor_view">): View {
    const viewed = request.actorID === undefined ? caller : registry.found(request.actorID);
    const id = viewed.id;
    const reports = registry.reports(id);
    const reportIDs = reports.map((report) => report.id);
    return workspace.run(caller, ({ work, forms, status }) => {
      const names: View["actors"] = {};
      const list = <T>(page: { items: T[]; actors: View["actors"] }) => {
        Object.assign(names, page.actors);
        return page.items;
      };
      const works = (query: Parameters<typeof work.list>[0]) =>
        list<Work>(work.list({ limit: 100, ...query }));
      const asks = (query: Parameters<typeof forms.list>[0]) =>
        list<Form>(forms.list({ limit: 100, ...query }));
      const own = asks({ requesterID: id, status: ["open"] });
      const workstreams = oldestFirst([
        ...works({ ownerID: id, status: [...WORKSTREAM] }),
        ...works({ requesterID: id, status: [...WORKSTREAM] }).filter((item) =>
          reportIDs.includes(item.ownerID),
        ),
      ]).map((item) => ({ ...item, asks: own.filter((ask) => ask.workID === item.ticketID) }));
      const open = works({ ownerID: id, status: ["open"] });
      let current: View["status"] = null;
      try {
        current = status.get({ actorID: id });
      } catch (error) {
        if (!(error instanceof WorkspaceError && error.code === "not_found")) throw error;
      }
      for (const actor of [viewed, ...reports]) names[actor.id] = { name: actor.name };
      const { path, online } = actors.view(viewed);
      return {
        actor: {
          actorID: id,
          name: viewed.name,
          path,
          purpose: viewed.purpose,
          managerID: viewed.manager,
          online,
          lastActiveAt: audit.lastWrite(id) ?? null,
          closed_at: viewed.closed_at,
        },
        state: stateOf(workstreams),
        status: current,
        workstreams,
        asks: oldestFirst(
          own.filter((ask) => !workstreams.some((item) => item.ticketID === ask.workID)),
        ),
        needs:
          reportIDs.length === 0
            ? []
            : oldestFirst(asks({ requesterID: reportIDs, status: ["open"] })),
        reviews: oldestFirst(works({ requesterID: id, status: ["submitted"] })),
        assigned: oldestFirst(open.filter((item) => item.requesterID !== id)),
        followUps: oldestFirst(open.filter((item) => item.requesterID === id)),
        completed:
          request.completed === 0
            ? []
            : works({
                ownerID: id,
                status: ["accepted"],
                order: "recent",
                limit: request.completed,
              }),
        reports: reports.map(actors.view),
        actors: names,
      };
    });
  }

  return {
    tool: bindTool(TEAM, {
      team: (actor, request) => readTeam(actor, request),
      actor_view: (actor, request) => view(actor, request),
    }),
  };
}

export type Team = ReturnType<typeof team>;
