import assert from "node:assert/strict";
import test from "node:test";
import { defineActor, describeInterface } from "@agentorg/sdk";
import { createTestContext } from "@agentorg/sdk/testing";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import {
  accountLogin,
  agentProvider,
  agentSettings,
  agents,
  chat,
  connections,
  Field,
  hubActors,
  hubAudit,
  hubBindings,
  hubExports,
  hubGrants,
  kv,
  llmSession,
  skills,
  tools,
  unitProvider,
} from "../src/index.ts";

const standard = [kv, chat, llmSession, accountLogin];

test("each standard interface is named, versioned and describable", () => {
  assert.deepEqual(
    standard.map((i) => describeInterface(i).id),
    ["kv@1", "chat@1", "llm.session@1", "account.login@1"],
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
  const hub = [hubActors, hubGrants, hubBindings, hubExports, hubAudit];
  for (const iface of [...standard, ...hub])
    assert.doesNotThrow(() => compiled(iface), describeInterface(iface).id);
});

const management = [tools, agentSettings, agentProvider, agents, connections, skills, unitProvider];

test("the agent management interfaces are named, versioned and compile strictly", () => {
  assert.deepEqual(
    management.map((i) => describeInterface(i).id),
    [
      "tools@1",
      "agent.settings@1",
      "agent.provider@1",
      "agents@1",
      "connections@1",
      "skills@1",
      "unit.provider@1",
    ],
  );
  for (const iface of management)
    assert.doesNotThrow(() => compiled(iface), describeInterface(iface).id);
});

test("tools@1 carries any tool's arguments, and a failure only as a flag", () => {
  const t = compiled(tools);
  assert.ok(t["call.input"]?.({ name: "read", arguments: { path: "a", deep: { x: [1] } } }));
  assert.equal(t["call.input"]?.({ name: "read" }), false);
  assert.ok(t["call.output"]?.({ output: "no such file", failed: true }));
  assert.equal(t["call.output"]?.({ output: "x", failed: false }), false);
  assert.equal(t["call.output"]?.({ output: "x".repeat(200_001) }), false);
  assert.ok(t["changed.event"]?.({}));
});

test("a skill's name and paths stay inside its folder", () => {
  const skill = compiled(agentSettings)["skill.input"];
  assert.ok(skill);
  for (const path of ["SKILL.md", "references/guide.md", "a/b.c/d", ".hidden/x", "a..b/c"])
    assert.ok(skill({ name: "pdf-tools", path }), path);
  assert.ok(skill({ name: "pdf-tools" }));
  for (const path of [
    "",
    "..",
    ".",
    "../x",
    "a/../b",
    "a/..",
    "/etc/passwd",
    "a\\b",
    "a\0b",
    "a\n/../../x",
    "a\u2028/../x",
    "a//b",
    "a/",
    "./a",
  ])
    assert.equal(skill({ name: "pdf-tools", path }), false, JSON.stringify(path));
  for (const name of ["", "PDF", "a b", "-a", "a-", "a--b", "x".repeat(65)])
    assert.equal(skill({ name }), false, JSON.stringify(name));
});

test("a connection's status can't carry extra fields, and a base holds only what it asks", () => {
  const provider = compiled(unitProvider);
  const status = { state: "connected", connections: [{ connection: "a", state: "up", tools: [] }] };
  assert.equal(provider["status.output"]?.(status), false);
  assert.equal(
    provider["status.output"]?.({
      state: "connected",
      connections: [{ connection: "a", state: "connected", tools: [], token: "x" }],
    }),
    false,
  );
  const creatables = compiled(agentProvider)["creatable.output"];
  assert.ok(creatables);
  const creatable = {
    id: "files",
    title: "Files",
    description: "",
    instructions: "",
    asks: [{ id: "folder", title: "Folder" }],
  };
  assert.ok(creatables({ creatables: [creatable] }));
  assert.equal(creatables({ creatables: [{ ...creatable, mcp: [] }] }), false);
});

test("an agent's status tells stopped by the person from down", () => {
  const status = compiled(agentProvider)["status.output"];
  assert.ok(status);
  assert.ok(status({ state: "stopped" }));
  assert.ok(status({ state: "down", detail: "It exited." }));
  assert.equal(status({ state: "idle" }), false);
  const listed = compiled(agents)["list.output"];
  const agent = { agent: "act_1", name: "A", provider: "act_2", creatable: "assistant" };
  assert.ok(listed?.({ agents: [{ ...agent, status: { state: "down", detail: "x" } }] }));
  assert.equal(listed?.({ agents: [agent] }), false);
});

const computer = {
  id: "computer",
  title: "Computer",
  description: "Where the agent works.",
  form: [
    {
      id: "where",
      type: "choice",
      value: "string",
      title: "Where it runs",
      required: true,
      options: [{ value: "local", title: "This computer", description: "Runs as you." }],
    },
    {
      id: "access",
      type: "choice",
      value: "string",
      title: "Files and commands",
      options: [
        { value: "none", title: "None" },
        {
          value: "read",
          title: "Read files",
          adds: {
            slots: [{ name: "computer" }],
            skills: [{ name: "files", files: ["SKILL.md"] }],
          },
        },
      ],
    },
    {
      id: "browser",
      type: "toggle",
      value: "boolean",
      title: "Browser",
      adds: { slots: [{ name: "browser" }], skills: [] },
    },
    {
      id: "workspace",
      type: "directory",
      value: "string",
      title: "Folder",
      required: true,
      visible: { field: "access", in: ["read", "files", "terminal"] },
    },
    {
      id: "image",
      type: "text",
      value: "string",
      title: "Image",
      default: "agentorg/computer",
      visible: { field: "where", in: ["container"] },
    },
  ],
  needs: [],
  gives: {
    slots: [{ name: "computer" }],
    skills: [{ name: "terminal", files: ["SKILL.md"] }],
    results: ["computer"],
  },
};

test("a unit carries its form as data, and a new field type needs no new contract", () => {
  const units = compiled(unitProvider)["units.output"];
  assert.ok(units);
  assert.ok(units({ units: [computer] }));
  const withType = (type: string) => ({
    units: [
      { ...computer, form: [{ id: "spot", type, value: "string", title: "A spot on a map" }] },
    ],
  });
  assert.ok(units(withType("map-point")), "an open name");
  assert.equal(units(withType("Not A Name")), false);
  assert.ok(
    units({
      units: [{ ...computer, form: [{ id: "k", type: "api-key", value: "secret", title: "K" }] }],
    }),
    "a secret by its value kind, whatever its type",
  );
  const badKind = { id: "x", type: "text", value: "object", title: "X" };
  assert.equal(units({ units: [{ ...computer, form: [badKind] }] }), false);
  // A slot's name is fixed, or the value of a field; a unit doesn't say both.
  const named = (slots: unknown[]) => ({
    units: [{ ...computer, gives: { ...computer.gives, slots } }],
  });
  assert.ok(units(named([{ field: "where" }])));
  assert.equal(units(named([{ name: "a", field: "where" }])), false);
  // So is a skill's, for a unit that gives one the person chose.
  const skills = [{ field: "where" }];
  assert.ok(units({ units: [{ ...computer, gives: { ...computer.gives, skills } }] }));
});

test("a unit's apply takes secrets apart from its values, and check never sees them", () => {
  const provider = compiled(unitProvider);
  const apply = {
    unit: "computer",
    values: { where: "local", limit: 3, on: true, several: ["a", "b"] },
    secrets: { key: "k" },
    needs: { computer: "handle" },
    agent: "act_1",
    name: "Fay",
  };
  assert.ok(provider["apply.input"]?.(apply));
  assert.equal(provider["apply.input"]?.({ ...apply, values: { where: { deep: 1 } } }), false);
  assert.ok(provider["check.input"]?.({ unit: "computer", values: {}, secrets: ["key"] }));
  assert.ok(provider["check.output"]?.({ problems: [{ field: "where", message: "No." }] }));
  assert.equal(
    provider["status.output"]?.({ state: "connected", connections: [], token: "x" }),
    false,
  );
});

test("a stack carries secrets at creation, and a template can never hold one", () => {
  const manage = compiled(agents);
  const base = { provider: "act_b", creatable: "assistant" };
  const unit = { provider: "act_u", unit: "computer", values: { where: "local" } };
  const create = manage["create.input"];
  assert.ok(create);
  const stack = { base, units: [{ ...unit, secrets: { key: "k" }, needs: { computer: 0 } }] };
  assert.ok(create({ stack, name: "Fay", purpose: "Keeps the docs tidy." }));
  assert.ok(create({ template: "assistant", fill: [{ values: { where: "local" } }], name: "Fay" }));
  assert.equal(
    create({ provider: "act_b", creatable: "assistant", name: "Fay", answers: {} }),
    false,
  );
  assert.equal(create({ name: "Fay" }), false);
  assert.equal(create({ stack, template: "assistant", name: "Fay" }), false);
  const named = { ...base, provider: "Local" };
  const template = { id: "mine", title: "Mine", description: "", from: "assistant", base: named };
  const save = manage["saveTemplate.input"];
  const inTemplate = { ...unit, provider: "Local" };
  assert.ok(save?.({ ...template, units: [inTemplate] }));
  assert.equal(save?.({ ...template, units: [{ ...inTemplate, secrets: { key: "k" } }] }), false);
  assert.equal(create({ template: "assistant", fill: [{ value: 1 }], name: "Fay" }), false);
  assert.equal(create({ stack: { ...stack, base: { ...base, secrets: {} } }, name: "Fay" }), false);
  // A unit added to a living agent is checked the same way, and takes results by instance.
  const add = {
    agent: "act_a",
    unit: { provider: "act_u", unit: "browser" },
    needs: { computer: "i1" },
  };
  assert.ok(manage["check.input"]?.(add));
  assert.ok(manage["addUnit.input"]?.(add));
  assert.equal(
    manage["addUnit.input"]?.({ ...add, unit: { ...add.unit, needs: { computer: 0 } } }),
    false,
  );
});

test("management exposes a skill or a connection, and adds a skill from a folder or as files", () => {
  const expose = compiled(agents)["expose.input"];
  assert.ok(expose);
  assert.ok(expose({ agent: "act_1", skill: "notes" }));
  assert.ok(expose({ agent: "act_1", connection: "act_2", as: "files" }));
  assert.equal(expose({ agent: "act_1" }), false);
  assert.equal(expose({ agent: "act_1", skill: "notes", connection: "act_2" }), false);
  assert.equal(expose({ agent: "act_1", connection: "act_2", as: "not.one" }), false);
  const add = compiled(skills)["add.input"];
  assert.ok(add);
  assert.ok(add({ path: "/tmp/notes" }));
  assert.ok(add({ files: { "SKILL.md": "x" } }));
  assert.equal(add({ files: { "../SKILL.md": "x" } }), false);
  assert.equal(add({}), false);
  assert.equal(add({ path: "/tmp/notes", files: { "SKILL.md": "x" } }), false);
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
  // Credentials can't ride along: outputs and events are closed to extra fields.
  assert.equal(login["changed.event"]?.({ state: "signed_in", token: "x" }), false);
  assert.equal(login["status.output"]?.({ state: "signed_in", account: { token: "x" } }), false);
});

/** A small Actor that keeps notes in its `kv@1` state slot. */
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
test("an Actor uses kv@1 through its slot", async () => {
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

test("chat@1 sends in a chat or starts one, pages its history, and says only whether the agent is working", async () => {
  const t = createTestContext(client);
  await t.start();
  const binding = t.bind("chat", {
    send: ({ chat }) => ({ chat: chat ?? "c1", messageId: "m2" }),
    history: () => ({
      messages: [{ id: "m1", role: "tool", text: "layout__place", at: "2026-11-06T00:00:00Z" }],
      more: false,
    }),
    state: () => ({ state: "working" as const }),
  });
  assert.deepEqual(await t.ctx.slots.chat.call.send({ text: "hi" }), {
    chat: "c1",
    messageId: "m2",
  });
  assert.equal((await t.ctx.slots.chat.call.send({ chat: "c2", text: "hi" })).chat, "c2");
  await assert.rejects(t.ctx.slots.chat.call.send({ text: "   " }), { code: "invalid" });
  const page = await t.ctx.slots.chat.call.history({ chat: "c1", limit: 10 });
  assert.equal(page.messages[0]?.role, "tool");
  // A chat's own calls name it; the agent's status names none.
  await assert.rejects(t.ctx.slots.chat.call.history({} as never), { code: "invalid" });
  assert.deepEqual(await t.ctx.slots.chat.call.state({}), { state: "working" });
  const states: unknown[] = [];
  t.ctx.slots.chat.on("status", (status) => states.push(status));
  binding.emit("status", { state: "working" });
  binding.emit("status", { state: "idle" });
  assert.deepEqual(states, [{ state: "working" }, { state: "idle" }]);
  // A chat is never said to think, to use a tool or to have failed.
  for (const state of ["thinking", "tool", "error"])
    assert.throws(() => binding.emit("status", { state } as never), { code: "bad_output" });
  // And nothing in it stops, runs again or chooses a model.
  for (const gone of ["cancel", "retry", "models", "setModel"])
    assert.equal(gone in chat.methods, false, gone);
});

test("chat@1 lists an agent's chats, with the problem one stopped on, and renames and archives one", async () => {
  const t = createTestContext(client);
  await t.start();
  const entry = {
    id: "c1",
    title: "Plan the week",
    at: "2026-11-06T00:00:00Z",
    latest: { id: "m2", at: "2026-11-06T00:00:05Z" },
    archived: false,
  };
  const binding = t.bind("chat", {
    list: ({ archived }) => ({ chats: archived ? [] : [entry], more: false }),
    rename: () => ({}),
    archive: () => ({}),
  });
  assert.deepEqual(await t.ctx.slots.chat.call.list({}), { chats: [entry], more: false });
  assert.deepEqual((await t.ctx.slots.chat.call.list({ archived: true, limit: 200 })).chats, []);
  await assert.rejects(t.ctx.slots.chat.call.list({ limit: 201 }), { code: "invalid" });
  assert.deepEqual(await t.ctx.slots.chat.call.rename({ chat: "c1", title: "Next week" }), {});
  await assert.rejects(t.ctx.slots.chat.call.rename({ chat: "c1", title: "  " }), {
    code: "invalid",
  });
  assert.deepEqual(await t.ctx.slots.chat.call.archive({ chat: "c1", archived: true }), {});
  const seen: unknown[] = [];
  t.ctx.slots.chat.on("chat", (one) => seen.push(one));
  binding.emit("chat", { ...entry, archived: true });
  // A problem is told with the chat it is in, with the code a view offers an action for.
  const problem = { code: "usage_limit", message: "Usage limit reached." };
  binding.emit("chat", { ...entry, problem });
  assert.deepEqual(seen, [
    { ...entry, archived: true },
    { ...entry, problem },
  ]);
  assert.throws(() => binding.emit("chat", { ...entry, problem: { code: "x" } } as never), {
    code: "bad_output",
  });
});

test("a field says what an agent may do with it, from a closed list", () => {
  const field = { id: "mode", type: "text", value: "string", title: "Mode" } as const;
  for (const authority of ["setting", "holds", "contacts", "instructs", "runs"])
    assert.ok(Field.safeParse({ ...field, authority }).success, authority);
  assert.equal(Field.safeParse({ ...field, authority: "anything" }).success, false);
  assert.equal(Field.parse(field).authority, undefined, "none declared: closed");
});
