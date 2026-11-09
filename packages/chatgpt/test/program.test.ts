import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hub, listen, PERSON } from "@agentorg/hub";
import { accountLogin, hubActors, hubBindings, llmSession } from "@agentorg/interfaces";
import { connect } from "@agentorg/sdk/client";
import { startChatGPT } from "../src/index.ts";
import { completed, delta, fakeOpenAI, text } from "./fake-openai.ts";

const REDIRECT = "http://127.0.0.1:4321/oauth/chatgpt";
const until = async (condition: () => boolean, ms = 15_000) => {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** A real Hub, ChatGPT as a program on it, and an Actor bound to its two exports. */
async function setup(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-chatgpt-")));
  const home = join(root, "home");
  const dir = join(root, "chatgpt");
  const hub = Hub.open(home);
  const server = await listen(hub);
  const leaving: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    for (const leave of leaving.reverse()) await leave();
    await server.close();
    hub.close();
    rmSync(root, { recursive: true, force: true });
  });
  const fake = await fakeOpenAI();
  const logged: string[] = [];
  const note = (message: string, fields?: unknown) => {
    logged.push(`${message} ${JSON.stringify(fields ?? {})}`);
  };
  const sent: Request[] = [];
  const inits: RequestInit[] = [];
  const out: { respond?: (request: Request) => Promise<Response>; discovered?: string } = {};
  const through = async (request: Request, init: RequestInit) => {
    sent.push(request);
    inits.push(init);
    if (out.respond && request.url.endsWith("/v1/responses")) return out.respond(request);
    const response = await fake.handle(request);
    if (!out.discovered || !request.url.endsWith("/.well-known/openid-configuration"))
      return response;
    const body = (await response.json()) as Record<string, unknown>;
    return Response.json({ ...body, jwks_uri: out.discovered });
  };
  const made = hub.state.createActor(PERSON, { name: "ChatGPT" });
  const start = () =>
    startChatGPT({
      hubUrl: server.url,
      actorId: made.actorId,
      credential: made.credential as string,
      dir,
      log: { info: note, warn: note, error: note },
      fetch: through,
    });
  const program = { current: await start() };
  leaving.push(() => program.current.close());

  const person = await connect({
    hubUrl: server.url,
    actorId: PERSON,
    credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
    slots: { actors: hubActors, bindings: hubBindings },
    declare: false,
  });
  leaving.push(() => person.close());
  const user = hub.state.createActor(PERSON, {
    name: "User",
    bindings: [
      { slot: "login", provider: made.actorId, export: "login" },
      { slot: "session", provider: made.actorId, export: "session" },
    ],
  });
  const deltas: string[] = [];
  const client = await connect({
    hubUrl: server.url,
    actorId: user.actorId,
    credential: user.credential as string,
    slots: { login: accountLogin, session: llmSession },
    start(ctx) {
      ctx.slots.session.on("delta", ({ text }) => deltas.push(text));
    },
  });
  leaving.push(() => client.close());
  await until(() => client.slots.login.bound && client.slots.session.bound);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const signIn = async () => {
    const { authorizeUrl } = await client.slots.login.call.start({ redirectUri: REDIRECT });
    return client.slots.login.call.complete({ callbackUrl: await fake.authorize(authorizeUrl) });
  };
  const respond = (requestId: string) =>
    client.slots.session.call.respond({
      requestId,
      instructions: "Be brief.",
      input: [{ type: "message", role: "user", content: "Say hi." }],
    });
  return {
    hub,
    person,
    fake,
    dir,
    logged,
    sent,
    inits,
    out,
    made,
    deltas,
    program,
    start,
    signIn,
    respond,
    client,
  };
}

