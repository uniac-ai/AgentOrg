import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_PATHS, PAGE_HEADERS } from "../../../src/clients/web/web.ts";
import { setup } from "./harness.ts";

test("the app's paths serve its index.html under a policy that runs only its own code", async () => {
  const { actor } = await setup();
  for (const path of ["/", "/people/act_1", "/activity"]) {
    const response = await fetch(actor.url + path);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /<div id="root"><\/div>/);
    for (const [name, value] of Object.entries(PAGE_HEADERS)) {
      assert.equal(response.headers.get(name), value, `${path} ${name}`);
    }
  }
  const policy = PAGE_HEADERS["Content-Security-Policy"];
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'self'(;|$)/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  assert.deepEqual(APP_PATHS, ["/", "/people/*", "/activity"]);
});

test("the built index.html loads only scripts and styles from the app's own assets", async () => {
  const { actor } = await setup();
  const html = await (await fetch(`${actor.url}/`)).text();
  assert.doesNotMatch(html, /<style|<script(?![^>]*\bsrc="\/assets\/)/i);

  const script = /<script[^>]*src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? "";
  const response = await fetch(actor.url + script);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /javascript/);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("assets outside the build and unknown paths are not found", async () => {
  const { actor } = await setup();
  for (const path of [
    "/assets/missing.js",
    "/assets/../index.html",
    "/assets/%2e%2e/index.html",
    "/calls/call_1",
    "/nope",
  ]) {
    assert.equal((await fetch(actor.url + path)).status, 404, path);
  }
});
