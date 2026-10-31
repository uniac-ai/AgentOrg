/**
 * Claims on shared resources, such as a release lane or a cluster: which actor holds each one now.
 *
 * A resource has at most one current claim. Claiming one another actor holds is refused, naming
 * the holder; claiming one the actor holds renews it. A claim ends when its holder releases it,
 * when its `until` passes, or when its holder is closed, so an ended claim needs no clearing up.
 */

import { Conflict, Forbidden, Invalid, NotFound } from "./errors.ts";
import { CLAIMS, type RequestOf } from "./model/index.ts";
import type { ClaimRow, Store } from "./ports.ts";
import type { ActorRow, Registry } from "./registry.ts";
import { bindTool } from "./tools.ts";

export { CLAIMS as definition } from "./model/index.ts";

export function claims(claimStore: Store["claims"], registry: Registry, now: () => string) {
  function claim(actor: ActorRow, request: RequestOf<"claim">): ClaimRow {
    const at = now();
    const until = request.until === undefined ? null : new Date(request.until).toISOString();
    if (until !== null && until <= at) throw new Invalid("until: it has already passed");
    const held = heldClaim(request.resource);
    if (held && held.holder !== actor.id) throw new Conflict(heldMessage(held));
    const claim = {
      resource: request.resource,
      holder: actor.id,
      note: request.note,
      until,
      claimed_at: held?.claimed_at ?? at,
    };
    claimStore.put(claim);
    return claim;
  }

  function release(actor: ActorRow, request: RequestOf<"release">): ClaimRow {
    const held = heldClaim(request.resource);
    if (!held) throw new NotFound(`nobody holds ${request.resource}`);
    if (held.holder !== actor.id && actor.manager !== null) {
      throw new Forbidden(`${heldMessage(held)}; only it or the root releases it`);
    }
    claimStore.remove(request.resource);
    return held;
  }

  function heldClaim(resource: string): ClaimRow | undefined {
    const claim = claimStore.get(resource);
    return claim && current(claim) ? claim : undefined;
  }

  function current(claim: ClaimRow): boolean {
    const open = registry.get(claim.holder)?.closed_at === null;
    return open && (claim.until === null || claim.until > now());
  }

  function heldMessage(claim: ClaimRow): string {
    const holder = registry.names([claim.holder])[claim.holder] ?? claim.holder;
    const until = claim.until === null ? "" : ` until ${claim.until}`;
    return `${claim.resource} is held by ${holder}${until}: ${claim.note}`;
  }
  return { claim, release, tool: bindTool(CLAIMS, { claim, release }) };
}

export type Claims = ReturnType<typeof claims>;
