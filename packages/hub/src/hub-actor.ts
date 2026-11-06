import { Refused } from "@agentorg/sdk";
import { readLogs } from "./logs.js";
import type {
  ActorRecord,
  AuditRecord,
  Decision,
  HubState,
  RequestRecord,
  Wiring,
} from "./state.js";

type Input = Record<string, unknown>;
type Handler = (caller: string, input: Input) => unknown;
type Listener = { caller: string; emit(payload: unknown): void };

const wiring = (input: Input): Wiring => ({
  consumer: String(input.consumer),
  slot: String(input.slot),
  provider: String(input.provider),
  export: String(input.export),
});

/**
 * The built-in `hub` Actor: management as the handlers of its five exports. The router reaches it
 * through bindings like any other provider and validates both ways, so these only map calls to the
 * state, whose own checks are the authority.
 */
export class HubActor {
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #handlers: Record<string, Record<string, Handler>>;

  constructor(state: HubState) {
    /** A package Actor's record with its view modules, which a shell can place. */
    const withViews = (actor: ActorRecord) => {
      if (actor.package === "external" || actor.package === "builtin") return actor;
      let modules: Record<string, { placement: string }>;
      try {
        ({ modules } = state.package(actor.package).manifest);
      } catch {
        return actor; // A closed Actor's package may be gone.
      }
      return {
        ...actor,
        views: Object.keys(modules).filter((name) => modules[name]?.placement === "view"),
      };
    };
    this.#handlers = {
      packages: {
        add: (caller, input) => state.addPackage(caller, String(input.path)),
        list: () => ({ packages: state.packages() }),
        get: (_, input) => state.package(String(input.hash)),
        remove: (caller, input) => state.removePackage(caller, String(input.hash)),
      },
      actors: {
        create: (caller, input) =>
          state.createActor(caller, {
            name: String(input.name),
            ...(typeof input.package === "string" ? { package: input.package } : {}),
            ...(Array.isArray(input.bindings)
              ? { bindings: input.bindings as Omit<Wiring, "consumer">[] }
              : {}),
          }),
        list: () => ({ actors: state.actors().map(withViews) }),
        get: (_, input) => withViews(state.actor(String(input.actorId))),
        start: (caller, input) => state.start(caller, String(input.actorId)),
        stop: (caller, input) => state.stop(caller, String(input.actorId)),
        close: (caller, input) => state.closeActor(caller, String(input.actorId)),
        logs: (_, input) => {
          // The Actor must exist; its lines are its process's output and its views' lines.
          const { actorId } = state.actor(String(input.actorId));
          const limit = typeof input.limit === "number" ? input.limit : 100;
          return { lines: readLogs(state.home, actorId, limit) };
        },
      },
      grants: {
        bind: (caller, input) => state.bind(caller, wiring(input)),
        unbind: (caller, input) => state.unbind(caller, String(input.consumer), String(input.slot)),
        request: (caller, input) => ({
          requestId: state.request(caller, wiring(input), String(input.reason)).requestId,
        }),
        requests: (caller) => ({ requests: state.requests(caller) }),
        mine: (caller, input) => ({
          requests: state.mine(caller, typeof input.limit === "number" ? input.limit : 100),
        }),
        decline: (caller, input) => state.decline(caller, String(input.requestId)),
      },
      bindings: {
        list: (_, input) => ({
          bindings: state.bindings(typeof input.actor === "string" ? input.actor : undefined),
        }),
      },
      exports: {
        list: (_, input) => ({
          exports: state.exports(typeof input.actor === "string" ? input.actor : undefined),
        }),
      },
      audit: {
        list: (_, input) =>
          state.audit(
            typeof input.since === "number" ? input.since : 0,
            typeof input.limit === "number" ? input.limit : 100,
          ),
      },
    };
  }

  call(exported: string, method: string, caller: string, input: unknown): unknown {
    const methods = Object.hasOwn(this.#handlers, exported) ? this.#handlers[exported] : undefined;
    const handler = methods && Object.hasOwn(methods, method) ? methods[method] : undefined;
    if (!handler) throw new Refused("unimplemented", `hub.${exported} has no method ${method}.`);
    // A method with nothing to return answers {}.
    return handler(caller, input as Input) ?? {};
  }

  /** Listen to one of the hub's events; returns the way to stop. */
  subscribe(exported: string, event: string, listener: Listener): () => void {
    const key = `${exported}.${event}`;
    const set = this.#listeners.get(key) ?? new Set();
    this.#listeners.set(key, set);
    set.add(listener);
    return () => void set.delete(listener);
  }

  #send(key: string, payload: unknown, to?: (caller: string) => boolean) {
    for (const listener of [...(this.#listeners.get(key) ?? [])])
      if (!to || to(listener.caller)) listener.emit(payload);
  }

  /** A request, to the subscribers who could approve it. */
  requested(request: RequestRecord, approvers: string[]) {
    this.#send("grants.requested", request, (caller) => approvers.includes(caller));
  }

  /** A decision, to the subscribers its request went to and its requester. */
  decided(request: RequestRecord, status: Decision, approvers: string[]) {
    this.#send("grants.decided", { request, status }, (caller) => approvers.includes(caller));
  }

  exportsChanged(actor: string) {
    this.#send("exports.changed", { actor });
  }

  audited(entry: AuditRecord) {
    this.#send("audit.appended", entry);
  }
}
