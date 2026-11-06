import assert from "node:assert/strict";
import test from "node:test";
import { createTestContext } from "@agentorg/sdk/testing";
import model from "../src/model.ts";
import { completed, delta, type FakeOpenAI, fakeOpenAI, text } from "./fake-openai.ts";

const REDIRECT = "http://127.0.0.1:4321/oauth/chatgpt";
type Model = ReturnType<typeof createTestContext<typeof model.slots, typeof model.exports>>;
/** The fields of the replies these tests read. */
interface Reply {
  authorizeUrl: string;
  state: string;
  output: unknown[];
}

/** The model Actor with the fake bound to `web` and an in-memory store bound to `store`. */
async function setup(t: test.TestContext, openai?: FakeOpenAI) {
  const fake = openai ?? (await fakeOpenAI());
  const values = new Map<string, unknown>();
  const actor = createTestContext(model, { actorId: "chatgpt", module: "model" });
  await actor.start();
  actor.bind("web", (request) => fake.handle(request));
  actor.bind("store", {
    get: ({ key }) => (values.has(key) ? { value: values.get(key) as never } : {}),
    set: ({ key, value }) => {
      values.set(key, value);
      return {};
    },
    delete: ({ key }) => ({ deleted: values.delete(key) }),
  });
  // Every test ends by checking no token the fake issued reached anything outside the Actor.
  const seen: unknown[] = [];
  t.after(() => assertNoSecrets(fake, [actor.emitted, actor.logs, seen]));
  const call = async (exp: "login" | "session", method: string, input: unknown = {}) => {
    try {
      const reply = await actor.call(exp, method, input);
      seen.push(reply);
      return reply as Reply;
    } catch (error) {
      seen.push(String(error), (error as Error).message);
      throw error;
    }
  };
  return { actor, fake, values, call };
}

function assertNoSecrets(fake: FakeOpenAI, outside: unknown[]) {
  const text = JSON.stringify(outside);
  for (const secret of fake.secrets) assert.ok(!text.includes(secret), "a token left the Actor");
}

type Setup = Awaited<ReturnType<typeof setup>>;
async function signIn(s: Setup) {
  const { authorizeUrl } = await s.call("login", "start", { redirectUri: REDIRECT });
  return s.call("login", "complete", { callbackUrl: await s.fake.authorize(authorizeUrl) });
}
const events = (actor: Model, name: string) =>
  actor.emitted.filter((e) => e.event === name).map((e) => e.payload);

