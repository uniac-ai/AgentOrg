/**
 * The built-ins: the management surface every actor has among its available interfaces. Each
 * takes the calling actor and its request, already checked against the request schema in
 * `model/builtins.ts`.
 */

import type { Audit } from "./audit.ts";
import type { Calls } from "./calls.ts";
import type { Communication } from "./communication.ts";
import { Conflict, Forbidden, Invalid } from "./errors.ts";
import { type BuiltinName, HISTORY_MAX, type RequestOf, type ResponseOf } from "./model/index.ts";
import type { Store } from "./ports.ts";
import type { ActorRow, Registry } from "./registry.ts";

/** What `call_result` needs from the request it serves. */
export interface Waiting {
  stepMs: number;
  progress: () => Promise<void>;
  signal: AbortSignal;
}

export type Handlers = {
  [N in BuiltinName]: (
    actor: ActorRow,
    request: RequestOf<N>,
    waiting: Waiting,
  ) => Promise<ResponseOf<N>>;
};

export function builtins(
  store: Store,
  registry: Registry,
  calls: Calls,
  audit: Audit,
  communication: Communication,
  options: { now: () => string; disconnect: (actor: string) => Promise<void> },
): Handlers {
  const { now } = options;
  const isRoot = (actor: ActorRow) => actor.manager === null;

  return {
    actor_create: async (actor, request) => {
      const { actor: created, credential } = await registry.create(
        actor.id,
        request.name,
        request.purpose,
      );
      return { actor: registry.asActor(created), credential };
    },

    actor_close: async (actor, request) => {
      const target = registry.found(request.actor);
      if (target.manager === null) throw new Invalid("the root is never closed");
      if (target.manager !== actor.id && !isRoot(actor)) {
        throw new Forbidden(`only its manager or the root closes ${target.name}`);
      }
      if (target.closed_at !== null) return { actor: registry.asActor(target), ended_calls: [] };
      const open = registry.reports(target.id);
      if (open.length > 0) {
        const names = open.map((report) => report.name).join(", ");
        throw new Conflict(`${target.name} has open reports (${names}); close them first`);
      }
      const closed = registry.close(target.id);
      const ended = calls.endFor(target, actor.id);
      await options.disconnect(target.id);
      return { actor: registry.asActor(closed), ended_calls: ended };
    },

    status_set: async (actor, request) =>
      registry.asActor(
        registry.setStatus(actor.id, {
          state: request.state,
          summary: request.summary,
          updated_at: now(),
        }),
      ),

    view: async (actor, request) => {
      const target = request.actor === undefined ? actor : registry.found(request.actor);
      if (target.id !== actor.id && target.manager !== actor.id && !isRoot(actor)) {
        throw new Forbidden(`you see yourself and your direct reports, not ${target.name}`);
      }
      const pending = store.calls.pendingTo(target.id);
      const openCalls = store.calls.pendingFrom(target.id);
      const history = store.calls.settled(target.id, HISTORY_MAX);
      const manager = target.manager === null ? undefined : registry.get(target.manager);
      return {
        actor: registry.asActor(target),
        manager: manager ? registry.asActor(manager) : null,
        reports: registry.reports(target.id).map((report) => registry.asActor(report)),
        pending,
        open_calls: openCalls,
        history,
        names: registry.names(
          [...pending, ...openCalls, ...history].flatMap((call) => [call.from, call.to]),
        ),
      };
    },

    progress_set: async (actor, request) => communication.setProgress(actor, request),
    team: async (actor, request) => communication.team(actor, request),
    progress: async (actor, request) => communication.progress(actor, request),
    message_send: async (actor, request) => communication.send(actor, request),
    messages: (actor, request, waiting) => communication.messages(actor, request, waiting),
    message_read: async (actor, request) => communication.read(actor, request),

    call_result: async (actor, request, waiting) => {
      const call = calls.found(request.call);
      if (call.from !== actor.id) throw new Forbidden(`only its caller reads call ${call.id}`);
      return calls.wait(call.id, request.wait * 1000, waiting);
    },

    call_withdraw: async (actor, request) => calls.withdraw(actor, request.call),

    activity: async (actor, request) => {
      if (!isRoot(actor)) throw new Forbidden("only the root reads the activity");
      return { entries: audit.list(request.since, request.limit) };
    },
  };
}
