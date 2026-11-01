/** A real Hub over a fresh store on a free port, with owned caller connections. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, connectClient } from "../src/actor/index.ts";
import type { Answer, InterfaceDescriptor } from "../src/domain/model/index.ts";
import { type CoreOptions, rootCredential, startCore as start } from "../src/server/index.ts";
import { SqliteStore } from "../src/storage/sqlite/index.ts";

export const HUB_INTERFACES = {
  actors: ["actor_create", "actor_close"],
  team: ["team"],
  directory: ["actor_get", "actor_list"],
  messages: ["message_send", "message_get", "message_list"],
  work: ["work_create", "work_get", "work_list", "work_update", "work_submit", "work_review"],
  forms: ["form_create", "form_get", "form_list", "form_respond", "form_close"],
  status: ["status_set", "status_get"],
  claims: ["claim", "release"],
  activity: ["activity"],
  system: ["system_status", "connection_list", "provider_list", "connection_disconnect"],
};

export async function startCore(options: CoreOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agentorg-core-"));
  const credentialFile = join(directory, "root-credential");
  let store = new SqliteStore(join(directory, "core.db"));
  let running = await start(store, { ...options, port: 0 });
  const root = await rootCredential(running.organization.registry, credentialFile);
  const url = running.url;
  const port = Number(new URL(url).port);
  const actors: Actor[] = [];
  const stop = async () => {
    await running.close();
    store.close();
  };
  return {
    get org() {
      return running.organization;
    },
    get store() {
      return store;
    },
    provider: (id: string) => running.provider(id),
    url,
    root,
    rootId: running.organization.registry.root()?.id as string,
    credentialFile,
    drop: () => running.drop(),
    async client(credential: string) {
      const actor = await running.organization.registry.byCredential(credential);
      if (!actor) throw new Error("the test credential has no open Actor");
      const connection = await connectClient({
        url,
        actorId: actor.id,
        credential,
        maxRetryMs: 100,
      });
      actors.push(connection);
      return connection;
    },
    async restart() {
      await stop();
      store = new SqliteStore(join(directory, "core.db"));
      running = await start(store, { ...options, port });
    },
    async close() {
      await Promise.allSettled(actors.map((actor) => actor.close()));
      await stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export type Core = Awaited<ReturnType<typeof startCore>>;

export const iface = (
  name: string,
  extra: Partial<InterfaceDescriptor> = {},
): InterfaceDescriptor => ({
  name,
  input: { type: "object" },
  one_way: false,
  long_running: false,
  ...extra,
});

/** A generous liveness guard, named for the condition that must eventually hold. */
export async function until(
  what: string,
  condition: () => boolean | Promise<boolean>,
  guardMs = 5000,
) {
  const deadline = Date.now() + guardMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// biome-ignore lint/suspicious/noExplicitAny: tests inspect public result fields directly.
export type Json = any;

export async function done(answer: Answer | Promise<Answer>): Promise<Json> {
  const settled = await answer;
  if (settled.state !== "done") throw new Error(`not done: ${JSON.stringify(settled)}`);
  return settled.value;
}

export async function refused(answer: Answer | Promise<Answer>): Promise<string> {
  const settled = await answer;
  if (settled.state !== "refused") throw new Error(`not refused: ${JSON.stringify(settled)}`);
  return settled.code;
}
