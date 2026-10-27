import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./harness.ts";

test("a login link sets an HttpOnly, SameSite=Strict cookie and opens the app", async () => {
  const { login, get } = await harness();

  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/");
  const [pair = "", ...attributes] = (login.headers.get("set-cookie") ?? "").split(";");
  assert.match(pair, /^agentorg_page=.+/);
  const flags = attributes.map((attribute) => attribute.trim().toLowerCase());
  for (const flag of ["httponly", "samesite=strict", "path=/"]) {
    assert.ok(flags.includes(flag), flag);
  }
  assert.ok(flags.some((flag) => flag.startsWith("expires=")));
  assert.equal((await get("/ui/api/session")).status, 200);
});

test("a login link works once; a used one opens the app without signing in", async () => {
  const { service, app } = await harness();
  const link = await service.ui_login_link({}, { channel: "api" });
  await app.request(link.path);

  const again = await app.request(link.path);

  assert.equal(again.status, 303);
  assert.equal(again.headers.get("location"), "/");
  assert.equal(again.headers.get("set-cookie"), null);
});

test("without a page session, every page route answers signed out, with no bearer challenge", async () => {
  const { app } = await harness();
  for (const cookie of [undefined, "agentorg_page=unknown"]) {
    const response = await app.request("/ui/api/session", {
      headers: cookie ? { Cookie: cookie } : {},
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), null);
    assert.deepEqual(await response.json(), {
      code: "signed_out",
      message: "Run agentorg ui to sign in.",
    });
  }
});

test("the session bootstrap hands the app its page session's CSRF token", async () => {
  const { get, csrf } = await harness();
  const response = await get("/ui/api/session");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(((await response.json()) as { csrf_token: string }).csrf_token, csrf);
});
