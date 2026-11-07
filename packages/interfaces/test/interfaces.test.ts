import assert from "node:assert/strict";
import test from "node:test";
import { defineActor, defineWidget, describeInterface } from "@agentorg/sdk";
import { createTestContext } from "@agentorg/sdk/testing";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import {
  accountLogin,
  appRules,
  chat,
  httpEgress,
  hubActors,
  hubAudit,
  hubBindings,
  hubExports,
  hubGrants,
  hubPackages,
  kv,
  layout,
  llmSession,
  uiShell,
  uiView,
} from "../src/index.ts";

const standard = [kv, uiView, chat, llmSession, accountLogin, httpEgress, layout, uiShell];

test("each standard interface is named, versioned and describable", () => {
  assert.deepEqual(
    standard.map((i) => describeInterface(i).id),
    [
      "kv@1",
      "ui.view@1",
      "chat@1",
      "llm.session@1",
      "account.login@1",
      "http.egress@1",
      "layout@1",
      "ui.shell@1",
    ],
  );
  for (const i of standard) assert.match(describeInterface(i).hash, /^sha256-[0-9a-f]{64}$/);
});

/** Every schema of an interface, compiled as the Hub compiles them: strict, with no formats. */
function compiled(iface: Parameters<typeof describeInterface>[0]) {
  const ajv = new Ajv2020({ strict: true, addUsedSchema: false });
  const described = describeInterface(iface);
  const schemas: Record<string, ReturnType<typeof ajv.compile>> = {};
  if (described.kind === "rpc") {
    for (const [name, m] of Object.entries(described.methods)) {
      schemas[`${name}.input`] = ajv.compile(m.input);
      schemas[`${name}.output`] = ajv.compile(m.output);
    }
    for (const [name, schema] of Object.entries(described.events))
      schemas[`${name}.event`] = ajv.compile(schema);
  }
  return schemas;
}

test("every interface's schemas compile under the Hub's strict validator", () => {
  const hub = [hubPackages, hubActors, hubGrants, hubBindings, hubExports, hubAudit];
  for (const iface of [...standard, ...hub, appRules])
    assert.doesNotThrow(() => compiled(iface), describeInterface(iface).id);
});

test("a named rule's id is lowercase words joined by hyphens", () => {
  const set = compiled(appRules)["set.input"];
  assert.ok(set);
  assert.equal(describeInterface(appRules).id, "app.rules@1");
  assert.ok(set({ id: "agents-use-what-they-install", on: true }));
  for (const id of ["", "Agents", "a b", "-a", "a-", "a--b", "x".repeat(65)])
    assert.equal(set({ id, on: true }), false, JSON.stringify(id));
});

test("the Hub's schemas hold the rules that matter on the wire", () => {
  const login = compiled(accountLogin);
  const start = login["start.input"];
  const callback = login["complete.input"];
  const authorize = login["start.output"];
  assert.ok(start && callback && authorize);
  assert.ok(start({ redirectUri: "http://127.0.0.1:4321/oauth/chatgpt" }));
  for (const redirectUri of [
    "http://localhost:4321/oauth/chatgpt",
    "http://127.0.0.1:0/oauth/chatgpt",
    "http://127.0.0.10:4321/oauth/chatgpt",
    "http://127.0.0.1:4321/",
    "http://127.0.0.1:4321/oauth chatgpt",
    "http://127.0.0.1:4321/oauth/chatgpt\n",
  ])
    assert.equal(start({ redirectUri }), false, redirectUri);
  assert.ok(callback({ callbackUrl: "http://127.0.0.1:4321/oauth/chatgpt?code=c&state=s" }));
  assert.equal(callback({ callbackUrl: "https://evil.example/oauth/chatgpt?code=c" }), false);
  assert.ok(authorize({ authorizeUrl: "https://auth.example/authorize?x=1" }));
  for (const authorizeUrl of ["javascript:alert(1)", "http://auth.example/", "file:///etc/passwd"])
    assert.equal(authorize({ authorizeUrl }), false, authorizeUrl);
  assert.equal(compiled(chat)["send.input"]?.({ text: "   " }), false);
  assert.equal(
    compiled(llmSession)["respond.output"]?.({
      output: [{ type: "message", role: "user", content: "x" }],
    }),
    false,
  );
  assert.equal(compiled(uiShell)["openExternal.input"]?.({ url: "http://example.com" }), false);
  // Credentials can't ride along: outputs and events are closed to extra fields.
  assert.equal(login["changed.event"]?.({ state: "signed_in", token: "x" }), false);
  assert.equal(login["status.output"]?.({ state: "signed_in", account: { token: "x" } }), false);
});

/** A small Actor that keeps notes in its `kv@1` state slot, and its widget. */
const Notes = z.array(z.string());
const logic = defineActor({
  slots: { store: kv },
  async start(ctx) {
    const read = async () =>
      ctx.slots.store.bound
        ? Notes.parse((await ctx.slots.store.call.get({ key: "notes" })).value ?? [])
        : [];
    ctx.slots.store.onBind(async () => {
      await ctx.slots.store.call.set({ key: "notes", value: [...(await read()), "bound"] });
    });
  },
});
const panel = defineWidget({
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({
      mount(el, { size }) {
        (el as Element).textContent = `${size.width}x${size.height}`;
      },
    });
  },
});

