/** The domain composition: explicit Hub Tools, Actor presence and domain state owners. */

import { actors as actorModule } from "./actors.ts";
import { application } from "./application.ts";
import { audit } from "./audit.ts";
import { capabilities } from "./capabilities.ts";
import { claims } from "./claims.ts";
import { connections } from "./connections.ts";
import { diagnostics } from "./diagnostics.ts";
import { type ExecutionProvider, execution } from "./execution.ts";
import type { Store } from "./ports.ts";
import { registry } from "./registry.ts";
import { type SystemRuntime, system } from "./system.ts";
import { team } from "./team.ts";
import { workspace } from "./workspace.ts";

export interface OrganizationOptions {
  now?: () => Date;
  provider?: (providerId: string) => ExecutionProvider | undefined;
  runtime?: SystemRuntime;
}

export function organization(store: Store, options: OrganizationOptions = {}) {
  const clock = options.now ?? (() => new Date());
  const now = () => clock().toISOString();
  const actors = registry(store.actors, now);
  const activity = audit(store.audit, now);
  const connected = connections(now);
  const observed = diagnostics(now);
  const resources = claims(store.claims, actors, now);
  const creation = execution(options.provider ?? (() => undefined), observed);
  const positions = actorModule(actors, connected, creation);
  const organizationView = team(actors, positions);
  const offered = capabilities([
    positions.tool,
    organizationView.tool,
    ...workspace(actors, store.workspace),
    resources.tool,
    activity.tool,
    system(
      actors,
      connected,
      observed,
      now,
      options.runtime ?? { version: "unknown", nodeVersion: "unknown", providerIds: [] },
    ),
  ]);
  const dispatch = application(actors, offered, activity, connected, observed);
  return {
    registry: actors,
    connections: connected,
    audit: activity,
    diagnostics: observed,
    identify: actors.identify,
    ...dispatch,
  };
}

export type Organization = ReturnType<typeof organization>;