test("a first sign-in registers dynamically; a later one reuses the issued client id", async (t) => {
  const s = await setup(t);
  assert.deepEqual(await s.call("login", "status"), { state: "signed_out" });
  const { authorizeUrl } = await s.call("login", "start", { redirectUri: REDIRECT });
  const first = new URL(authorizeUrl).searchParams;
  assert.equal(new URL(authorizeUrl).origin, "https://auth.openai.com");
  assert.equal(first.get("client_id"), "dynamic_agent_client");
  assert.equal(first.get("agent_name_hint"), "AgentOrg");
  assert.match(first.get("ext_agent_host_id") ?? "", /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(
    first.get("scope"),
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  );
  assert.equal(first.get("resource"), "https://api.openai.com/v1");
  assert.equal(first.get("code_challenge_method"), "S256");
  assert.equal(first.get("redirect_uri"), REDIRECT);
  for (const name of ["state", "nonce", "code_challenge"]) assert.ok(first.get(name));
  const done = await s.call("login", "complete", {
    callbackUrl: await s.fake.authorize(authorizeUrl),
  });
  assert.deepEqual(done, { account: { email: "person@example.com", plan: "plus" } });
  assert.deepEqual(await s.call("login", "status"), {
    state: "signed_in",
    account: { email: "person@example.com", plan: "plus" },
  });
  assert.deepEqual(events(s.actor, "changed"), [{ state: "signed_in" }]);
  const [issued] = [...s.fake.clients.keys()];
  assert.match(issued ?? "", /^oaiapp_/);

  assert.deepEqual(await s.call("login", "logout"), { revoked: true });
  const again = new URL((await s.call("login", "start", { redirectUri: REDIRECT })).authorizeUrl);
  assert.equal(again.searchParams.get("client_id"), issued);
  assert.equal(again.searchParams.get("agent_name_hint"), null);
  assert.equal(again.searchParams.get("ext_agent_host_id"), first.get("ext_agent_host_id"));
  // A re-authorization's callback may leave the client id out.
  await s.call("login", "complete", { callbackUrl: await s.fake.authorize(again.toString()) });
  assert.equal(s.fake.clients.size, 1);
  assert.equal((await s.call("login", "status")).state, "signed_in");
});

test("a sign-in that doesn't check out is refused and nothing is kept", async (t) => {
  const s = await setup(t);
  const start = async () =>
    (await s.call("login", "start", { redirectUri: REDIRECT })).authorizeUrl;
  const refused = async (callbackUrl: string, code: string) => {
    await assert.rejects(s.call("login", "complete", { callbackUrl }), { name: "Refused", code });
    assert.equal((await s.call("login", "status")).state, "signed_out");
  };
  await refused(`${REDIRECT}?code=c&state=never-started`, "expired");
  const elsewhere = await s.fake.authorize(await start());
  await refused(elsewhere.replace("/oauth/chatgpt", "/oauth/other"), "invalid");
  await refused(await s.fake.authorize(await start(), "deny"), "denied");
  s.fake.options.withholdClientId = true;
  await refused(await s.fake.authorize(await start()), "failed");
  s.fake.options.withholdClientId = false;
  // Each attempt can be completed once.
  const once = await s.fake.authorize(await start());
  await s.call("login", "complete", { callbackUrl: once });
  await s.call("login", "logout");
  await refused(once, "expired");
  // A re-authorization naming another client is refused.
  const swapped = new URL(await s.fake.authorize(await start()));
  swapped.searchParams.set("client_id", "oaiapp_someone_else");
  await refused(swapped.toString(), "failed");
  for (const tamper of [
    "signature",
    "nonce",
    "issuer",
    "audience",
    "expired",
    "alg-none",
    "alg-hs256",
  ] as const) {
    s.fake.options.tamper = tamper;
    await refused(await s.fake.authorize(await start()), "failed");
  }
  s.fake.options.scope = "openid profile email offline_access";
  await refused(await s.fake.authorize(await start()), "failed");
});

test("refresh rotates the refresh token, one refresh at a time", async (t) => {
  const s = await setup(t);
  await signIn(s);
  // Tokens near expiry are refreshed before use: the access token still works, yet no request
  // goes out with it.
  const held = s.values.get("credential") as { refreshToken: string; expiresAt: number };
  s.values.set("credential", { ...held, expiresAt: Date.now() + 1000 });
  s.fake.options.refreshDelay = 50;
  const replies = await Promise.all(
    ["r1", "r2", "r3"].map((requestId) =>
      s.call("session", "respond", { requestId, model: "gpt-test", instructions: "", input: [] }),
    ),
  );
  assert.equal(replies.length, 3);
  assert.equal(s.fake.refreshes, 1);
  assert.equal(s.fake.requests.filter((r) => r.status === 401).length, 0);
  const rotated = s.values.get("credential") as { refreshToken: string };
  assert.notEqual(rotated.refreshToken, held.refreshToken);
  // The old refresh token was used once, so OpenAI would refuse it again.
  s.values.set("credential", { ...rotated, refreshToken: held.refreshToken, expiresAt: 0 });
  await assert.rejects(
    s.call("session", "respond", { requestId: "r4", instructions: "", input: [] }),
    {
      code: "not_signed_in",
    },
  );
  assert.equal((await s.call("login", "status")).state, "signed_out");
});

for (const code of [
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
])
  test(`a refresh refused with ${code} signs out`, async (t) => {
    const s = await setup(t);
    await signIn(s);
    const held = s.values.get("credential") as object;
    s.values.set("credential", { ...held, expiresAt: 0 });
    s.fake.options.refreshError = code;
    await assert.rejects(s.call("session", "models"), { name: "Refused", code: "not_signed_in" });
    assert.equal((await s.call("login", "status")).state, "signed_out");
    assert.deepEqual(events(s.actor, "changed").at(-1), { state: "signed_out" });
    assert.ok(s.values.has("registration"), "the issued client id is kept");
  });

test("a refresh that can't reach OpenAI keeps the sign-in", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const held = s.values.get("credential") as object;
  s.values.set("credential", { ...held, expiresAt: 0 });
  s.fake.options.offline = true;
  await assert.rejects(s.call("session", "models"), { code: "unavailable" });
  assert.equal((await s.call("login", "status")).state, "signed_in");
});

