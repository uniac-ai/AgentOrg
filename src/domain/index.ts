/** The domain composition: owner clients, their triggers, and its Application/Presence ports. */

import { application, type Timing } from "./application.ts";
import { audit } from "./audit.ts";
import { calls } from "./calls.ts";
import { capabilities } from "./capabilities.ts";
import { claims } from "./claims.ts";
import { communication } from "./communication.ts";
import { connections } from "./connections.ts";
import type { Store } from "./ports.ts";
import { progress } from "./progress.ts";
import { registry } from "./registry.ts";
import { views } from "./views.ts";

export type { Timing };

export interface OrganizationOptions extends Partial<Timing> {
  now?: () => Date;
}

export function organization(store: Store, options: OrganizationOptions = {}) {
  const clock = options.now ?? (() => new Date());
  const now = () => clock().toISOString();
  const actors = registry(store.actors, now);
  const activity = audit(store.audit, now);
  const connected = connections(store.exposures, (actor) => calling.redeliver(actor));
  const calling = calls(store.calls, connected, activity, now);
  const offered = capabilities(actors, connected);
  const resources = claims(store.claims, actors, now);
  const correspondence = communication(store, actors, now);
  const progressState = progress(store.progress, actors, now);
  const read = views(actors, connected, offered, progressState, correspondence, resources);
  const dispatch = application(
    actors,
    offered,
    calling,
    correspondence,
    resources,
    connected,
    progressState,
    read,
    activity,
    {
      waitMs: options.waitMs ?? 30_000,
      stepMs: options.stepMs ?? 10_000,
    },
  );
  return {
    registry: actors,
    connections: connected,
    calls: calling,
    audit: activity,
    identify: actors.identify,
    ...dispatch,
    online: connected.online,
    changed: connected.changed,
    offline: connected.offline,
  };
}

export type Organization = ReturnType<typeof organization>;
