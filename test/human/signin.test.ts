import assert from "node:assert/strict";
import { test } from "node:test";
import { LINK_MS, SESSION_MS, SignIn } from "../../src/human/signin.ts";
import { CSRF_HEADER } from "../../src/human/types.ts";
import { json, setup } from "./harness.ts";

test("a sign-in link takes the root credential, and never comes from a web page", async () => {
  const { actor, core } = await setup();
  const mint = (headers: Record<string, string>) =>
    fetch(`${actor.url}/signin/link`, { method: "POST", headers });

  for (const headers of [{}, { Authorization: "Bearer not-the-credential" }] as Record<
    string,
    string
  >[]) {
    const refused = await mint(headers);
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get("www-authenticate"), "Bearer");
  }
  const fromPage = await mint({
    Authorization: `Bearer ${core.credential}`,
    Origin: "http://127.0.0.1:8741",
  });
  assert.equal(fromPage.status, 403);
  const minted = await mint({ Authorization: `Bearer ${core.credential}` });
  assert.match((await json(minted)).path, /^\/signin\?token=[\w-]{43}$/);
});

test("a sign-in link sets an HttpOnly, SameSite=Strict cookie and opens the app", async () => {
  const { login, get } = await setup();
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/");
  const [pair = "", ...attributes] = (login.headers.get("set-cookie") ?? "").split(";");
  assert.match(pair, /^agentorg_human=.+/);
  const flags = attributes.map((attribute) => attribute.trim().toLowerCase());
  for (const flag of ["httponly", "samesite=strict", "path=/"])
    assert.ok(flags.includes(flag), flag);
  assert.ok(flags.some((flag) => flag.startsWith("expires=")));
  const session = await get("/api/session");
  assert.equal(session.status, 200);
  assert.equal(session.headers.get("cache-control"), "no-store");
});

test("a sign-in link works once", async () => {
  const { actor, core } = await setup();
  const minted = await fetch(`${actor.url}/signin/link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${core.credential}` },
  });
  const { path } = await json(minted);
  assert.ok((await fetch(actor.url + path, { redirect: "manual" })).headers.get("set-cookie"));
  const again = await fetch(actor.url + path, { redirect: "manual" });
  assert.equal(again.status, 303);
  assert.equal(again.headers.get("set-cookie"), null);
});

test("without a current session, every API route answers signed out", async () => {
  const { actor, cookie } = await setup();
  const [name, value = ""] = cookie.split("=");
  const tampered = `${name}=${value.slice(0, -2)}xx`;
  for (const header of [undefined, "agentorg_human=unknown", tampered]) {
    for (const [method, path] of [
      ["GET", "/api/session"],
      ["GET", "/api/pending"],
      ["GET", "/api/view"],
      ["POST", "/api/pending/call_1"],
      ["POST", "/api/tools/view"],
    ] as const) {
      const response = await fetch(actor.url + path, {
        method,
        headers: header ? { Cookie: header } : {},
      });
      assert.equal(response.status, 401, `${method} ${path} with ${header}`);
      assert.deepEqual(await json(response), {
        code: "signed_out",
        message: "Run agentorg ui to sign in.",
      });
    }
  }
});

test("every write carries the session's CSRF token", async () => {
  const { core, post, csrf, pending } = await setup();
  const call = core.deliver("note", { text: "Read me." });
  await pending(call);
  for (const token of [undefined, "", `${csrf.slice(0, -1)}x`]) {
    const headers = token === undefined ? {} : { [CSRF_HEADER]: token };
    const response = await post(`/api/pending/${call}`, {}, { [CSRF_HEADER]: "", ...headers });
    assert.equal(response.status, 403);
    assert.equal((await json(response)).code, "forbidden");
  }
  assert.equal(core.calls.get(call)?.state, "pending");
  assert.equal((await post(`/api/pending/${call}`)).status, 200);
});

test("sessions and links expire, and a new credential ends every session", () => {
  let now = 1_000_000;
  const signIn = new SignIn("a credential", () => now);
  const late = signIn.link();
  now += LINK_MS;
  assert.equal(
    signIn.redeem(new URLSearchParams(late.path.split("?")[1]).get("token") ?? ""),
    undefined,
  );

  const token = new URLSearchParams(signIn.link().path.split("?")[1]).get("token") ?? "";
  const session = signIn.redeem(token);
  assert.ok(session);
  assert.ok(signIn.session(session.cookie));
  assert.equal(new SignIn("another credential", () => now).session(session.cookie), undefined);
  now += SESSION_MS;
  assert.equal(signIn.session(session.cookie), undefined);
});
