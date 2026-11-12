import assert from "node:assert/strict";
import test from "node:test";
import { accountLogin, llmSession } from "@agentorg/interfaces";
import { defineActor } from "@agentorg/sdk";
import { createTestContext } from "@agentorg/sdk/testing";
import type { Store } from "../src/account.ts";
import type { Fetch } from "../src/oauth.ts";
import { RETRIES, sleep } from "../src/responses.ts";
import { serveChatGPT } from "../src/serve.ts";
import {
  argumentsDelta,
  callAdded,
  completed,
  delta,
  type FakeOpenAI,
  fakeOpenAI,
  text,
} from "./fake-openai.ts";

const REDIRECT = "http://127.0.0.1:4321/oauth/chatgpt";
/** ChatGPT's own code, on a way out and a store a test can change. */
const modelOf = (
  web: { fetch: Fetch },
  store: Store,
  wait: (ms: number, signal: AbortSignal) => Promise<void>,
  now: () => number,
) =>
  defineActor({
    exports: { login: accountLogin, session: llmSession },
    start(ctx) {
      serveChatGPT(ctx.exports, {
        fetch: (request) => web.fetch(request),
        store,
        log: ctx.log,
        wait,
        now,
      });
    },
  });
type Definition = ReturnType<typeof modelOf>;
type Model = ReturnType<typeof createTestContext<Definition["slots"], Definition["exports"]>>;
/** The fields of the replies these tests read. */
interface Reply {
  authorizeUrl: string;
  state: string;
  output: unknown[];
}

