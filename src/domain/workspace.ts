/** Explicit package-client bindings under the canonical admitted Hub Actor. */
import { bindWorkspace } from "@uniac/agentic-workspace";
import type { ActorAuthority } from "@uniac/agentic-workspace/actors";
import { WorkspaceError } from "@uniac/agentic-workspace/contracts";
import type { WorkspaceStore } from "@uniac/agentic-workspace/persistence";
import { Conflict, Forbidden, Invalid, NotFound } from "./errors.ts";
import { DIRECTORY, FORMS, MESSAGES, STATUS, WORK } from "./model/workspace.ts";
import type { ActorRow } from "./ports.ts";
import type { Registry } from "./registry.ts";
import { bindTool } from "./tools.ts";

export function workspace(registry: Registry, store: WorkspaceStore) {
  const profile = (actor: ActorRow) => ({
    actorID: actor.id,
    name: actor.name,
    purpose: actor.purpose,
    state: actor.closed_at === null ? ("active" as const) : ("closed" as const),
  });
  const authority: ActorAuthority = {
    get(callerID, actorID) {
      if (registry.get(callerID)?.closed_at !== null) return undefined;
      const actor = registry.get(actorID);
      return actor === undefined ? undefined : profile(actor);
    },
    list(callerID, query) {
      if (registry.get(callerID)?.closed_at !== null) throw new Forbidden("the Actor is closed");
      const page = registry.directory(query.after, query.limit);
      return { ...page, items: page.items.map(profile) };
    },
    within(callerID, actorID, ancestorID) {
      if (registry.get(callerID)?.closed_at !== null) throw new Forbidden("the Actor is closed");
      return registry.within(actorID, ancestorID);
    },
  };
  function run<T>(actor: ActorRow, operation: (clients: ReturnType<typeof bindWorkspace>) => T): T {
    try {
      return operation(bindWorkspace(authority, store, actor.id));
    } catch (error) {
      if (error instanceof WorkspaceError) {
        const refusal = {
          invalid_input: Invalid,
          not_found: NotFound,
          forbidden: Forbidden,
          conflict: Conflict,
        }[error.code];
        throw new refusal(error.message);
      }
      throw error;
    }
  }
  return [
    bindTool(DIRECTORY, {
      actor_get: (actor, request) => run(actor, (clients) => clients.actors.get(request)),
      actor_list: (actor, request) => run(actor, (clients) => clients.actors.list(request)),
    }),
    bindTool(MESSAGES, {
      message_send: (actor, request) => run(actor, (clients) => clients.messages.send(request)),
      message_get: (actor, request) => run(actor, (clients) => clients.messages.get(request)),
      message_list: (actor, request) => run(actor, (clients) => clients.messages.list(request)),
    }),
    bindTool(WORK, {
      work_create: (actor, request) => run(actor, (clients) => clients.work.create(request)),
      work_get: (actor, request) => run(actor, (clients) => clients.work.get(request)),
      work_list: (actor, request) => run(actor, (clients) => clients.work.list(request)),
      work_update: (actor, request) => run(actor, (clients) => clients.work.update(request)),
      work_submit: (actor, request) => run(actor, (clients) => clients.work.submit(request)),
      work_review: (actor, request) => run(actor, (clients) => clients.work.review(request)),
    }),
    bindTool(FORMS, {
      form_create: (actor, request) => run(actor, (clients) => clients.forms.create(request)),
      form_get: (actor, request) => run(actor, (clients) => clients.forms.get(request)),
      form_list: (actor, request) => run(actor, (clients) => clients.forms.list(request)),
      form_respond: (actor, request) => run(actor, (clients) => clients.forms.respond(request)),
      form_close: (actor, request) => run(actor, (clients) => clients.forms.close(request)),
    }),
    bindTool(STATUS, {
      status_set: (actor, request) => run(actor, (clients) => clients.status.set(request)),
      status_get: (actor, request) => run(actor, (clients) => clients.status.get(request)),
    }),
  ];
}
