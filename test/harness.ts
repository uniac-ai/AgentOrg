/** A real core over a fresh store on a free port, and fake actors on the actor library. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Actor,
  connectActor,
  connectClient,
  type Exposed,
  type Incoming,
  type Reply,
} from "../src/actor/index.ts";
import type { Answer, InterfaceDescriptor } from "../src/domain/model/index.ts";
import { type CoreOptions, rootCredential, startCore as start } from "../src/server/index.ts";
import { SqliteStore } from "../src/storage/sqlite/index.ts";

export async function startCore(options: CoreOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agentorg-core-"));
  const credentialFile = join(directory, "root-credential");
  let store = new SqliteStore(join(directory, "core.db"));
  let running = await start(store, { ...options, port: 0 });
  const root = await rootCredential(running.organization.registry, credentialFile);
  const url = running.url;
  const port = Number(new URL(url).port);
  const actors: Actor[] = [];
  const actorId = async (credential: string) => {
    const actor = await running.organization.registry.byCredential(credential);
    if (!actor) throw new Error("the test credential has no open Actor");
    return actor.id;
  };
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
    url,
    /** The root's credential. */
    root,
    rootId: running.organization.registry.root()?.id as string,
    credentialFile,
    /** End every actor's channel, as a lost network would. */
    drop: () => running.drop(),
    /** Connect a fake actor with this credential, closed with the core. */
    async connect(credential: string, actor: FakeActor = fakeActor()) {
      const connection = await connectActor({
        url,
        actorId: await actorId(credential),
        credential,
        exposed: actor.exposed,
        maxRetryMs: 100,
      });
      actors.push(connection);
      return connection;
    },
    /** Connect a client that only calls. */
    async client(credential: string) {
      const connection = await connectClient({
        url,
        actorId: await actorId(credential),
        credential,
      });
      actors.push(connection);
      return connection;
    },
    /** Stop the core and start it again on the same database and port. */
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

export interface Received {
  name: string;
  input: Record<string, unknown>;
  call: Incoming;
}

/** A long-running call the actor holds, which the test finishes. */
export interface Held extends Received {
  complete(reply: Reply): void;
  fail(message: string): void;
}

export interface FakeActor {
  exposed: Exposed[];
  /** Calls the actor received, in order. */
  received: Received[];
  /** Long-running calls it holds, in order. */
  held: Held[];
}

/**
 * An actor exposing `interfaces`, answering each call with `handler`. A long-running interface's
 * call is held until the test completes it.
 */
export function fakeActor(
  interfaces: InterfaceDescriptor[] = [],
  handler: (input: Record<string, unknown>, call: Incoming) => Promise<Reply> = async () => ({}),
): FakeActor {
  const actor: FakeActor = { exposed: [], received: [], held: [] };
  actor.exposed = interfaces.map((each) => ({
    interface: each,
    handle: (input, call) => {
      actor.received.push({ name: each.name, input, call });
      if (!each.long_running) return handler(input, call);
      return new Promise<Reply>((resolve, reject) => {
        actor.held.push({
          name: each.name,
          input,
          call,
          complete: resolve,
          fail: (message) => reject(new Error(message)),
        });
      });
    },
  }));
  return actor;
}

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

/** Wait until `condition` holds, failing after a generous guard that names what never happened. */
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

// biome-ignore lint/suspicious/noExplicitAny: the tests read results loosely.
export type Json = any;

/** The value of a done answer, failing on any other. */
export async function done(answer: Answer | Promise<Answer>): Promise<Json> {
  const settled = await answer;
  if (settled.state !== "done") throw new Error(`not done: ${JSON.stringify(settled)}`);
  return settled.value;
}

/** The code of a refused answer, failing on any other. */
export async function refused(answer: Answer | Promise<Answer>): Promise<string> {
  const settled = await answer;
  if (settled.state !== "refused") throw new Error(`not refused: ${JSON.stringify(settled)}`);
  return settled.code;
}
