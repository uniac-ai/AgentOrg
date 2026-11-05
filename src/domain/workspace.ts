/** Explicit package-client bindings under the canonical admitted Hub Actor. */
import { bindWorkspace, type WorkspaceClients } from "@uniac/agentic-workspace";
import type { ActorAuthority } from "@uniac/agentic-workspace/actors";
import { WorkspaceError } from "@uniac/agentic-workspace/contracts";
import type { WorkspaceStore } from "@uniac/agentic-workspace/persistence";
import { Conflict, Forbidden, Invalid, NotFound } from "./errors.ts";
import { MESSAGES, WORK } from "./model/workspace.ts";
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
    // Called only for a revalidated active caller; the person is never closed.
    person: () => (registry.root() as ActorRow).id,
  };
  /** Run an operation on the package clients bound to the admitted Actor, mapping its refusals. */
  function run<T>(actor: ActorRow, operation: (clients: WorkspaceClients) => T): T {
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
  return {
    run,
    tools: [
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
        work_answer: (actor, request) => run(actor, (clients) => clients.work.answer(request)),
      }),
    ],
  };
}

export type Workspace = ReturnType<typeof workspace>;
