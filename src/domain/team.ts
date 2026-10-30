/** Team's progress and organization views, composed from the state owners' clients. */

import type { Actors } from "./actors.ts";
import type { Claims } from "./claims.ts";
import { askersOf, type Communication } from "./communication.ts";
import { type RequestOf, type ResponseOf, TEAM, type ToolDescriptor } from "./model/index.ts";
import type { ActorRow } from "./ports.ts";
import { actorsIn, type Progress } from "./progress.ts";
import type { Registry } from "./registry.ts";
import { bindTool } from "./tools.ts";

export { TEAM as definition } from "./model/index.ts";

export function team(
  registry: Registry,
  actors: Pick<Actors, "view">,
  progressState: Progress,
  communication: Communication,
  claims: Claims,
) {
  function readTeam(
    actor: ActorRow,
    request: RequestOf<"team">,
    callable: ToolDescriptor[],
  ): ResponseOf<"team"> {
    const start = request.actor === undefined ? actor : registry.found(request.actor);
    const positions: ResponseOf<"team">["positions"] = [];
    const visit = (at: ActorRow, depth: number) => {
      const { interfaces: _, ...identity } = actors.view(at);
      const [current] = progressState.latest(at.id);
      positions.push({
        ...identity,
        progress: current
          ? {
              version: current.version,
              state: current.state,
              summary: current.summary,
              updated_at: current.updated_at,
            }
          : null,
        questions: communication.openQuestions(at.id),
        interfaces:
          callable.find((tool) => tool.id === at.id)?.interfaces.map((each) => each.call) ?? [],
        claims: claims.heldBy(at.id),
      });
      if (depth > 0) for (const report of registry.reports(at.id)) visit(report, depth - 1);
    };
    visit(start, request.depth);
    return {
      root: (registry.root() as ActorRow).id,
      positions,
      names: registry.names(positions.flatMap((position) => askersOf(position.questions))),
    };
  }

  function readProgress(request: RequestOf<"progress">): ResponseOf<"progress"> {
    const target = registry.found(request.actor);
    const versions = progressState.latest(target.id, request.history + 1);
    const [current, ...history] = versions;
    const questions = communication.openQuestions(target.id);
    return {
      actor: target.id,
      progress: current ?? null,
      questions,
      history,
      names: registry.names([
        target.id,
        ...versions.flatMap((version) => actorsIn(version.items)),
        ...askersOf(questions),
      ]),
    };
  }
  return {
    tool: bindTool(TEAM, {
      progress_set: (actor, request) => progressState.set(actor, request),
      team: (actor, request, context) => readTeam(actor, request, context.catalog),
      progress: (_actor, request) => readProgress(request),
    }),
  };
}

export type Team = ReturnType<typeof team>;
