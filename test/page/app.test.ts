import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_PATHS, PAGE_HEADERS } from "../../src/page/index.ts";
import { harness } from "./harness.ts";

test("the app's paths serve its index.html under a policy that runs only its own code", async () => {
  const { app } = await harness();
  for (const path of [
    "/",
    "/inbox",
    "/inbox/asks/ask_1",
    "/people/agt_1",
    "/people/agt_1/asks/ask_1",
  ]) {
    const response = await app.request(path);
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
  assert.deepEqual(APP_PATHS, ["/", "/inbox", "/inbox/*", "/people/*"]);
});

test("the built index.html loads only scripts and styles from the app's own assets", async () => {
  const { app } = await harness();
  const html = await (await app.request("/")).text();
  assert.doesNotMatch(html, /<style|<script(?![^>]*\bsrc="\/assets\/)/i);

  const script = /<script[^>]*src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? "";
  const response = await app.request(script);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /javascript/);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("assets outside the build and unknown paths are not found", async () => {
  const { app } = await harness();
  for (const path of [
    "/assets/missing.js",
    "/assets/../index.html",
    "/assets/%2e%2e/index.html",
    "/nope",
  ]) {
    assert.equal((await app.request(path)).status, 404, path);
  }
});