test("an Actor uses kv@1 through its slot, and a widget renders through ui.view@1", async () => {
  const values = new Map<string, unknown>();
  const t = createTestContext(logic);
  await t.start();
  t.bind("store", {
    get: ({ key }) => (values.has(key) ? { value: values.get(key) as never } : {}),
    set: ({ key, value }) => {
      values.set(key, value);
      return {};
    },
  });
  await new Promise(setImmediate);
  assert.deepEqual(values.get("notes"), ["bound"]);
  await assert.rejects(t.ctx.slots.store.call.get({ key: "" }), /key/);
  assert.deepEqual(await t.ctx.slots.store.call.get({ key: "missing" }), {});
  values.set("empty", null);
  assert.deepEqual(await t.ctx.slots.store.call.get({ key: "empty" }), { value: null });

  const view = createTestContext(panel);
  await view.start();
  const el = { textContent: "" } as Element;
  view.mount("view", el, { theme: {}, size: { width: 320, height: 240 } }).unmount();
  assert.equal(el.textContent, "320x240");
});

/** A module that uses the model, sign-in and chat interfaces through its slots. */
const client = defineActor({
  slots: { model: llmSession, login: accountLogin, chat },
  start() {},
});

test("llm.session@1 carries a conversation, function tools and their calls", async () => {
  const t = createTestContext(client);
  await t.start();
  const binding = t.bind("model", {
    respond: ({ input, tools }) => ({
      output: [
        { type: "message", role: "assistant", content: `${input.length} items, ${tools?.length}` },
        { type: "function_call", callId: "c1", name: "layout__place", arguments: "{}" },
      ],
      usage: { inputTokens: 10, outputTokens: 2 },
    }),
  });
  const deltas: string[] = [];
  t.ctx.slots.model.on("delta", ({ text }) => deltas.push(text));
  binding.emit("delta", { requestId: "r1", text: "Hi" });
  assert.deepEqual(deltas, ["Hi"]);
  const reply = await t.ctx.slots.model.call.respond({
    requestId: "r1",
    instructions: "Be brief.",
    input: [
      { type: "message", role: "user", content: "Place the board." },
      { type: "function_call", callId: "c0", name: "layout__get", arguments: "{}" },
      { type: "function_call_output", callId: "c0", output: '{"home":[]}' },
    ],
    tools: [{ name: "layout__place", parameters: { type: "object" } }],
  });
  assert.equal(reply.output[0]?.type === "message" && reply.output[0].content, "3 items, 1");
  assert.deepEqual(reply.usage, { inputTokens: 10, outputTokens: 2 });
  await assert.rejects(
    t.ctx.slots.model.call.respond({
      requestId: "r2",
      instructions: "",
      input: [],
      tools: [{ name: "has space", parameters: {} }],
    }),
    { name: "Refused", code: "invalid" },
  );
  // A reply can't put words in the user's mouth.
  t.bind("model", {
    respond: () => ({ output: [{ type: "message", role: "user", content: "x" }] as never }),
  });
  await assert.rejects(
    t.ctx.slots.model.call.respond({ requestId: "r3", instructions: "", input: [] }),
    { name: "Refused", code: "bad_output" },
  );
});

test("account.login@1 takes only a loopback redirect on 127.0.0.1", async () => {
  const t = createTestContext(client);
  await t.start();
  t.bind("login", { start: () => ({ authorizeUrl: "https://auth.example/authorize?x=1" }) });
  const { authorizeUrl } = await t.ctx.slots.login.call.start({
    redirectUri: "http://127.0.0.1:4321/oauth/chatgpt",
  });
  assert.equal(authorizeUrl, "https://auth.example/authorize?x=1");
  for (const redirectUri of [
    "http://localhost:4321/oauth/chatgpt",
    "https://127.0.0.1:4321/oauth/chatgpt",
    "http://127.0.0.1/oauth/chatgpt",
    "http://127.0.0.1:4321/oauth?next=x",
    "http://127.0.0.1.example:4321/",
  ])
    await assert.rejects(t.ctx.slots.login.call.start({ redirectUri }), {
      name: "Refused",
      code: "invalid",
    });
  t.bind("login", { start: () => ({ authorizeUrl: "javascript:alert(1)" }) });
  await assert.rejects(
    t.ctx.slots.login.call.start({ redirectUri: "http://127.0.0.1:4321/oauth/chatgpt" }),
    { code: "bad_output" },
  );
});

test("chat@1 sends, pages its history and reports status with a refusal's code", async () => {
  const t = createTestContext(client);
  await t.start();
  const binding = t.bind("chat", {
    send: () => ({ messageId: "m2" }),
    history: () => ({
      messages: [{ id: "m1", role: "tool", text: "layout__place", at: "2026-11-06T00:00:00Z" }],
      more: false,
    }),
  });
  assert.deepEqual(await t.ctx.slots.chat.call.send({ text: "hi" }), { messageId: "m2" });
  await assert.rejects(t.ctx.slots.chat.call.send({ text: "   " }), { code: "invalid" });
  assert.equal((await t.ctx.slots.chat.call.history({ limit: 10 })).messages[0]?.role, "tool");
  const states: unknown[] = [];
  t.ctx.slots.chat.on("status", (status) => states.push(status));
  binding.emit("status", {
    state: "error",
    detail: { code: "usage_limit", message: "Usage limit reached." },
  });
  assert.deepEqual(states, [
    { state: "error", detail: { code: "usage_limit", message: "Usage limit reached." } },
  ]);
  assert.throws(() => binding.emit("status", { state: "done" }), { code: "bad_output" });
});
