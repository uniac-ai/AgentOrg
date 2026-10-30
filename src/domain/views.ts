/** Actor, team and progress read views, composed only from their state owners' clients. */

import type { Capabilities } from "./capabilities.ts";
import type { Claims } from "./claims.ts";
import { askersOf, type Communication } from "./communication.ts";
import type { Connections } from "./connections.ts";
import type { RequestOf, ResponseOf } from "./model/index.ts";
import type { ActorRow, ActorView } from "./ports.ts";
import { actorsIn, type Progress } from "./progress.ts";
import type { Registry } from "./registry.ts";

export function views(
  registry: Registry,
  connections: Pick<Connections, "link" | "interfaces">,
  capabilities: Capabilities,
  progressState: Progress,
  communication: Communication,
  claims: Claims,
) {
  function actorView(actor: ActorRow): ActorView {
    const { credential_hash: _, ...identity } = actor;
    return {
      ...identity,
      path: registry.path(actor),
      online: connections.link(actor.id) !== undefined,
      interfaces: connections.interfaces(actor.id),
    };
  }

  return {
    actor: actorView,
    team(actor: ActorRow, request: RequestOf<"team">): ResponseOf<"team"> {
      const start = request.actor === undefined ? actor : registry.found(request.actor);
      const callable = capabilities.list(actor);
      const positions: ResponseOf<"team">["positions"] = [];
      const visit = (at: ActorRow, depth: number) => {
        const { interfaces: _, ...identity } = actorView(at);
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
            callable.find((tool) => tool.id === at.id)?.interfaces.map((each) => each.offer.call) ??
            [],
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
    },

    progress(request: RequestOf<"progress">): ResponseOf<"progress"> {
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
    },
  };
}

export type Views = ReturnType<typeof views>;
