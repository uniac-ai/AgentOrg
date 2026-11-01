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
const WORKSTREAM = ["active", "blocked", "submitted", "changes_requested"] as const;
const oldestFirst = <T extends { createdAt: string }>(items: T[]) =>
  items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));

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
  function readTeam(actor: ActorRow, request: RequestOf<"team">): ResponseOf<"team"> {
    const start = request.actor === undefined ? actor : registry.found(request.actor);
    const positions: ResponseOf<"team">["positions"] = [];
    const visit = (at: ActorRow, depth: number) => {
      positions.push(actors.view(at));
      if (depth > 0) for (const report of registry.reports(at.id)) visit(report, depth - 1);
    };
    visit(start, request.depth);
    return {
      root: (registry.root() as ActorRow).id,
      positions,
    };
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
          online,
          lastActiveAt: audit.lastWrite(id) ?? null,
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