/** ChatGPT with the fake as its way out and an in-memory store. */
async function setup(t: test.TestContext, openai?: FakeOpenAI) {
  const fake = openai ?? (await fakeOpenAI());
  const values = new Map<string, unknown>();
  const web: { fetch: Fetch } = { fetch: (request) => fake.handle(request) };
  const store: Store = {
    get: async ({ key }) => (values.has(key) ? { value: values.get(key) as never } : {}),
    set: async ({ key, value }) => {
      values.set(key, value);
      return {};
    },
    delete: async ({ key }) => ({ deleted: values.delete(key) }),
  };
  /**
   * The waits between tries of a response. None takes any time here unless a test holds one: the
   * clock the tries are timed by is this one, and a wait moves it on.
   */
  const waits: number[] = [];
  const held: { wait?: (signal: AbortSignal) => Promise<void> } = {};
  const clock = { now: 0 };
  const actor = createTestContext(
    modelOf(
      web,
      store,
      async (ms, signal) => {
        waits.push(ms);
        clock.now += ms;
        await held.wait?.(signal);
      },
      () => clock.now,
    ),
    { actorId: "chatgpt", module: "model" },
  );
  await actor.start();
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
  return { actor, fake, values, call, web, waits, held };
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

test("respond streams text and a streamed function's arguments, returns the output, and sends only what plan usage supports", async (t) => {
  const s = await setup(t);
  await signIn(s);
  s.fake.script({
    events: [
      { type: "response.created" },
      delta("Placing "),
      delta("the board."),
      // A streamed function's arguments stream; another's don't.
      callAdded("fc_1", "call_1", "layout__place"),
      argumentsDelta("fc_1", '{"x":'),
      argumentsDelta("fc_1", "1}"),
      callAdded("fc_2", "call_2", "say"),
      argumentsDelta("fc_2", '{"text":"Pla'),
      argumentsDelta("fc_2", 'ced."}'),
      // Of an item it was never told of: nothing.
      argumentsDelta("fc_9", "{}"),
      completed([
        text("Placing the board."),
        { type: "reasoning", summary: [] },
        { type: "function_call", call_id: "call_1", name: "layout__place", arguments: '{"x":1}' },
        { type: "function_call", call_id: "call_2", name: "say", arguments: '{"text":"Placed."}' },
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
    tools: [
      { name: "layout__place", description: "Place a view", parameters: { type: "object" } },
      { name: "say", parameters: { type: "object" }, streamed: true },
    ],
  });
  assert.deepEqual(reply, {
    output: [
      { type: "message", role: "assistant", content: "Placing the board." },
      { type: "function_call", callId: "call_1", name: "layout__place", arguments: '{"x":1}' },
      { type: "function_call", callId: "call_2", name: "say", arguments: '{"text":"Placed."}' },
    ],
    usage: { inputTokens: 12, outputTokens: 3 },
  });
  const call = { id: "call_2", name: "say" };
  assert.deepEqual(events(s.actor, "delta"), [
    { requestId: "turn-1", text: "Placing " },
    { requestId: "turn-1", text: "the board." },
    { requestId: "turn-1", text: '{"text":"Pla', call },
    { requestId: "turn-1", text: 'ced."}', call },
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
  // Which are streamed is the provider's to know, not OpenAI's.
  assert.deepEqual(body.tools, [
    {
      type: "function",
      name: "layout__place",
      description: "Place a view",
      parameters: { type: "object" },
      strict: false,
    },
    { type: "function", name: "say", parameters: { type: "object" }, strict: false },
  ]);
  // Every request went to OpenAI's two hosts and nowhere else.
  for (const { url } of s.fake.requests) assert.match(url, /^https:\/\/(auth|api)\.openai\.com\//);
});

test("a person's pictures go as image parts of their message, and a call's with its output", async (t) => {
  const s = await setup(t);
  await signIn(s);
  s.fake.script({ events: [{ type: "response.created" }, completed([text("A cat.")])] });
  const png = { mediaType: "image/png", data: "iVBORw0KGgo=" };
  const jpeg = { mediaType: "image/jpeg", data: "/9j/4AAQ" };
  await s.call("session", "respond", {
    requestId: "turn-1",
    instructions: "You are an assistant.",
    input: [
      { type: "message", role: "user", content: "What is this?", images: [png] },
      { type: "function_call", callId: "c0", name: "look", arguments: "{}" },
      { type: "function_call_output", callId: "c0", output: "A screen.", images: [jpeg] },
      { type: "message", role: "assistant", content: "A cat." },
      { type: "function_call_output", callId: "c1", output: "Nothing." },
      { type: "function_call_output", callId: "c2", output: "", images: [png] },
    ],
  });
  const { input } = JSON.parse(
    s.fake.requests.filter((r) => r.url.endsWith("/v1/responses")).at(-1)?.body ?? "{}",
  );
  assert.deepEqual(input[0], {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "What is this?" },
      { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
    ],
  });
  assert.deepEqual(input[2], {
    type: "function_call_output",
    call_id: "c0",
    output: [
      { type: "input_text", text: "A screen." },
      { type: "input_image", image_url: "data:image/jpeg;base64,/9j/4AAQ" },
    ],
  });
  // Words with no picture go as they are.
  assert.equal(input[3].content, "A cat.");
  assert.equal(input[4].output, "Nothing.");
  // A picture with no words goes alone.
  assert.deepEqual(input[5].output, [
    { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
  ]);
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
    // Unavailable passes, so it is tried again: each try gets the same answer.
    ...Array.from({ length: 1 + RETRIES }, () => ({
      events: [{ type: "error", code: "subscription_sharing_usage_unavailable" }],
    })),
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

  const each = (script: Parameters<typeof s.fake.script>[0]) =>
    Array.from({ length: 1 + RETRIES }, () => script);
  s.fake.script(...each({ status: 503, code: "subscription_sharing_usage_unavailable" }));
  await assert.rejects(ask(), { code: "unavailable" });
  s.fake.script(...each({ status: 503, detail: "direct routing unavailable" }));
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
  s.fake.script(...each({ status: 500, code: "server_error" }));
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
  s.web.fetch = async (request) => {
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
  };
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
  s.web.fetch = async (request) => {
    if (!request.url.endsWith("/v1/responses")) return handle(request);
    const who = JSON.parse(await request.clone().text()).instructions as string;
    await new Promise<void>((resolve) => release.set(who, resolve));
    return handle(request);
  };
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
  s.web.fetch = (request) => {
    if (!request.url.endsWith("/v1/responses")) return handle(request);
    seen();
    // OpenAI hasn't answered yet: the fetch ends only when the request is aborted.
    return new Promise<Response>((_, reject) =>
      request.signal.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      ),
    );
  };
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

test("a response that fails for a passing reason is asked for again, after a wait that doubles", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const responses = () => s.fake.requests.filter((r) => r.url.endsWith("/v1/responses")).length;
  const ask = () =>
    s.call("session", "respond", {
      requestId: crypto.randomUUID(),
      model: "gpt-test",
      instructions: "",
      input: [],
    });
  const emitted = () => events(s.actor, "delta").length;

  // OpenAI can't be reached, then fails, then breaks off before it has written: the fourth try
  // answers, and what it streams is streamed once.
  s.fake.script(
    { unreachable: true },
    { status: 502 },
    { events: [], cut: true },
    { events: [delta("Hello"), completed([text("Hello")])] },
  );
  const before = responses();
  const heard = emitted();
  const reply = await ask();
  assert.deepEqual(reply.output, [{ type: "message", role: "assistant", content: "Hello" }]);
  assert.equal(responses() - before, 4);
  assert.equal(emitted() - heard, 1);
  assert.equal(s.waits.length, 3);
  for (const [i, wait] of s.waits.entries()) {
    const about = 1000 * 2 ** i;
    assert.ok(
      wait >= about * 0.9 && wait <= about * 1.1,
      `the ${i + 1}. wait is about ${about} ms`,
    );
  }

  // Past the last try the failure is the answer, as it would have been at once.
  s.waits.length = 0;
  s.fake.script(...Array.from({ length: 1 + RETRIES }, () => ({ unreachable: true as const })));
  const again = responses();
  await assert.rejects(ask(), { code: "unavailable" });
  assert.equal(responses() - again, 1 + RETRIES);
  assert.equal(s.waits.length, RETRIES);
});

test("the wait OpenAI asks for is taken when it is the longer; one past a minute is the answer", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const responses = () => s.fake.requests.filter((r) => r.url.endsWith("/v1/responses")).length;
  const ask = () =>
    s.call("session", "respond", {
      requestId: crypto.randomUUID(),
      model: "gpt-test",
      instructions: "",
      input: [],
    });
  /** One failure, then an answer: the one wait between them. */
  const waited = async (script: Parameters<typeof s.fake.script>[0]) => {
    s.waits.length = 0;
    s.fake.script(script);
    const before = responses();
    assert.equal((await ask()).output.length, 1, JSON.stringify(script));
    assert.equal(responses() - before, 2, JSON.stringify(script));
    assert.equal(s.waits.length, 1, JSON.stringify(script));
    return s.waits[0] as number;
  };
  const doubling = (wait: number) => wait >= 900 && wait <= 1100;

  assert.equal(await waited({ status: 429, code: "rate_limit_exceeded", retryAfter: "2" }), 2000);
  assert.equal(await waited({ status: 500, retryAfter: "3" }), 3000);
  // The longer of the two headers, whichever it is, and a minute is still taken.
  assert.equal(await waited({ status: 503, retryAfterMs: "7500", retryAfter: "3" }), 7500);
  assert.equal(await waited({ status: 503, retryAfterMs: "0", retryAfter: "30" }), 30_000);
  assert.equal(await waited({ status: 503, retryAfter: "60" }), 60_000);
  // A rate limit that doesn't say when, a wait of nothing, and a wait that isn't a number of
  // seconds wait as the first try does: OpenAI is never asked again at once.
  assert.ok(doubling(await waited({ status: 429, code: "rate_limit_exceeded" })));
  assert.ok(doubling(await waited({ status: 503, retryAfter: "0" })));
  assert.ok(doubling(await waited({ status: 503, retryAfterMs: "", retryAfter: "-1" })));
  assert.ok(doubling(await waited({ status: 503, retryAfter: "Wed, 21 Oct 2037 07:28:00 GMT" })));

  // Longer than a minute is not waited for: the failure is the answer, in its own words.
  s.waits.length = 0;
  s.fake.script({ status: 429, code: "rate_limit_exceeded", retryAfterMs: "60001" });
  const before = responses();
  await assert.rejects(ask(), { code: "unavailable", message: /limiting how often/ });
  assert.equal(responses() - before, 1);
  // Nor is a wait that would begin a try more than two minutes after the first: the third
  // failure is the answer, though a fourth try was left.
  s.fake.script(...Array.from({ length: 3 }, () => ({ status: 503, retryAfter: "50" })));
  await assert.rejects(ask(), { code: "unavailable" });
  assert.equal(responses() - before, 1 + 3);
  assert.deepEqual(s.waits, [50_000, 50_000]);
  s.waits.length = 0;
  // A 429 with no code of its own is the plan's limit, as before: never asked again.
  const then = responses();
  s.fake.script({ status: 429, retryAfter: "2" });
  await assert.rejects(ask(), { code: "usage_limit" });
  assert.equal(responses() - then, 1);
  assert.deepEqual(s.waits, []);
});

test("what passes is a server's failure by status or code, and a refusal that says to try later", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const responses = () => s.fake.requests.filter((r) => r.url.endsWith("/v1/responses")).length;
  const ask = () =>
    s.call("session", "respond", {
      requestId: crypto.randomUUID(),
      model: "gpt-test",
      instructions: "",
      input: [],
    });
  const failed = (code: string) => ({ type: "response.failed", response: { error: { code } } });
  for (const script of [
    { status: 408 },
    { status: 500 },
    { status: 529 },
    { status: 403, code: "subscription_sharing_usage_unavailable" },
    { events: [{ type: "error", code: "server_error" }] },
    { events: [failed("server_is_overloaded")] },
    { events: [failed("rate_limit_exceeded")] },
    { events: [{ type: "error", code: "slow_down" }] },
    { events: [failed("subscription_sharing_user_unavailable")] },
  ]) {
    s.fake.script(script);
    const before = responses();
    assert.equal((await ask()).output.length, 1, JSON.stringify(script));
    assert.equal(responses() - before, 2, JSON.stringify(script));
  }

  // The sign-in is refreshed for a request, and that can't reach OpenAI: the same failure.
  const held = s.values.get("credential") as object;
  s.values.set("credential", { ...held, expiresAt: 0 });
  s.fake.options.offline = true;
  s.waits.length = 0;
  const before = responses();
  await assert.rejects(ask(), { code: "unavailable" });
  assert.equal(s.waits.length, RETRIES);
  assert.equal(responses() - before, 0);
  s.fake.options.offline = false;
  assert.equal((await ask()).output.length, 1);
});

test("a break while the model writes a call of a function that isn't streamed is asked for again", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const responses = () => s.fake.requests.filter((r) => r.url.endsWith("/v1/responses")).length;
  s.fake.script(
    {
      events: [
        callAdded("fc_2", "call_2", "computer__exec_command"),
        argumentsDelta("fc_2", '{"cmd":"ls'),
      ],
      cut: true,
    },
    { events: [completed([text("Done.")])] },
  );
  const reply = await s.call("session", "respond", {
    requestId: crypto.randomUUID(),
    model: "gpt-test",
    instructions: "",
    input: [],
    tools: [
      { name: "send", parameters: { type: "object" }, streamed: true },
      { name: "computer__exec_command", parameters: { type: "object" } },
    ],
  });
  assert.deepEqual(reply.output, [{ type: "message", role: "assistant", content: "Done." }]);
  assert.equal(responses(), 2);
  // Its arguments had no reader as they were written.
  assert.deepEqual(events(s.actor, "delta"), []);
});

test("a response that has streamed text or a streamed function's arguments, or that OpenAI refuses, is not asked for again", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const responses = () => s.fake.requests.filter((r) => r.url.endsWith("/v1/responses")).length;
  const ask = () =>
    s.call("session", "respond", {
      requestId: crypto.randomUUID(),
      model: "gpt-test",
      instructions: "",
      input: [],
      tools: [
        { name: "send", parameters: { type: "object" }, streamed: true },
        { name: "computer__exec_command", parameters: { type: "object" } },
      ],
    });
  const once = async (script: Parameters<typeof s.fake.script>[0], code: string) => {
    s.fake.script(script);
    const before = responses();
    await assert.rejects(ask(), { code });
    assert.equal(responses() - before, 1, JSON.stringify(script));
  };
  // Its words, or a streamed function's call's, may be with their reader: a new try would write
  // them again.
  await once({ events: [delta("Half")], cut: true }, "failed");
  await once({ events: [delta("Half")] }, "failed");
  await once(
    { events: [callAdded("fc_1", "call_1", "send"), argumentsDelta("fc_1", '{"te')], cut: true },
    "failed",
  );
  // What isn't passing: the response's own limit, a request OpenAI won't take, a refusal, also
  // when it comes with a server's status.
  await once({ events: [{ type: "response.incomplete", response: {} }] }, "failed");
  await once({ events: [{ type: "error", code: "invalid_prompt" }] }, "failed");
  await once({ status: 400, code: "invalid_request_error" }, "failed");
  await once({ status: 404 }, "failed");
  await once({ status: 429, code: "subscription_sharing_usage_limit_exceeded" }, "usage_limit");
  await once({ status: 503, code: "subscription_sharing_usage_limit_exceeded" }, "usage_limit");
  await once({ status: 500, code: "subscription_sharing_unsupported_capability" }, "unsupported");
  assert.deepEqual(s.waits, []);
});

test("a failure says what OpenAI said of it, and nothing that could be a credential", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const told = async (script: Parameters<typeof s.fake.script>[0]) => {
    s.fake.script(script);
    const error = await s
      .call("session", "respond", {
        requestId: crypto.randomUUID(),
        model: "gpt-test",
        instructions: "",
        input: [],
      })
      .then(
        () => undefined,
        (refused: Error) => refused,
      );
    assert.ok(error, JSON.stringify(script));
    return error.message;
  };
  assert.match(
    await told({ status: 400, code: "invalid_request_error", message: "The model\n is unknown." }),
    /^OpenAI answered 400 invalid_request_error \(request req_[\w-]+\)\. OpenAI said: The model is unknown\.$/,
  );
  assert.match(
    await told({ events: [{ type: "error", code: "invalid_prompt", message: "Bad prompt." }] }),
    /^OpenAI ended the response with an error invalid_prompt \(request req_[\w-]+\)\. OpenAI said: Bad prompt\.$/,
  );
  // Cut at 200 characters, and a model's name or an address stays whole.
  const failed = (message: string) => ({
    type: "response.failed",
    response: { error: { code: "bad_thing", message } },
  });
  const long = await told({ events: [failed(`It broke. ${"so it goes ".repeat(40)}`)] });
  assert.equal(long.split("OpenAI said: ")[1]?.length, 200);
  assert.match(
    await told({ status: 404, message: "The model `gpt-5.1-codex-mini-2025-11-13` is gone." }),
    /OpenAI said: The model `gpt-5\.1-codex-mini-2025-11-13` is gone\.$/,
  );
  // A run long enough to be a token is left out, in a reply and inside a stream: 32 characters
  // is one, 31 is not.
  const run = "a1b2c3d4-e5f6_a7b8c9d0e1f2a3b4c5";
  assert.equal(run.length, 32);
  assert.match(await told({ status: 400, message: `Saw ${run} here.` }), /Saw … here\.$/);
  assert.match(await told({ events: [failed(`Saw ${run} here.`)] }), /Saw … here\.$/);
  assert.match(await told({ status: 400, message: `Saw ${run.slice(1)} here.` }), /Saw a?1b2c3/);
  // Nothing of a message about a credential, which can quote one in part, wherever it comes;
  // and nothing of a reply that refuses the sign-in, whatever it says.
  const [token] = [...s.fake.secrets].filter((secret) => secret.length >= 32);
  assert.ok(token, "the fake issued a token");
  const partly = `${token.slice(0, 12)}****${token.slice(-12)}`;
  for (const message of [
    `Incorrect API key provided: ${partly}.`,
    `The token ${token} has expired.`,
    `Bad credentials\n${partly}`,
  ]) {
    assert.doesNotMatch(await told({ status: 400, message }), /OpenAI said/, message);
    assert.doesNotMatch(await told({ events: [failed(message)] }), /OpenAI said/, message);
    assert.doesNotMatch(
      await told({ events: [{ type: "error", code: "bad_thing", message }] }),
      /OpenAI said/,
      message,
    );
  }
  assert.doesNotMatch(await told({ status: 403, message: "Not for you." }), /OpenAI said/);
  s.fake.script({ status: 401, message: "Signed out." });
  assert.doesNotMatch(await told({ status: 401, message: "Signed out." }), /OpenAI said/);
  // OpenAI said nothing: the line ends where it did.
  assert.match(await told({ status: 404 }), /^OpenAI answered 404 \(request req_[\w-]+\)\.$/);
  assert.match(
    await told({
      events: [
        {
          type: "response.incomplete",
          response: { incomplete_details: { reason: "max_output_tokens" } },
        },
      ],
    }),
    /^The response ended incomplete \(max_output_tokens\)\.$/,
  );
});

test("a cancel during the wait before another try is a cancel, and nothing more is asked", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const responses = () => s.fake.requests.filter((r) => r.url.endsWith("/v1/responses")).length;
  let waiting: (() => void) | undefined;
  s.held.wait = (signal) =>
    new Promise<void>((resolve) => {
      waiting = resolve;
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  s.fake.script({ status: 500 });
  const before = responses();
  const asking = s.call("session", "respond", {
    requestId: "held",
    model: "gpt-test",
    instructions: "",
    input: [],
  });
  const settled = asking.then(
    () => "answered",
    (error: { code?: string }) => error.code,
  );
  for (let i = 0; i < 200 && !waiting; i++) await new Promise((soon) => setImmediate(soon));
  assert.ok(waiting, "it waits before the next try");
  await s.call("session", "cancel", { requestId: "held" });
  assert.equal(await settled, "cancelled");
  assert.equal(responses() - before, 1);
});

test("the wait between tries ends when its time is up, and at once when cancelled", async () => {
  const started = Date.now();
  await sleep(30, new AbortController().signal);
  assert.ok(Date.now() - started >= 25);

  const during = new AbortController();
  const waiting = sleep(60_000, during.signal);
  during.abort();
  await assert.rejects(waiting, { code: "cancelled" });
  // One cancelled before it began rejects the same way. Neither leaves a timer: the test ends.
  await assert.rejects(sleep(60_000, during.signal), { code: "cancelled" });
});

const sealedItem = (id: string, content: string) => ({
  type: "reasoning",
  id,
  summary: [],
  encrypted_content: content,
});
const callItem = (id: string) => ({
  type: "function_call",
  call_id: id,
  name: "look",
  arguments: "{}",
});
/** A caller's items for a call and its output, as it keeps them. */
const called = (id: string) => [
  { type: "function_call", callId: id, name: "look", arguments: "{}" },
  { type: "function_call_output", callId: id, output: "seen" },
];
const user = (content: string) => ({ type: "message", role: "user", content });
const assistant = (content: string) => ({ type: "message", role: "assistant", content });
/** What the latest `/responses` request sent: its body, and its input by kind. */
const latest = (s: Awaited<ReturnType<typeof setup>>) => {
  const sent = s.fake.requests.filter((r) => r.url.endsWith("/v1/responses"));
  const body = JSON.parse(sent.at(-1)?.body ?? "{}");
  const kinds = (
    body.input as { type: string; id?: string; call_id?: string; content?: string }[]
  ).map((item) =>
    item.type === "reasoning" ? item.id : item.type === "message" ? item.content : item.type,
  );
  return { body, kinds, count: sent.length };
};

test("a model's reasoning is kept here and sent back before its call until a user message follows, and a caller never has it", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const ask = (input: unknown[]) =>
    s.call("session", "respond", {
      requestId: crypto.randomUUID(),
      model: "gpt-test",
      instructions: "",
      input,
    });
  s.fake.script({
    events: [
      completed([
        { ...sealedItem("rs_1", "sealed-one"), summary: [{ type: "summary_text", text: "Why." }] },
        text("Looking."),
        text("Still looking."),
        callItem("c1"),
        // Reasoning with nothing sealed can't be sent back, so it isn't kept.
        { type: "reasoning", id: "rs_2", summary: [] },
        callItem("c2"),
        sealedItem("rs_3", "sealed-three"),
        callItem("c3"),
      ]),
    ],
  });
  const first = await ask([user("Look.")]);
  // The caller gets what it always got.
  assert.deepEqual(
    first.output.map((item) => (item as { type: string }).type),
    ["message", "message", "function_call", "function_call", "function_call"],
  );
  assert.deepEqual(latest(s).body.include, ["reasoning.encrypted_content"]);

  // Back before its call, and before the words the model wrote with the call, as OpenAI gave
  // it; a call with something else before it has its reasoning straight before it.
  const turn = [
    user("Look."),
    assistant("Looking."),
    assistant("Still looking."),
    ...called("c1"),
    ...called("c2"),
    ...called("c3"),
  ];
  await ask(turn);
  assert.deepEqual(latest(s).kinds, [
    "Look.",
    "rs_1",
    "Looking.",
    "Still looking.",
    "function_call",
    "function_call_output",
    "function_call",
    "function_call_output",
    "rs_3",
    "function_call",
    "function_call_output",
  ]);
  assert.deepEqual(latest(s).body.input[1], {
    ...sealedItem("rs_1", "sealed-one"),
    summary: [{ type: "summary_text", text: "Why." }],
  });
  // Once a user message follows them, the calls go without their reasoning.
  await ask([...turn, assistant("It is there."), user("And now?")]);
  assert.equal(
    latest(s).kinds.some((kind) => kind?.startsWith("rs_")),
    false,
  );
  // Nothing of it reached the caller, an event or a log.
  assert.equal(JSON.stringify([first, s.actor.emitted, s.actor.logs]).includes("sealed-"), false);
});

test("a request that had reasoning put back and fails for good before any text is made once more without it, and that reasoning is not sent again", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const ask = (input: unknown[]) =>
    s.call("session", "respond", {
      requestId: crypto.randomUUID(),
      model: "gpt-test",
      instructions: "",
      input,
    });
  const kept = async (call: string) => {
    s.fake.script({
      events: [completed([sealedItem(`rs_${call}`, "sealed-one"), callItem(call)])],
    });
    await ask([user("Look.")]);
    return [user("Look."), ...called(call)];
  };
  const bare = ["Look.", "function_call", "function_call_output"];

  // Refused with the reasoning in it: once more without, at once.
  let turn = await kept("c1");
  s.fake.script({ status: 400, code: "invalid_encrypted_content" });
  let before = latest(s).count;
  assert.equal((await ask(turn)).output.length, 1);
  assert.equal(latest(s).count - before, 2);
  assert.deepEqual(latest(s).kinds, bare);
  assert.deepEqual(s.waits, [], "not one of the tries a passing failure gets");
  // And not sent again for the rest of the turn, so the refusal is paid for once.
  await ask(turn);
  assert.deepEqual(latest(s).kinds, bare);

  // Refused inside the stream, before any text: the same.
  turn = await kept("c1b");
  s.fake.script({
    events: [
      { type: "response.failed", response: { error: { code: "invalid_encrypted_content" } } },
    ],
  });
  before = latest(s).count;
  assert.equal((await ask(turn)).output.length, 1);
  assert.equal(latest(s).count - before, 2);
  assert.deepEqual(latest(s).kinds, bare);
  // Refused without it too: that is the answer, in two requests.
  turn = await kept("c2");
  s.fake.script({ status: 400 }, { status: 400, code: "invalid_request_error" });
  before = latest(s).count;
  await assert.rejects(ask(turn), { code: "failed", message: /invalid_request_error/ });
  assert.equal(latest(s).count - before, 2);
  // A refusal with words of its own is the answer at once, and the reasoning stays.
  turn = await kept("c2b");
  s.fake.script({ status: 400, code: "subscription_sharing_unsupported_capability" });
  before = latest(s).count;
  await assert.rejects(ask(turn), { code: "unsupported" });
  assert.equal(latest(s).count - before, 1);
  await ask(turn);
  assert.deepEqual(latest(s).kinds, ["Look.", "rs_c2b", "function_call", "function_call_output"]);
  // A request with no reasoning in it is asked once, as before.
  s.fake.script({ status: 400 });
  before = latest(s).count;
  await assert.rejects(ask([user("Hello.")]), { code: "failed" });
  assert.equal(latest(s).count - before, 1);
  // A failure that passes keeps the reasoning in the next try; and the try without it gets
  // the tries a passing failure gets.
  turn = await kept("c3");
  s.fake.script({ status: 500 });
  await ask(turn);
  assert.deepEqual(latest(s).kinds, ["Look.", "rs_c3", "function_call", "function_call_output"]);
  // It counts as none of the tries a passing failure gets: those are all still to come.
  turn = await kept("c4");
  s.waits.length = 0;
  s.fake.script({ status: 400 }, ...Array.from({ length: 1 + RETRIES }, () => ({ status: 500 })));
  before = latest(s).count;
  await assert.rejects(ask(turn), { code: "failed" });
  assert.equal(latest(s).count - before, 2 + RETRIES);
  assert.equal(s.waits.length, RETRIES);
  // What isn't OpenAI refusing the request as it is leaves the reasoning and is asked once: a
  // response that ended incomplete, and one that failed after it had written.
  turn = await kept("c5");
  const withIt = ["Look.", "rs_c5", "function_call", "function_call_output"];
  for (const events of [
    [{ type: "response.incomplete", response: {} }],
    [delta("Half"), { type: "response.failed", response: { error: { code: "bad_thing" } } }],
  ]) {
    s.fake.script({ events });
    before = latest(s).count;
    await assert.rejects(ask(turn), { code: "failed" });
    assert.equal(latest(s).count - before, 1);
    assert.deepEqual(latest(s).kinds, withIt);
  }
  // The try without it is one of the same run of tries: it gets no window of its own.
  turn = await kept("c6");
  s.waits.length = 0;
  s.fake.script(
    { status: 503, retryAfter: "50" },
    { status: 400 },
    { status: 503, retryAfter: "50" },
    { status: 503, retryAfter: "50" },
  );
  before = latest(s).count;
  await assert.rejects(ask(turn), { code: "unavailable" });
  assert.equal(latest(s).count - before, 4);
  assert.deepEqual(s.waits, [50_000, 50_000]);
  assert.deepEqual(latest(s).kinds, bare);
});

test("the reasoning kept is bounded, for one call and for one caller, and goes when the sign-in does", async (t) => {
  const s = await setup(t);
  await signIn(s);
  const ask = (input: unknown[]) =>
    s.call("session", "respond", {
      requestId: crypto.randomUUID(),
      model: "gpt-test",
      instructions: "",
      input,
    });
  const answer = async (...items: Record<string, unknown>[]) => {
    s.fake.script({ events: [completed(items)] });
    await ask([user("Look.")]);
  };
  /** Which reasoning goes back with these calls. */
  const back = async (...calls: string[]) => {
    await ask([user("Look."), ...calls.flatMap(called)]);
    return latest(s).kinds.filter((kind) => kind?.startsWith("rs_"));
  };
  // One call's reasoning over 200,000 characters is not kept, nor one with nothing sealed; one
  // under it is.
  await answer(sealedItem("rs_big", "x".repeat(200_000)), callItem("big"));
  await answer(sealedItem("rs_none", ""), callItem("none"));
  await answer(sealedItem("rs_fits", "x".repeat(190_000)), callItem("fits"));
  assert.deepEqual(await back("big", "none", "fits"), ["rs_fits"]);
  // Past 400,000 characters for one caller, the oldest goes first.
  await answer(sealedItem("rs_0", "x".repeat(190_000)), callItem("c0"));
  assert.deepEqual(await back("fits", "c0"), ["rs_fits", "rs_0"]);
  await answer(sealedItem("rs_1", "x".repeat(190_000)), callItem("c1"));
  assert.deepEqual(await back("fits", "c0", "c1"), ["rs_0", "rs_1"]);
  // A sign-out forgets all of it: the next sign-in may be another account.
  await s.call("login", "logout");
  await signIn(s);
  assert.deepEqual(await back("c0", "c1"), []);
});
