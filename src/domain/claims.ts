/**
 * Claims on shared resources, such as a release lane or a cluster: which actor holds each one now.
 *
 * A resource has at most one current claim. Claiming one another actor holds is refused, naming
 * the holder; claiming one the actor holds renews it. A claim ends when its holder releases it,
 * when its `until` passes, or when its holder is closed, so an ended claim needs no clearing up.
 */

import { Conflict, Forbidden, Invalid, NotFound } from "./errors.ts";
import type { RequestOf } from "./model/index.ts";
import type { ClaimRow, Store } from "./ports.ts";
import type { ActorRow, Registry } from "./registry.ts";

export class Claims {
  private readonly claims: Store["claims"];
  private readonly registry: Registry;
  private readonly now: () => string;

  constructor(store: Store, registry: Registry, now: () => string) {
    this.claims = store.claims;
    this.registry = registry;
    this.now = now;
  }

  /** The claims the actor holds now. */
  heldBy(actor: string): ClaimRow[] {
    return this.claims.heldBy(actor).filter((claim) => this.current(claim));
  }

  claim(actor: ActorRow, request: RequestOf<"claim">): ClaimRow {
    const now = this.now();
    const until = request.until === undefined ? null : new Date(request.until).toISOString();
    if (until !== null && until <= now) throw new Invalid("until: it has already passed");
    const held = this.held(request.resource);
    if (held && held.holder !== actor.id) throw new Conflict(this.heldMessage(held));
    const claim = {
      resource: request.resource,
      holder: actor.id,
      note: request.note,
      until,
      claimed_at: held?.claimed_at ?? now,
    };
    this.claims.put(claim);
    return claim;
  }

  release(actor: ActorRow, request: RequestOf<"release">): ClaimRow {
    const held = this.held(request.resource);
    if (!held) throw new NotFound(`nobody holds ${request.resource}`);
    if (held.holder !== actor.id && actor.manager !== null) {
      throw new Forbidden(`${this.heldMessage(held)}; only it or the root releases it`);
    }
    this.claims.remove(request.resource);
    return held;
  }

  private held(resource: string): ClaimRow | undefined {
    const claim = this.claims.get(resource);
    return claim && this.current(claim) ? claim : undefined;
  }

  private current(claim: ClaimRow): boolean {
    const open = this.registry.get(claim.holder)?.closed_at === null;
    return open && (claim.until === null || claim.until > this.now());
  }

  private heldMessage(claim: ClaimRow): string {
    const holder = this.registry.names([claim.holder])[claim.holder] ?? claim.holder;
    const until = claim.until === null ? "" : ` until ${claim.until}`;
    return `${claim.resource} is held by ${holder}${until}: ${claim.note}`;
  }
}