test("logout revokes at OpenAI, and says so when it couldn't confirm", async (t) => {
  const s = await setup(t);
  await signIn(s);
  assert.deepEqual(await s.call("login", "logout"), { revoked: true });
  assert.equal(s.values.has("credential"), false);
  assert.deepEqual(await s.call("login", "logout"), { revoked: true });
  await signIn(s);
  s.fake.options.revokeStatus = 503;
  assert.deepEqual(await s.call("login", "logout"), { revoked: false });
  assert.equal((await s.call("login", "status")).state, "signed_out");
  await assert.rejects(s.call("session", "models"), { code: "not_signed_in" });
});

test("models lists only those OpenAI marks for listing", async (t) => {
  const s = await setup(t);
  await signIn(s);
  assert.deepEqual(await s.call("session", "models"), {
    models: [{ id: "gpt-test", name: "GPT Test" }],
  });
});

test("respond streams text, returns the output, and sends only what plan usage supports", async (t) => {
  const s = await setup(t);
  await signIn(s);
  s.fake.script({
    events: [
      { type: "response.created" },
      delta("Placing "),
      delta("the board."),
      completed([
        text("Placing the board."),
        { type: "reasoning", summary: [] },
        { type: "function_call", call_id: "call_1", name: "layout__place", arguments: '{"x":1}' },
      ]),
    ],
  });
  const reply = await s.call("session", "respond", {
    requestId: "turn-1",
    instructions: "You are an assistant.",
    input: [
      { type: "message", role: "user", content: "Show the board." },
      { type: "function_call", callId: "c0", name: "layout__get", arguments: "{}" },
      { type: "function_call_output", callId: "c0", output: '{"home":[]}' },
    ],
    tools: [{ name: "layout__place", description: "Place a view", parameters: { type: "object" } }],
  });
  assert.deepEqual(reply, {
    output: [
      { type: "message", role: "assistant", content: "Placing the board." },
      { type: "function_call", callId: "call_1", name: "layout__place", arguments: '{"x":1}' },
    ],
    usage: { inputTokens: 12, outputTokens: 3 },
  });
  assert.deepEqual(events(s.actor, "delta"), [
    { requestId: "turn-1", text: "Placing " },
    { requestId: "turn-1", text: "the board." },
  ]);
  const sent = s.fake.requests.filter((r) => r.url.endsWith("/v1/responses"));
  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0]?.body ?? "{}");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.model, "gpt-test");
  for (const field of ["previous_response_id", "temperature", "max_output_tokens", "top_p"])
    assert.equal(field in body, false, field);
  assert.deepEqual(body.input[1], {
    type: "function_call",
    call_id: "c0",
    name: "layout__get",
    arguments: "{}",
  });
  assert.deepEqual(body.tools, [
    {
      type: "function",
      name: "layout__place",
      description: "Place a view",
      parameters: { type: "object" },
      strict: false,
    },
  ]);
  // Every request went to OpenAI's two hosts and nowhere else.
  for (const { url } of s.fake.requests) assert.match(url, /^https:\/\/(auth|api)\.openai\.com\//);
});

test("only response.completed counts as success", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const ask = (requestId: string) =>
    s.call("session", "respond", { requestId, model: "gpt-test", instructions: "", input: [] });
  s.fake.script(
    { events: [delta("Half")], cut: true },
    { events: [delta("Half")] },
    { events: [{ type: "response.incomplete", response: {} }] },
    {
      events: [
        delta("Starting"),
        {
          type: "response.failed",
          response: { error: { code: "subscription_sharing_usage_limit_exceeded" } },
        },
      ],
    },
    { events: [{ type: "error", code: "subscription_sharing_usage_unavailable" }] },
  );
  await assert.rejects(ask("a"), { code: "failed" });
  await assert.rejects(ask("b"), { code: "failed" });
  await assert.rejects(ask("c"), { code: "failed" });
  await assert.rejects(ask("d"), { code: "usage_limit" });
  await assert.rejects(ask("e"), { code: "unavailable" });
});

