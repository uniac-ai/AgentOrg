import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { harness, LOGIN_TOKEN } from "./fake-service.ts";

test("a login link sets an HttpOnly, SameSite=Strict cookie and opens the page", async () => {
  const page = harness();

  const response = await page.signIn();

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  const [pair, ...attributes] = (response.headers.get("set-cookie") ?? "").split(";");
  assert.equal(pair, "agentorg_page=page_1");
  const flags = attributes.map((attribute) => attribute.trim().toLowerCase());
  for (const flag of ["httponly", "samesite=strict", "path=/"])
    assert.ok(flags.includes(flag), flag);
  assert.ok(flags.some((flag) => flag.startsWith("expires=")));

  const signedIn = await page.get("/");
  assert.equal(signedIn.status, 200);
  assert.match(await signedIn.text(), /Waiting on you/);
});

test("a login link works once", async () => {
  const page = harness();
  await page.signIn();

  const again = await page.app.request(`/ui/login?token=${LOGIN_TOKEN}`);

  assert.equal(again.status, 401);
  assert.equal(again.headers.get("set-cookie"), null);
  assert.match(await again.text(), /This sign-in link is used or expired\./);
});

test("without a page session every page is signed out, with no bearer challenge", async () => {
  const page = harness();
  page.fake.addAgent("lead");

  for (const path of ["/", "/agents/lead"]) {
    const response = await page.get(path);
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get("www-authenticate"), null);
    const body = await response.text();
    assert.match(body, /Signed out/);
    assert.match(body, /agentorg ui/);
  }
  const unknown = await page.app.request("/", { headers: { Cookie: "agentorg_page=page_9" } });
  assert.equal(unknown.status, 401);
});

test("every page allows only its own stylesheet: no scripts, no framing, no caching", async () => {
  const page = harness();
  const signedOut = await page.get("/");
  await page.signIn();
  const signedIn = await page.get("/");

  for (const response of [signedOut, signedIn]) {
    const policy = response.headers.get("content-security-policy") ?? "";
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.doesNotMatch(policy, /script-src/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const style = /<style>([\s\S]*?)<\/style>/.exec(await response.text())?.[1] ?? "";
    const hash = createHash("sha256").update(style).digest("base64");
    assert.ok(policy.includes(`style-src 'sha256-${hash}'`));
  }
});
