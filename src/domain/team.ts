/** Organization hierarchy and actual admitted connection presence. */

import type { Actors } from "./actors.ts";
import { type RequestOf, type ResponseOf, TEAM } from "./model/index.ts";
import type { ActorRow } from "./ports.ts";
import type { Registry } from "./registry.ts";
import { bindTool } from "./tools.ts";

export { TEAM as definition } from "./model/index.ts";

export function team(registry: Registry, actors: Pick<Actors, "view">) {
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

  return {
    tool: bindTool(TEAM, {
      team: (actor, request) => readTeam(actor, request),
    }),
  };
}

export type Team = ReturnType<typeof team>;
