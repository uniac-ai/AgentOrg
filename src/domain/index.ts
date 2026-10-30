/** The domain composition: owner clients, their triggers, and its Application/Presence ports. */

import { actors as actorModule } from "./actors.ts";
import { application, type Timing } from "./application.ts";
import { audit } from "./audit.ts";
import { calls } from "./calls.ts";
import { capabilities } from "./capabilities.ts";
import { claims } from "./claims.ts";
import { communication } from "./communication.ts";
import { connections } from "./connections.ts";
import { type ExecutionProvider, execution } from "./execution.ts";
import type { Store } from "./ports.ts";
import { progress } from "./progress.ts";
import { registry } from "./registry.ts";
import { team } from "./team.ts";

export type { Timing };

export interface OrganizationOptions extends Partial<Timing> {
  now?: () => Date;
  onActorClosed?: (actorId: string) => void;
  provider?: (providerId: string) => ExecutionProvider | undefined;
}

export function organization(store: Store, options: OrganizationOptions = {}) {
  const clock = options.now ?? (() => new Date());
  const now = () => clock().toISOString();
  const actors = registry(store.actors, now);
  const activity = audit(store.audit, now);
  const connected = connections(
    store.exposures,
    (actor) => calling.redeliver(actor),
    options.onActorClosed ?? (() => {}),
  );
  const calling = calls(store.calls, connected, activity, now);
  const resources = claims(store.claims, actors, now);
  const correspondence = communication(store, actors, now);
  const progressState = progress(store.progress, actors, now);
  const creation = execution(options.provider ?? (() => undefined));
  const positions = actorModule(actors, calling, connected, creation);
  const organizationView = team(actors, positions, progressState, correspondence, resources);
  const offered = capabilities(actors, connected, [
    positions.tool,
    organizationView.tool,
    ...correspondence.tools,
    resources.tool,
    calling.tool,
    activity.tool,
  ]);
  const dispatch = application(actors, offered, calling, activity, {
    waitMs: options.waitMs ?? 30_000,
    stepMs: options.stepMs ?? 10_000,
  });
  return {
    registry: actors,
    connections: connected,
    calls: calling,
    audit: activity,
    identify: actors.identify,
    ...dispatch,
    online: connected.online,
    begin: connected.begin,
    changed: connected.changed,
    offline: connected.offline,
  };
}

export type Organization = ReturnType<typeof organization>;
