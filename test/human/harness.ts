/** The human actor over a fake core, and a browser signed in to it. */

import { after } from "node:test";
import { startHuman } from "../../src/human/index.ts";
import { CSRF_HEADER } from "../../src/human/types.ts";
import { until } from "../harness.ts";
import { type FakeCore, fakeCore } from "./fake-core.ts";

const open: { close(): Promise<void> }[] = [];
after(() => Promise.all(open.map((each) => each.close())));

export const DECISION = {
  question: "Keep the v1 tables?",
  context: "The new schema starts fresh. Keeping them costs a migration later.",
  options: [{ label: "Keep" }, { label: "Drop", detail: "Nothing has shipped." }],
  recommendation: "Drop",
};

/** A response's JSON body, read loosely. */
// biome-ignore lint/suspicious/noExplicitAny: the tests read responses loosely.
export const json = async (response: Response | Promise<Response>): Promise<any> =>
  (await response).json();

/** A human actor connected to `core`, a new one each time as after a restart, once it is online. */
export async function human(core: FakeCore) {
  const online = core.onlines();
  const actor = await startHuman({ coreUrl: core.url, credential: core.credential, port: 0 });
  open.push(actor);
  await until("the human actor comes online", () => core.onlines() > online);
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
  const { csrf_token: csrf } = await json(
    fetch(`${url}/api/session`, { headers: { Cookie: cookie } }),
  );
  const get = (path: string) => fetch(url + path, { headers: { Cookie: cookie } });
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(url + path, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        [CSRF_HEADER]: csrf,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  /** The calls waiting on the user once they are `calls`. */
  const pending = async (...calls: string[]) => {
    let listed: { call: string }[] = [];
    for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
      listed = (await json(get("/api/pending"))).pending;
      if (listed.map((each) => each.call).join() === calls.join()) return listed;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `never happened: the queue holds ${calls.join(", ")}; it holds ${listed.map((each) => each.call)}`,
    );
  };
  return { login, cookie, csrf, get, post, pending };
}

/** A fake core, a human actor connected to it, and a signed-in browser. */
export async function setup() {
  const core = await fakeCore();
  open.push(core);
  const actor = await human(core);
  return { core, actor, ...(await browser(actor.url, core.credential)) };
}
