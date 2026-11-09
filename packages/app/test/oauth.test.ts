import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Refused } from "@agentorg/sdk";
import { oauthRoute } from "../src/index.ts";

/** A request to the route, as a browser coming back from ChatGPT would make it. */
function get(origin: string, path: string, method = "GET") {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (done, fail) => {
      const req = request(`${origin}${path}`, { method }, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          done({ status: response.statusCode ?? 0, body, headers: response.headers }),
        );
      });
      req.on("error", fail);
      req.end();
    },
  );
}

test("/oauth/chatgpt completes the sign-in through the person's login, and keeps the code out of the tab", async (t) => {
  const completed: string[] = [];
  let refuse: string | undefined;
  const route = oauthRoute({
    call: async (slot, method, input) => {
      assert.deepEqual([slot, method], ["login", "complete"]);
      completed.push((input as { callbackUrl: string }).callbackUrl);
      if (refuse) throw new Refused(refuse as "denied", "No.");
      return { account: {} };
    },
  });
  let origin = "";
  const server = createServer((req, res) => route(req, res, new URL(req.url ?? "/", origin)));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => server.close());

  const callback = "/oauth/chatgpt?code=SECRET-CODE&state=s1";
  /** The callback, then where it sends the tab: an address without the code. */
  const back = async () => {
    const sent = await get(origin, callback);
    assert.equal(sent.status, 303);
    const location = String(sent.headers.location);
    assert.doesNotMatch(location + sent.body, /SECRET-CODE|state=/);
    assert.equal(sent.headers["referrer-policy"], "no-referrer");
    return get(origin, location);
  };
  const done = await back();
  assert.equal(done.status, 200);
  assert.match(done.body, /Signed in to ChatGPT/);
  assert.doesNotMatch(done.body, /SECRET-CODE/);
  assert.equal(done.headers["referrer-policy"], "no-referrer");
  assert.equal(done.headers["cache-control"], "no-store");
  // The whole address it came back to, as the login compares it with the redirect.
  assert.deepEqual(completed, [`${origin}${callback}`]);

  for (const [code, says] of [
    ["denied", /You declined/],
    ["expired", /expired/],
    ["failed", /didn't work/],
  ] as const) {
    refuse = code;
    const refused = await back();
    assert.equal(refused.status, 400);
    assert.match(refused.body, says);
    assert.doesNotMatch(refused.body, /SECRET-CODE|No\./);
  }
  assert.equal((await get(origin, callback, "POST")).status, 405);
  // An outcome page made up by hand says only what it says; it completes nothing.
  assert.match((await get(origin, "/oauth/chatgpt?result=bogus")).body, /didn't work/);
  assert.equal(completed.length, 4);
});
