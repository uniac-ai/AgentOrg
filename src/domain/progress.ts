/** Versioned progress: partial replacements and the actors its items reference. */

import { Invalid } from "./errors.ts";
import type { RequestOf } from "./model/index.ts";
import type { ActorRow, ProgressRow, Store } from "./ports.ts";
import type { Registry } from "./registry.ts";

export const actorsIn = (items: ProgressRow["items"]) =>
  items.flatMap((item) => [
    ...(item.owner === undefined ? [] : [item.owner]),
    ...(item.waits_on ?? []).flatMap((waits) => ("actor" in waits ? [waits.actor] : [])),
  ]);

export function progress(progress: Store["progress"], registry: Registry, now: () => string) {
  return {
    latest: (actor: string, limit = 1) => progress.latest(actor, limit),
    set(actor: ActorRow, request: RequestOf<"progress_set">): ProgressRow {
      const [current] = progress.latest(actor.id, 1);
      const state = request.state ?? current?.state;
      if (state === undefined) throw new Invalid("state: your first progress names its state");
      for (const id of actorsIn(request.items ?? [])) {
        if (!registry.get(id)) throw new Invalid(`items: there is no actor ${id}`);
      }
      const next: ProgressRow = {
        actor: actor.id,
        version: (current?.version ?? 0) + 1,
        state,
        summary: request.summary ?? current?.summary ?? "",
        items: request.items ?? current?.items ?? [],
        links: request.links ?? current?.links ?? [],
        updated_at: now(),
      };
      progress.insert(next);
      return next;
    },
  };
}

export type Progress = ReturnType<typeof progress>;
