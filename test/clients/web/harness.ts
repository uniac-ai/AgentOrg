/** The web client on a real core, a browser signed in to it, and program actors under the root. */

import { after } from "node:test";
import { startWeb } from "../../../src/clients/web/index.ts";
import { CSRF_HEADER } from "../../../src/clients/web/types.ts";
import { fakeActor, iface, startCore, until } from "../../harness.ts";

const open: { close(): Promise<void> }[] = [];
after(() => Promise.allSettled(open.map((each) => each.close())));

export type Core = Awaited<ReturnType<typeof startCore>>;

/** A response's JSON body, read loosely. */
// biome-ignore lint/suspicious/noExplicitAny: the tests read responses loosely.
export const json = async (response: Response | Promise<Response>): Promise<any> =>
  (await response).json();

/** A core on a free port, closed after the tests. */
export async function core(): Promise<Core> {
  const started = await startCore({ waitMs: 50, stepMs: 20 });
  open.push(started);
  return started;
}

export const online = (core: Core) => core.org.connections.link(core.rootId) !== undefined;

/** A web client on `core`, a new one each time as after a restart, once the root is online. */
export async function human(core: Core) {
  const actor = await startWeb({ coreUrl: core.url, credential: core.root, port: 0 });
  open.push(actor);
  await until("the web client comes online", () => online(core));
  return actor;
}

/** A browser's session: its cookie and CSRF token, and reads and writes that carry them. */
export async function browser(url: string, credential: string) {
  const link = await fetch(`${url}/signin/link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}` },
  });
  const { path } = await json(link);
  const login = await fetch(url + path, { redirect: "manual" });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const session = await json(fetch(`${url}/api/session`, { headers: { Cookie: cookie } }));
  const get = (path: string) => fetch(url + path, { headers: { Cookie: cookie } });
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(url + path, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        [CSRF_HEADER]: session.csrf_token,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { login, cookie, csrf: session.csrf_token as string, get, post };
}

export const REVIEW = iface("review", {
  input: { type: "object", properties: { change: { type: "string" } }, required: ["change"] },
  output: {
    type: "object",
    properties: { verdict: { type: "string" } },
    required: ["verdict"],
  },
});

/** A program actor under the root, created by the user through the web app's API, exposing `review`. */
export async function program(
  core: Core,
  post: (path: string, body: unknown) => Promise<Response>,
  name = "storage",
) {
  const { actor, credential } = await json(
    post("/api/interfaces/actor_create", { name, purpose: "Move storage." }),
  );
  const reviews = fakeActor([REVIEW], async (input) => ({
    value: { verdict: `looked at ${input.change}` },
  }));
  const connection = await core.connect(credential, reviews);
  await until(`${name} comes online`, () => core.org.connections.link(actor.id) !== undefined);
  return { id: actor.id as string, received: reviews.received, connection };
}

/** A core, a web client on it, a signed-in browser, and a program actor under the root. */
export async function setup() {
  const started = await core();
  const actor = await human(started);
  const signedIn = await browser(actor.url, started.root);
  return {
    core: started,
    actor,
    ...signedIn,
    storage: await program(started, signedIn.post),
  };
}