test("each plan-usage error is refused as itself, and a usage limit is never retried", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const ask = () =>
    s.call("session", "respond", {
      requestId: crypto.randomUUID(),
      model: "gpt-test",
      instructions: "",
      input: [],
    });
  const responses = () => s.fake.requests.filter((r) => r.url.endsWith("/v1/responses")).length;

  s.fake.script({ status: 429, code: "subscription_sharing_usage_limit_exceeded" });
  const before = responses();
  await assert.rejects(ask(), (error: Error & { code?: string }) => {
    assert.equal(error.code, "usage_limit");
    assert.match(error.message, /https:\/\/chatgpt\.com\/settings\/usage/);
    return true;
  });
  assert.equal(responses() - before, 1, "one request, never retried");

  s.fake.script({ status: 503, code: "subscription_sharing_usage_unavailable" });
  await assert.rejects(ask(), { code: "unavailable" });
  s.fake.script({ status: 503, detail: "direct routing unavailable" });
  await assert.rejects(ask(), { code: "unavailable" });
  assert.equal((await s.call("login", "status")).state, "signed_in");

  s.fake.script({
    status: 400,
    code: "subscription_sharing_unsupported_capability",
    param: "tools[0].type",
  });
  await assert.rejects(ask(), (error: Error & { code?: string }) => {
    assert.equal(error.code, "unsupported");
    assert.match(error.message, /tools\[0\]\.type/);
    return true;
  });
  s.fake.script({ status: 500, code: "server_error" });
  await assert.rejects(ask(), (error: Error & { code?: string }) => {
    assert.equal(error.code, "failed");
    assert.match(error.message, /500 server_error \(request req_/);
    return true;
  });

  s.fake.script({ status: 403, code: "subscription_sharing_user_not_eligible" });
  await assert.rejects(ask(), { code: "ineligible" });
  assert.equal((await s.call("login", "status")).state, "ineligible");
  assert.deepEqual(events(s.actor, "changed").at(-1), { state: "ineligible" });
  // Ineligible stays so, without asking OpenAI again, until the next sign-in.
  const after = responses();
  await assert.rejects(ask(), { code: "ineligible" });
  assert.equal(responses(), after);
  await signIn(s);
  assert.equal((await s.call("login", "status")).state, "signed_in");
});

test("a 401 refreshes once and tries once more", async (t) => {
  const s = await setup(t);
  await signIn(s);
  s.fake.revokeAccess();
  const reply = await s.call("session", "respond", {
    requestId: "r",
    model: "gpt-test",
    instructions: "",
    input: [],
  });
  assert.equal(reply.output.length, 1);
  assert.equal(s.fake.refreshes, 1);
  // Not signed in at all: refused before anything goes out.
  await s.call("login", "logout");
  await assert.rejects(s.call("session", "models"), { code: "not_signed_in" });
});

test("cancel stops a response that is still streaming", async (t) => {
  const s = await setup(t);
  await signIn(s);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handle = s.fake.handle;
  let seen: () => void = () => {};
  const requested = new Promise<void>((resolve) => {
    seen = resolve;
  });
  s.actor.bind("web", async (request) => {
    const response = await handle(request);
    if (!request.url.endsWith("/v1/responses")) return response;
    seen();
    const reader = response.body?.getReader();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          await gate;
          const { value, done } = (await reader?.read()) ?? { done: true, value: undefined };
          if (done) controller.close();
          else controller.enqueue(value);
        },
      }),
      { headers: response.headers },
    );
  });
  const reply = s.call("session", "respond", {
    requestId: "slow",
    model: "gpt-test",
    instructions: "",
    input: [],
  });
  await requested;
  assert.deepEqual(await s.call("session", "cancel", { requestId: "slow" }), {});
  release();
  await assert.rejects(reply, { code: "cancelled" });
  // Cancelling something that isn't running does nothing.
  assert.deepEqual(await s.call("session", "cancel", { requestId: "slow" }), {});
});

test("each consumer gets its own streamed text, and cancels only its own requests", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const handle = s.fake.handle;
  const release = new Map<string, () => void>();
  s.actor.bind("web", async (request) => {
    if (!request.url.endsWith("/v1/responses")) return handle(request);
    const who = JSON.parse(await request.clone().text()).instructions as string;
    await new Promise<void>((resolve) => release.set(who, resolve));
    return handle(request);
  });
  s.fake.script(
    { events: [delta("for alice"), completed([text("for alice")])] },
    { events: [delta("for bob"), completed([text("for bob")])] },
  );
  // Two consumers may use the same request id.
  const ask = (caller: string) =>
    s.actor.call(
      "session",
      "respond",
      { requestId: "same", model: "gpt-test", instructions: caller, input: [] },
      caller,
    );
  const alice = ask("alice");
  while (!release.has("alice")) await new Promise((resolve) => setTimeout(resolve, 2));
  const bob = ask("bob");
  while (!release.has("bob")) await new Promise((resolve) => setTimeout(resolve, 2));
  // Bob's cancel stops Bob's request, never Alice's.
  await s.actor.call("session", "cancel", { requestId: "same" }, "bob");
  release.get("alice")?.();
  release.get("bob")?.();
  await alice;
  await assert.rejects(bob, { code: "cancelled" });
  const deltas = s.actor.emitted.filter((e) => e.event === "delta");
  assert.deepEqual(
    deltas.map((e) => [e.to, (e.payload as { text: string }).text]),
    [["alice", "for alice"]],
  );
});