test("it signs in and answers with no storage or net binding, the sign-in in one private file", async (t) => {
  const s = await setup(t);
  const { login } = s.client.slots;
  assert.deepEqual(await login.call.status({}), { state: "signed_out" });
  const { account } = await s.signIn();
  assert.ok(account.email);
  assert.equal((await login.call.status({})).state, "signed_in");

  s.fake.script({ events: [delta("Hi "), delta("there."), completed([text("Hi there.")])] });
  const reply = await s.respond("r1");
  assert.deepEqual(reply.output, [{ type: "message", role: "assistant", content: "Hi there." }]);
  await until(() => s.deltas.length === 2);
  assert.deepEqual(s.deltas, ["Hi ", "there."]);

  // It holds no slot at all: nothing of storage or net is bound, or was called.
  const { bindings } = await s.person.slots.bindings.call.list({ actor: s.made.actorId });
  assert.deepEqual(
    bindings.filter((b) => b.consumer === s.made.actorId),
    [],
  );
  const audit = JSON.stringify(s.hub.state.audit(0, 100_000));
  assert.ok(!audit.includes('"net"') && !audit.includes("storage.kv"));
  assert.equal(
    s.hub.state.actor(s.made.actorId).package,
    "external",
    "an ordinary program, not a package",
  );

  // The file is the one place the tokens are, and it is private.
  const file = join(s.dir, "sign-in.json");
  assert.equal(statSync(s.dir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const kept = readFileSync(file, "utf8");
  assert.ok([...s.fake.secrets].some((secret) => kept.includes(secret)));
  // Nothing but https left.
  assert.ok(s.sent.length > 0);
  for (const request of s.sent) assert.equal(new URL(request.url).protocol, "https:");

  const outside = JSON.stringify([audit, s.logged, reply, await login.call.status({})]);
  for (const secret of s.fake.secrets) assert.ok(!outside.includes(secret), "a token left");
});

test("every request is sent not to follow a redirect, and only https goes out", async (t) => {
  const s = await setup(t);
  await s.signIn();
  assert.ok(s.inits.length > 0);
  for (const init of s.inits) assert.equal(init.redirect, "manual");
});

test("an issuer pointing at a plain http address is never reached", async (t) => {
  const s = await setup(t);
  s.out.discovered = "http://keys.example/jwks";
  const { authorizeUrl } = await s.client.slots.login.call.start({ redirectUri: REDIRECT });
  await assert.rejects(
    s.fake
      .authorize(authorizeUrl)
      .then((callbackUrl) => s.client.slots.login.call.complete({ callbackUrl })),
    { code: "unavailable" },
  );
  assert.ok(!s.sent.some((request) => request.url.startsWith("http:")));
});

test("closing stops a response still waiting on OpenAI, and leaves the Hub", async (t) => {
  const s = await setup(t);
  await s.signIn();
  let aborted = false;
  let waiting = false;
  s.out.respond = (request) =>
    new Promise((_, reject) => {
      waiting = true;
      request.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    });
  const answer = s.respond("r9").catch(() => undefined);
  await until(() => waiting);
  await s.program.current.close();
  assert.equal(aborted, true);
  await until(() => !s.hub.connected(s.made.actorId));
  await answer;
  delete s.out.respond;
  s.program.current = await s.start();
});

test("the sign-in stays across a restart, and goes at sign-out", async (t) => {
  const s = await setup(t);
  const { login } = s.client.slots;
  await s.signIn();
  await s.program.current.close();
  await until(() => !s.hub.connected(s.made.actorId));
  s.program.current = await s.start();
  await until(() => s.hub.connected(s.made.actorId));
  await until(() => login.bound);
  // No new sign-in: what it kept still answers.
  for (let i = 0; ; i++) {
    const state = await login.call.status({}).then(
      (found) => found.state,
      () => undefined,
    );
    if (state) {
      assert.equal(state, "signed_in");
      break;
    }
    assert.ok(i < 300, "it never answered");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await s.respond("r2");

  await login.call.logout({});
  assert.deepEqual(await login.call.status({}), { state: "signed_out" });
  const kept = readFileSync(join(s.dir, "sign-in.json"), "utf8");
  for (const secret of s.fake.secrets) assert.ok(!kept.includes(secret), "a token was kept");
  await assert.rejects(s.respond("r3"), { code: "not_signed_in" });
});

test("an unreadable file means signing in again, and none of it is logged", async (t) => {
  const s = await setup(t);
  await s.signIn();
  await s.program.current.close();
  await until(() => !s.hub.connected(s.made.actorId));
  const file = join(s.dir, "sign-in.json");
  writeFileSync(file, '{ "credential": "token-text-that-must-stay-out');
  chmodSync(s.dir, 0o755);
  s.program.current = await s.start();
  assert.equal(statSync(s.dir).mode & 0o777, 0o700, "the folder is made private again");
  assert.ok(!s.logged.join("\n").includes("token-text-that-must-stay-out"));
  await until(() => s.hub.connected(s.made.actorId));
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (let i = 0; ; i++) {
    const state = await s.client.slots.login.call.status({}).then(
      (found) => found.state,
      () => undefined,
    );
    if (state) {
      assert.equal(state, "signed_out");
      break;
    }
    assert.ok(i < 300, "it never answered");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(file), false);
  assert.ok(s.logged.some((line) => line.includes("couldn't be read")));
  assert.ok(!s.logged.join("\n").includes("token-text-that-must-stay-out"));
});
