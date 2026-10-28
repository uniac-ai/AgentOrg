/**
 * The domain: the organization's actors and their interfaces, the wiring of who calls whom, calls
 * and their lifecycle, progress and messages, the built-ins and the audit trail. It knows no
 * protocol, network or database: it meets them through the ports in `ports.ts`.
 *
 * - `model/`: the vocabulary, which actors may import too.
 * - `registry.ts`: the actors, the tree they form, and their credentials.
 * - `wiring.ts`: whose interfaces each actor may call, under what names.
 * - `calls.ts`: call records, delivery and redelivery, runs, and waits.
 * - `communication.ts`: progress, messages and questions. `claims.ts`: claims on shared resources.
 * - `builtins.ts` and `application.ts`: the built-ins, and what an actor may call.
 * - `audit.ts`: the audit trail. `validation.ts`: JSON Schema checks.
 *
 * `Organization` assembles them. It is the `Application` a binding serves to callers, and the
 * `Presence` a binding tells when an actor can be reached through which link.
 */

import { AvailableInterfaces, type Timing } from "./application.ts";
import { Audit } from "./audit.ts";
import { builtins } from "./builtins.ts";
import { Calls } from "./calls.ts";
import { Claims } from "./claims.ts";
import { Communication } from "./communication.ts";
import type { Answer, InterfaceDescriptor, Offer } from "./model/index.ts";
import type { ActorLink, Application, Invocation, Presence, Store } from "./ports.ts";
import { Registry } from "./registry.ts";

export type { Timing };

export interface OrganizationOptions extends Partial<Timing> {
  now?: () => Date;
}

export class Organization implements Application, Presence {
  readonly registry: Registry;
  readonly calls: Calls;
  readonly audit: Audit;
  private readonly application: AvailableInterfaces;
  /** The link to each reachable actor. */
  private readonly links = new Map<string, ActorLink>();

  constructor(store: Store, options: OrganizationOptions = {}) {
    const clock = options.now ?? (() => new Date());
    const now = () => clock().toISOString();
    this.registry = new Registry(store, now);
    this.registry.setAllOffline();
    this.audit = new Audit(store, now);
    this.calls = new Calls(store, this.registry, this.audit, {
      now,
      linkOf: (actor) => this.links.get(actor),
    });
    const claims = new Claims(store, this.registry, now);
    const communication = new Communication(store, this.registry, claims, now);
    const handlers = builtins(store, this.registry, this.calls, this.audit, communication, claims, {
      now,
      disconnect: async (actor) => {
        const link = this.links.get(actor);
        if (link) this.offline(actor, link);
        await link?.close();
      },
    });
    this.application = new AvailableInterfaces(this.registry, this.calls, handlers, this.audit, {
      waitMs: options.waitMs ?? 30_000,
      stepMs: options.stepMs ?? 10_000,
    });
  }

  /** Who a credential is: the id of its open actor. */
  identify(credential: string): Promise<string | undefined> {
    return this.registry.identify(credential);
  }

  /** The link to an actor, while it can be reached. */
  link(actor: string): ActorLink | undefined {
    return this.links.get(actor);
  }

  online(actor: string, link: ActorLink, interfaces: InterfaceDescriptor[]): void {
    this.links.set(actor, link);
    this.registry.setInterfaces(actor, interfaces);
    this.registry.setOnline(actor, true);
    this.calls.redeliver(actor);
  }

  changed(actor: string, link: ActorLink, interfaces: InterfaceDescriptor[]): void {
    if (this.links.get(actor) === link) this.registry.setInterfaces(actor, interfaces);
  }

  offline(actor: string, link: ActorLink): void {
    if (this.links.get(actor) !== link) return;
    this.links.delete(actor);
    this.registry.setOnline(actor, false);
  }

  available(actor: string): Offer[] {
    return this.application.available(actor);
  }

  invoke(
    actor: string,
    name: string,
    input: Record<string, unknown>,
    how: Invocation,
  ): Promise<Answer> {
    return this.application.invoke(actor, name, input, how);
  }
}