test("a store or web slot left unbound fails clean", async (t) => {
  const actor = createTestContext(model, { actorId: "chatgpt", module: "model" });
  await actor.start();
  await assert.rejects(actor.call("login", "status", {}), { name: "NotConnected" });
  const s = await setup(t);
  await signIn(s);
  s.actor.unbind("web");
  await assert.rejects(
    s.call("session", "respond", {
      requestId: "r",
      model: "gpt-test",
      instructions: "",
      input: [],
    }),
    { name: "NotConnected" },
  );
});

test("signing out during a refresh stays signed out, and the rotated token is revoked", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const held = s.values.get("credential") as object;
  s.values.set("credential", { ...held, expiresAt: 0 });
  s.fake.options.refreshLatency = 100;
  const call = s.call("session", "models").catch(() => undefined);
  while (s.fake.refreshes === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await s.call("login", "logout"), { revoked: true });
  await call;
  assert.equal((await s.call("login", "status")).state, "signed_out");
  assert.equal(s.fake.liveRefreshTokens, 0);
});

test("signing in during a refresh keeps the new sign-in and revokes the old", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const held = s.values.get("credential") as object;
  s.values.set("credential", { ...held, expiresAt: 0 });
  s.fake.options.refreshLatency = 100;
  const call = s.call("session", "models").catch(() => undefined);
  while (s.fake.refreshes === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  s.fake.options.email = "other@example.com";
  await signIn(s);
  await call;
  // The revocation of the replaced sign-in runs in the background.
  for (let i = 0; i < 50 && s.fake.liveRefreshTokens > 1; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await s.call("login", "status"), {
    state: "signed_in",
    account: { email: "other@example.com", plan: "plus" },
  });
  assert.equal(s.fake.liveRefreshTokens, 1);
});

test("a key set that fails, or a key OpenAI rotated, doesn't stop sign-in for good", async (t) => {
  const s = await setup(t);
  s.fake.options.jwksStatus = 500;
  const first = (await s.call("login", "start", { redirectUri: REDIRECT })).authorizeUrl;
  await assert.rejects(
    s.call("login", "complete", { callbackUrl: await s.fake.authorize(first) }),
    { code: "unavailable" },
  );
  // The failed attempt registered a client id that was never kept, so this is a new one.
  await signIn(s);
  assert.equal((await s.call("login", "status")).state, "signed_in");
  await s.fake.rotateKey();
  await s.call("login", "logout");
  await signIn(s);
  assert.equal((await s.call("login", "status")).state, "signed_in");
});

test("a refresh refused for any other reason keeps the sign-in", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const held = s.values.get("credential") as object;
  s.values.set("credential", { ...held, expiresAt: 0 });
  s.fake.options.refreshError = "invalid_client";
  await assert.rejects(s.call("session", "models"), { code: "failed" });
  assert.equal((await s.call("login", "status")).state, "signed_in");
});

test("a cancel before OpenAI answers is a cancel, not an outage", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const handle = s.fake.handle;
  let seen: () => void = () => {};
  const requested = new Promise<void>((resolve) => {
    seen = resolve;
  });
  s.actor.bind("web", (request) => {
    if (!request.url.endsWith("/v1/responses")) return handle(request);
    seen();
    // OpenAI hasn't answered yet: the fetch ends only when the request is aborted.
    return new Promise<Response>((_, reject) =>
      request.signal.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      ),
    );
  });
  const reply = s.call("session", "respond", {
    requestId: "early",
    model: "gpt-test",
    instructions: "",
    input: [],
  });
  await requested;
  await s.call("session", "cancel", { requestId: "early" });
  await assert.rejects(reply, { code: "cancelled" });
});

test("events split across chunks, CRLF line ends and multi-line data parse", async (t) => {
  const s = await setup(t);
  await signIn(s);
  s.fake.options.chunked = true;
  s.fake.script({ events: [delta("é—"), delta("ok"), completed([text("é—ok")])] });
  const reply = await s.call("session", "respond", {
    requestId: "chunks",
    model: "gpt-test",
    instructions: "",
    input: [],
  });
  assert.deepEqual(reply.output, [{ type: "message", role: "assistant", content: "é—ok" }]);
  assert.deepEqual(
    events(s.actor, "delta").map((d) => (d as { text: string }).text),
    ["é—", "ok"],
  );
});
