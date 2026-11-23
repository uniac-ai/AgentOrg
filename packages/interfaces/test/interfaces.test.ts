import assert from "node:assert/strict";
import test from "node:test";
import { defineActor, describeInterface } from "@agentorg/sdk";
import { createTestContext } from "@agentorg/sdk/testing";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import {
  Activity,
  accountLogin,
  agentProvider,
  agentSettings,
  agentSettings2,
  agents,
  agents2,
  capability,
  capabilityProvider,
  chat,
  connections,
  FactRow,
  Field,
  hubActors,
  hubAudit,
  hubBindings,
  hubExports,
  hubGrants,
  kv,
  llmSession,
  MESSAGE_TEXT_MAX,
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

const management = [
  tools,
  agentSettings,
  agentProvider,
  agents,
  connections,
  skills,
  unitProvider,
  capabilityProvider,
  agentSettings2,
  agents2,
];

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
      "capability.provider@1",
      "agent.settings@2",
      "agents@2",
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

test("a unit's status may restate an instance made under older words: its answers and its rows", () => {
  const status = compiled(unitProvider)["status.output"];
  assert.ok(status);
  const now = {
    values: { kind: "new", made: "container", access: "terminal", browser: true },
    rows: {
      where: [{ label: "Computer", value: "A container", note: "Made for it on this machine" }],
    },
  };
  assert.ok(status({ state: "connected", connections: [], now }));
  assert.ok(status({ state: "connected", connections: [] }), "none said: as it was built");
  assert.ok(status({ state: "connected", connections: [], now: { values: now.values } }));
  assert.equal(status({ state: "connected", connections: [], now: { ...now, more: 1 } }), false);
  assert.equal(status({ state: "connected", connections: [], now: { rows: now.rows } }), false);
});

test("a capability may be made of plugins, with or without an Actor, and the agent's settings say every plugin it holds", () => {
  const applied = compiled(unitProvider)["apply.output"];
  assert.ok(applied);
  const made = { instance: "i1", connections: [], results: [] };
  // As before: an Actor, with no plugins.
  assert.ok(applied({ ...made, capability: { actor: "a1" } }));
  // Only parts inside the agent, each by name with its own settings; or both.
  const memory = { name: "memory", settings: { keep: true, tidy: { after: "6h" } } };
  assert.ok(applied({ ...made, capability: { plugins: [memory] } }));
  assert.ok(applied({ ...made, capability: { actor: "a1", plugins: [{ name: "search" }] } }));
  assert.equal(applied({ ...made, capability: { plugins: [{ name: "Memory" }] } }), false);
  assert.equal(applied({ ...made, capability: { plugins: [{ ...memory, on: true }] } }), false);

  const settings = compiled(agentSettings)["get.output"];
  assert.ok(settings);
  // From a management that doesn't say them: none, as before.
  assert.ok(settings({ instructions: "Hi.", skills: [] }));
  assert.ok(
    settings({ instructions: "Hi.", skills: [], plugins: [{ ...memory, capability: "memory" }] }),
  );
  assert.equal(settings({ instructions: "Hi.", skills: [], plugins: [memory] }), false);
});

test("what an agent holds may be made of plugins, and then needn't be reached by the person: agents@1 says both", () => {
  const got = compiled(agents)["get.output"];
  assert.ok(got);
  const agent = {
    agent: "act_1",
    name: "A",
    status: { state: "running" },
    provider: "act_2",
    creatable: "assistant",
    instructions: "",
    skills: [],
    mcp: [],
    units: [],
  };
  const holds = (...capabilities: object[]) => got({ ...agent, capabilities });
  const held = { id: "desk", title: "Desk", slots: [], surfaces: [], views: [] };
  const person = { capability: "desk", operations: {} };
  // As before: reached by the person's slots, with no plugins.
  assert.ok(holds({ ...held, person }));
  // Only parts inside the agent, each by name with its own settings, and no slots of the
  // person's; or both.
  const memory = { name: "memory", settings: { keep: true, tidy: { after: "6h" } } };
  assert.ok(holds({ ...held, plugins: [memory] }));
  assert.ok(holds({ ...held, person, plugins: [{ name: "search" }] }));
  // A plugin is said as a unit's capability says it, and a capability has 16 at most.
  assert.equal(holds({ ...held, plugins: [{ ...memory, capability: "desk" }] }), false);
  const many = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `part-${i}` }));
  assert.ok(holds({ ...held, plugins: many(16) }));
  assert.equal(holds({ ...held, plugins: many(17) }), false);
});

test("a capability provider lists what it makes, each made with the arguments its JSON Schema describes", () => {
  const listed = compiled(capabilityProvider)["capabilities.output"];
  assert.ok(listed);
  const memory = {
    id: "memory",
    title: "Memory",
    description: "It remembers what you tell it to.",
    arguments: { type: "object", properties: {}, additionalProperties: false },
  };
  const github = {
    id: "github",
    title: "GitHub",
    description: "Its repositories, as functions.",
    arguments: {
      type: "object",
      properties: {
        owner: { type: "string", title: "Owner" },
        token: { type: "string", title: "Token", secret: true },
      },
      required: ["owner", "token"],
    },
  };
  assert.ok(listed({ capabilities: [memory, github] }));
  assert.ok(listed({ capabilities: [] }));
  // The arguments are always an object's schema; an id is a slug; nothing else is said, no
  // asking a person first, which is the control capability's own to decide.
  assert.equal(listed({ capabilities: [{ ...memory, arguments: { type: "string" } }] }), false);
  assert.equal(listed({ capabilities: [{ ...memory, arguments: {} }] }), false);
  assert.equal(listed({ capabilities: [{ ...memory, id: "Memory" }] }), false);
  assert.equal(listed({ capabilities: [{ ...memory, asks: ["person"] }] }), false);
});

test("a capability is mounted from its arguments, or each problem with them is said and nothing made", () => {
  for (const iface of [capabilityProvider, agents]) {
    const id = describeInterface(iface).id;
    const mount = compiled(iface)["mount.output"];
    assert.ok(mount, id);
    assert.ok(mount({ mounted: "mnt_1" }), id);
    assert.ok(mount({ problems: [{ path: "/token", message: "A token is needed." }] }), id);
    assert.ok(mount({ problems: [{ message: "The owner and the token don't match." }] }), id);
    assert.ok(mount({ problems: [{ path: "/a~1b/0", message: "x" }] }), id);
    // Mounted, or not and why: never both, never neither, and a path is a JSON Pointer.
    assert.equal(mount({ mounted: "mnt_1", problems: [{ message: "x" }] }), false, id);
    assert.equal(mount({}), false, id);
    assert.equal(mount({ problems: [] }), false, id);
    assert.equal(mount({ problems: [{ path: "token", message: "x" }] }), false, id);
    assert.equal(mount({ problems: [{ path: "/a~2", message: "x" }] }), false, id);
    assert.equal(mount({ problems: [{ path: "/token", message: "" }] }), false, id);
  }
  const provider = compiled(capabilityProvider);
  const asked = { agent: "act_a", capability: "memory", arguments: {} };
  assert.ok(provider["mount.input"]?.(asked));
  assert.ok(provider["mount.input"]?.({ ...asked, arguments: { owner: "o", deep: { a: [1] } } }));
  assert.equal(provider["mount.input"]?.({ agent: "act_a", capability: "memory" }), false);
  assert.equal(provider["mount.input"]?.({ ...asked, capability: "Memory" }), false);
  assert.ok(provider["unmount.input"]?.({ agent: "act_a", mounted: "mnt_1" }));
  assert.equal(provider["unmount.input"]?.({ mounted: "mnt_1" }), false);

  // Through management, the caller names the provider too.
  const manage = compiled(agents);
  assert.ok(manage["mount.input"]?.({ ...asked, provider: "act_p" }));
  assert.equal(manage["mount.input"]?.(asked), false);
  assert.ok(manage["unmount.input"]?.({ agent: "act_a", mounted: "mnt_1" }));
  assert.equal(manage["unmount.input"]?.({ agent: "act_a" }), false);
  assert.ok(manage["unmount.output"]?.({}));
});

test("an agent says each capability mounted on it, with its state; management's get gives that tree under each it mounted", () => {
  const status = compiled(agentProvider)["status.output"];
  assert.ok(status);
  const memory = { name: "memory", title: "Memory", state: "mounted" };
  const tidy = {
    name: "memory-tidy",
    title: "Memory keeps itself",
    state: "mounted",
    parent: "memory",
  };
  const connector = {
    name: "hub",
    title: "Hub connector",
    state: "down",
    detail: "Its connection to the Hub ended.",
  };
  assert.ok(status({ state: "running", mounted: [connector, memory, tidy] }));
  assert.ok(status({ state: "running", mounted: [] }));
  assert.ok(status({ state: "running" }), "none said: a provider that doesn't say");
  const failed = {
    name: "memory",
    title: "Memory",
    state: "failed",
    detail: "Its lines couldn't be read.",
  };
  assert.ok(status({ state: "running", detail: "It runs without memory.", mounted: [failed] }));
  assert.equal(status({ state: "running", mounted: [{ ...memory, state: "loading" }] }), false);
  assert.equal(status({ state: "running", mounted: [{ ...memory, name: "Memory" }] }), false);
  assert.equal(status({ state: "running", mounted: [{ ...memory, by: "person" }] }), false);
  const many = (length: number) =>
    Array.from({ length }, (_, i) => ({ ...memory, name: `part-${i}` }));
  assert.ok(status({ state: "running", mounted: many(256) }));
  assert.equal(status({ state: "running", mounted: many(257) }), false);
  // The person's list says how each agent stands, and nothing of what it holds.
  const listed = compiled(agents)["list.output"];
  const agent = { agent: "act_1", name: "A", provider: "act_2", creatable: "assistant" };
  assert.ok(listed?.({ agents: [{ ...agent, status: { state: "running" } }] }));
  assert.equal(
    listed?.({ agents: [{ ...agent, status: { state: "running", mounted: [memory] } }] }),
    false,
  );

  const got = compiled(agents)["get.output"];
  assert.ok(got);
  const entry = {
    ...agent,
    status: { state: "running" },
    instructions: "",
    skills: [],
    mcp: [],
    units: [],
    capabilities: [],
  };
  const root = {
    mounted: "mnt_1",
    provider: "act_2",
    capability: "memory",
    title: "Memory",
    arguments: {},
    by: "person",
    state: "mounted",
    children: [tidy],
  };
  assert.ok(got({ ...entry, mounted: [root] }));
  assert.ok(got({ ...entry, mounted: [] }));
  assert.ok(got(entry), "none said: something written before this");
  // With no state, the agent couldn't be asked; its children are then not known.
  const { state: _, ...unknown } = root;
  assert.ok(got({ ...entry, mounted: [{ ...unknown, children: [] }] }));
  // Mounted by an agent or a program, by its Actor id; never with a secret kept beside it.
  assert.ok(got({ ...entry, mounted: [{ ...root, by: "act_9", arguments: { owner: "o" } }] }));
  assert.equal(got({ ...entry, mounted: [{ ...root, secrets: { token: "t" } }] }), false);
  assert.equal(
    got({ ...entry, mounted: [{ ...root, children: [{ ...tidy, state: "x" }] }] }),
    false,
  );
  const { by: __, ...nobody } = root;
  assert.equal(got({ ...entry, mounted: [nobody] }), false);
});

test("an agent says everything it is made of, plugins among its capabilities, each with what it added; management's get gives that whole tree", () => {
  const status = compiled(agentProvider)["status.output"];
  assert.ok(status);
  const memory = {
    name: "memory",
    title: "Memory",
    state: "mounted",
    added: { functions: ["memory__edit"], sections: ["lines"] },
  };
  const watcher = {
    name: "lines-watcher-23",
    title: "linesWatcher",
    state: "mounted",
    parent: "memory",
    kind: "plugin",
    added: { functions: [], sections: [] },
  };
  const waiting = {
    name: "indexer-24",
    title: "indexer",
    state: "down",
    detail: "It waits for a service it needs.",
    parent: "memory",
    kind: "plugin",
  };
  assert.ok(status({ state: "running", mounted: [memory, watcher, waiting] }));
  // A part is a capability or a plugin, and says what it added in no other shape.
  assert.equal(status({ state: "running", mounted: [{ ...watcher, kind: "capability" }] }), false);
  assert.equal(
    status({ state: "running", mounted: [{ ...memory, added: { functions: ["x"] } }] }),
    false,
  );
  assert.equal(
    status({ state: "running", mounted: [{ ...memory, added: { ...memory.added, blocks: [] } }] }),
    false,
  );
  assert.equal(
    status({
      state: "running",
      mounted: [{ ...memory, added: { functions: ["f".repeat(65)], sections: [] } }],
    }),
    false,
  );
  // What was said before this still is.
  assert.ok(
    status({ state: "running", mounted: [{ name: "hub", title: "Hub", state: "mounted" }] }),
  );

  const got = compiled(agents)["get.output"];
  assert.ok(got);
  const entry = {
    agent: "act_1",
    name: "A",
    provider: "act_2",
    creatable: "assistant",
    status: { state: "running" },
    instructions: "",
    skills: [],
    mcp: [],
    units: [],
    capabilities: [],
    mounted: [],
  };
  assert.ok(got({ ...entry, composition: [memory, watcher, waiting] }));
  assert.ok(
    got(entry),
    "none said: an agent that can't be asked, or something written before this",
  );
  assert.equal(got({ ...entry, composition: [{ ...watcher, by: "person" }] }), false);
});

test("a fact may carry a note under its value, short and never empty", () => {
  const row = {
    label: "Its work happens in",
    value: "~/Agents/Research",
    path: true,
    note: "Said to it, not a wall",
  } as const;
  assert.equal(FactRow.parse(row).note, "Said to it, not a wall");
  assert.equal(FactRow.safeParse({ ...row, note: "" }).success, false);
  assert.equal(FactRow.safeParse({ ...row, note: "x".repeat(257) }).success, false);
  assert.equal(FactRow.parse({ label: "Reaches", value: "Files" }).note, undefined);
});

test("a choice's option may say why it can't be chosen now", () => {
  const field = {
    id: "made",
    type: "choice",
    value: "string",
    title: "Made as",
    options: [
      {
        value: "container",
        title: "A container on this machine",
        unavailable: "A container needs Docker, which isn't answering on this machine.",
      },
    ],
  };
  assert.equal(Field.parse(field).options?.[0]?.unavailable, field.options[0]?.unavailable);
  const option = (extra: object) => ({ ...field, options: [{ ...field.options[0], ...extra }] });
  assert.equal(Field.safeParse(option({ unavailable: "" })).success, false, "a reason, or none");
  const units = compiled(unitProvider)["units.output"];
  assert.ok(units?.({ units: [{ ...computer, form: [field] }] }));
});

test("a capability that can't be reached may say ways forward: a unit, and the values to open its form with", () => {
  const state = compiled(capability)["state.output"];
  assert.ok(state);
  const way = {
    title: "Attach this computer",
    description: "Its work happens in ~/Agents/Support, as before.",
    unit: "computer",
    values: { computer: "this", workspace: "~/Agents/Support", browser: true },
  };
  assert.ok(state({ state: "down", detail: "Not started.", surfaces: [], ways: [way] }));
  assert.ok(state({ state: "connected", surfaces: [] }), "none said: none offered");
  // A way holds nothing else, and names a unit by its id.
  assert.equal(state({ state: "down", surfaces: [], ways: [{ ...way, secrets: {} }] }), false);
  assert.equal(state({ state: "down", surfaces: [], ways: [{ ...way, unit: "Computer" }] }), false);
  assert.equal(
    state({ state: "down", surfaces: [], ways: [{ ...way, values: { nested: { a: 1 } } }] }),
    false,
  );
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
  // A picture may be sent by itself, but a message has words or a picture.
  const picture = { mediaType: "image/png", data: "iVBORw0KGgo=" };
  assert.equal(compiled(chat)["send.input"]?.({ images: [picture] }), true);
  assert.equal(compiled(chat)["send.input"]?.({ text: " ", images: [] }), false);
  assert.equal(compiled(chat)["send.input"]?.({}), false);
  // The most a message's text has, which a page says before sending, is the wire's own limit.
  const send = compiled(chat)["send.input"];
  assert.equal(send?.({ text: "x".repeat(MESSAGE_TEXT_MAX) }), true);
  assert.equal(send?.({ text: "x".repeat(MESSAGE_TEXT_MAX + 1) }), false);
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

test("chat@1 sends in the caller's conversation, pages one's history, and says only whether the agent is working", async () => {
  const t = createTestContext(client);
  await t.start();
  const binding = t.bind("chat", {
    send: () => ({ messageId: "m2" }),
    history: ({ with: party }) => ({
      messages: [{ id: "m1", role: "user", text: party ?? "mine", at: "2026-11-06T00:00:00Z" }],
      more: false,
    }),
    state: () => ({ state: "working" as const }),
  });
  assert.deepEqual(await t.ctx.slots.chat.call.send({ text: "hi" }), { messageId: "m2" });
  await assert.rejects(t.ctx.slots.chat.call.send({ text: "   " }), { code: "invalid" });
  // A picture may be sent by itself; a message with neither words nor a picture is refused.
  const picture = { mediaType: "image/png" as const, data: "iVBORw0KGgo=" };
  assert.equal((await t.ctx.slots.chat.call.send({ images: [picture] })).messageId, "m2");
  assert.equal((await t.ctx.slots.chat.call.send({ text: "", images: [picture] })).messageId, "m2");
  await assert.rejects(t.ctx.slots.chat.call.send({} as never), { code: "invalid" });
  await assert.rejects(t.ctx.slots.chat.call.send({ text: " ", images: [] }), { code: "invalid" });
  assert.equal((await t.ctx.slots.chat.call.history({})).messages[0]?.text, "mine");
  assert.equal(
    (await t.ctx.slots.chat.call.history({ with: "act_1", limit: 10 })).messages[0]?.text,
    "act_1",
  );
  assert.deepEqual(await t.ctx.slots.chat.call.state({}), { state: "working" });
  const states: unknown[] = [];
  t.ctx.slots.chat.on("status", (status) => states.push(status));
  binding.emit("status", { state: "working" });
  binding.emit("status", { state: "idle" });
  assert.deepEqual(states, [{ state: "working" }, { state: "idle" }]);
  // A conversation is never said to think, to use a tool or to have failed.
  for (const state of ["thinking", "tool", "error"])
    assert.throws(() => binding.emit("status", { state } as never), { code: "bad_output" });
  // And nothing in it stops, runs again, chooses a model, or is renamed or archived.
  for (const gone of ["cancel", "retry", "models", "setModel", "rename", "archive"])
    assert.equal(gone in chat.methods, false, gone);
});

test("chat@1 lists an agent's conversations, each with its latest message and why one got no answer", async () => {
  const t = createTestContext(client);
  await t.start();
  const entry = {
    with: "person",
    at: "2026-11-06T00:00:00Z",
    latest: { id: "m2", at: "2026-11-06T00:00:05Z", role: "assistant" as const, text: "Done." },
  };
  const binding = t.bind("chat", {
    list: () => ({ conversations: [entry], more: false }),
  });
  assert.deepEqual(await t.ctx.slots.chat.call.list({}), {
    conversations: [entry],
    more: false,
  });
  await assert.rejects(t.ctx.slots.chat.call.list({ limit: 201 }), { code: "invalid" });
  const seen: unknown[] = [];
  t.ctx.slots.chat.on("chat", (one) => seen.push(one));
  // A problem is told with the conversation it is in, with the code a view offers an action for.
  const problem = { code: "usage_limit", message: "Usage limit reached." };
  binding.emit("chat", { ...entry, problem });
  assert.deepEqual(seen, [{ ...entry, problem }]);
  assert.throws(() => binding.emit("chat", { ...entry, problem: { code: "x" } } as never), {
    code: "bad_output",
  });
  // An entry carries the head of its latest message, no more.
  assert.throws(
    () =>
      binding.emit("chat", {
        ...entry,
        latest: { ...entry.latest, text: "x".repeat(201) },
      }),
    { code: "bad_output" },
  );
});

test("chat@1 says what became of each message the party said, with the step at work on it", async () => {
  const t = createTestContext(client);
  await t.start();
  const message = {
    id: "m1",
    role: "user" as const,
    text: "Find a flight.",
    at: "2026-11-19T00:00:00Z",
  };
  const binding = t.bind("chat", {
    history: () => ({
      messages: [
        { ...message, progress: { state: "taken" as const, step: "Comparing prices" } },
        { id: "m2", role: "assistant" as const, text: "On it.", at: "2026-11-19T00:00:01Z" },
      ],
      more: false,
    }),
  });
  // A view opened late reads it with the message.
  assert.deepEqual((await t.ctx.slots.chat.call.history({})).messages[0]?.progress, {
    state: "taken",
    step: "Comparing prices",
  });
  const seen: unknown[] = [];
  t.ctx.slots.chat.on("progress", (one) => seen.push(one));
  const said = [
    { with: "person", id: "m1", state: "taken" as const },
    { with: "person", id: "m1", state: "taken" as const, step: "Comparing prices" },
    { with: "person", id: "m1", state: "answered" as const },
    { with: "person", id: "m3", state: "closed" as const },
    { with: "person", id: "m4", state: "taken" as const, step: "x".repeat(200) },
  ];
  for (const one of said) binding.emit("progress", one);
  assert.deepEqual(seen, said);
  // Three states, a step of at most 200 characters, and always the message it is about.
  for (const bad of [
    { with: "person", id: "m1", state: "failed" },
    { with: "person", id: "m1", state: "taken", step: "x".repeat(201) },
    { with: "person", state: "taken" },
  ])
    assert.throws(() => binding.emit("progress", bad as never), { code: "bad_output" });
});

test("chat@1 carries the reaction a message was closed with, a reply's decision card, and the party's answer to it", async () => {
  const t = createTestContext(client);
  await t.start();
  const ask = {
    questions: [
      {
        question: "Delete everything in the folder?",
        choices: [
          { label: "Yes, delete it" },
          { label: "No, keep it", detail: "Nothing changes." },
        ],
      },
    ],
  };
  const reply = {
    id: "m2",
    role: "assistant" as const,
    text: "Here it is.",
    at: "2026-11-21T00:00:01Z",
  };
  const answered = {
    id: "m3",
    role: "user" as const,
    text: "No, keep it",
    at: "2026-11-21T00:00:02Z",
    answer: { to: "m2", picks: [[1]] },
  };
  const binding = t.bind("chat", {
    history: () => ({
      messages: [
        {
          id: "m1",
          role: "user" as const,
          text: "Thanks!",
          at: "2026-11-21T00:00:00Z",
          progress: { state: "closed" as const, reaction: "👍" },
        },
        { ...reply, ask },
        answered,
      ],
      more: false,
    }),
  });
  // A view opened late reads them with their messages: the card, and the message that answers it.
  const [thanks, sent, answer] = (await t.ctx.slots.chat.call.history({})).messages;
  assert.deepEqual(thanks?.progress, { state: "closed", reaction: "👍" });
  assert.deepEqual(sent?.ask, ask);
  assert.deepEqual(answer?.answer, { to: "m2", picks: [[1]] });
  // Live, the reaction comes with the close, and the card with the reply.
  const closes: unknown[] = [];
  const replies: unknown[] = [];
  t.ctx.slots.chat.on("progress", (one) => closes.push(one));
  t.ctx.slots.chat.on("message", (one) => replies.push(one));
  binding.emit("progress", { with: "person", id: "m1", state: "closed", reaction: "🇫🇷" });
  binding.emit("message", { ...reply, with: "person", ask });
  assert.deepEqual(closes, [{ with: "person", id: "m1", state: "closed", reaction: "🇫🇷" }]);
  assert.deepEqual(replies, [{ ...reply, with: "person", ask }]);
  // Several questions, each named for its tab, and one that takes many.
  const tabs = {
    questions: [
      { header: "Size", choices: [{ label: "Small" }, { label: "Large" }] },
      { header: "Extras", choices: [{ label: "Lid" }, { label: "Sleeve" }], many: true as const },
    ],
  };
  binding.emit("message", { ...reply, with: "person", ask: tabs });
  const refused = (ask: unknown) =>
    assert.throws(() => binding.emit("message", { ...reply, with: "person", ask } as never), {
      code: "bad_output",
    });
  const choices = [{ label: "Yes" }];
  // Within its limits: four questions of four choices, short words, and a tab name for each of several.
  refused({ questions: [] });
  refused({ questions: Array(5).fill({ header: "Q", choices }) });
  refused({ questions: [{ choices: Array(5).fill({ label: "Yes" }) }] });
  refused({ questions: [{ choices: [{ label: "x".repeat(49) }] }] });
  refused({ questions: [{ choices: [{ label: "Yes", detail: "x".repeat(121) }] }] });
  refused({ questions: [{ header: "x".repeat(13), choices }] });
  refused({ questions: [{ choices }, { choices }] });
  refused({
    questions: [
      { header: "A", choices },
      { header: "B", choices },
    ],
    confirm: true,
  });
  refused({ questions: [{ choices, many: false }] });
  // A question taking many is always confirmed: a confirm beside it says nothing, so it's refused.
  binding.emit("message", {
    ...reply,
    with: "person",
    ask: { questions: [{ choices, many: true }] },
  });
  refused({ questions: [{ choices, many: true }], confirm: true });
  binding.emit("message", {
    ...reply,
    with: "person",
    ask: { questions: [{ choices }], confirm: true },
  });
  assert.throws(
    () =>
      binding.emit("progress", {
        with: "person",
        id: "m1",
        state: "closed",
        reaction: "x".repeat(17),
      }),
    { code: "bad_output" },
  );

  // The party answers with the answer alone: the provider writes its words.
  const send = compiled(chat)["send.input"];
  assert.ok(send);
  assert.ok(send({ answer: { to: "m2", picks: [[1]] } }));
  assert.ok(send({ answer: { to: "m2", picks: [[0], [0, 1]] } }));
  assert.equal(send({ answer: { to: "m2", picks: [] } }), false);
  assert.equal(send({ answer: { to: "m2", picks: [[4]] } }), false);
  assert.ok(send({ text: "Something else." }), "typing instead is a message as any");
});

test("a piece of work's Activity may carry the steps it keeps, each in one of three states", () => {
  const work = {
    id: "w1",
    title: "Find a flight",
    state: "working" as const,
    entries: [],
    more: false,
  };
  const steps = [
    { text: "Search flights", state: "completed" as const },
    { text: "Compare prices", active: "Comparing prices", state: "in_progress" as const },
    { text: "Book", state: "pending" as const },
  ];
  assert.deepEqual(Activity.parse({ works: [{ ...work, steps }] }).works[0]?.steps, steps);
  // A page that knows no steps reads a piece of work without them as before.
  assert.equal("steps" in (Activity.parse({ works: [work] }).works[0] ?? {}), false);
  for (const bad of [
    [{ text: "Book", state: "failed" }],
    [{ text: "Book", state: "pending", owner: "me" }],
  ])
    assert.equal(Activity.safeParse({ works: [{ ...work, steps: bad }] }).success, false);
});

test("a field says what an agent may do with it, from a closed list", () => {
  const field = { id: "mode", type: "text", value: "string", title: "Mode" } as const;
  for (const authority of ["setting", "holds", "contacts", "instructs", "runs"])
    assert.ok(Field.safeParse({ ...field, authority }).success, authority);
  assert.equal(Field.safeParse({ ...field, authority: "anything" }).success, false);
  assert.equal(Field.parse(field).authority, undefined, "none declared: closed");
});

test("agent.settings@2 gives what is mounted on the caller, in order, each root by its id, capability and arguments; management's own name no provider", () => {
  const settings = compiled(agentSettings2);
  const got = settings["get.output"];
  assert.ok(got);
  const instructions = {
    mounted: "instructions",
    capability: "instructions",
    arguments: { text: "You keep the docs.\n\nWhat you are for: the docs." },
  };
  const skills = {
    mounted: "skills",
    capability: "skills",
    arguments: { skills: [{ name: "review", description: "Review a change." }] },
  };
  const memory = { mounted: "mnt_1", capability: "memory", arguments: {}, provider: "act_e" };
  const github = {
    mounted: "mnt_2",
    capability: "github",
    arguments: { owner: "o", deep: { a: [1] } },
    provider: "act_g",
  };
  assert.ok(got({ mounted: [instructions, skills, memory, github] }));
  assert.ok(got({ mounted: [] }));
  // In place of the first major's shape, not beside it; a root says no more than this.
  assert.equal(got({ instructions: "x", skills: [] }), false);
  assert.equal(got({ mounted: [instructions], instructions: "x" }), false);
  assert.equal(got({ mounted: [{ ...memory, plugins: [{ name: "memory" }] }] }), false);
  assert.equal(got({ mounted: [{ ...memory, capability: "Memory" }] }), false);
  assert.equal(got({ mounted: [{ ...memory, arguments: undefined }] }), false);
  // An agent holding 64 plugins has room for them beside management's own roots and its control.
  const many = (length: number) =>
    Array.from({ length }, (_, i) => ({ ...memory, mounted: `mnt_${i}` }));
  assert.ok(got({ mounted: [instructions, skills, ...many(65)] }));
  assert.ok(got({ mounted: many(256) }));
  assert.equal(got({ mounted: many(257) }), false);
  // A skill's files are read as before; told what changed, it reads the tree again.
  assert.ok(settings["skill.input"]?.({ name: "review", path: "SKILL.md" }));
  assert.equal(settings["skill.input"]?.({ name: "review", path: "../x" }), false);
  assert.ok(settings["changed.event"]?.({}));
  // The first major stays as it was, for a program that still reads it.
  assert.ok(compiled(agentSettings)["get.output"]?.({ instructions: "x", skills: [] }));
});

test("agents@1 lists every capability its providers offer, each naming its provider", () => {
  const listed = compiled(agents)["capabilities.output"];
  assert.ok(listed);
  const memory = {
    id: "memory",
    title: "Memory",
    description: "It remembers what you tell it to.",
    arguments: { type: "object", properties: {} },
    provider: "act_e",
  };
  assert.ok(listed({ capabilities: [memory] }));
  assert.ok(listed({ capabilities: [] }));
  const { provider: _, ...unnamed } = memory;
  assert.equal(listed({ capabilities: [unnamed] }), false);
  assert.equal(listed({ capabilities: [{ ...memory, asks: ["person"] }] }), false);
  assert.ok(compiled(agents)["capabilities.input"]?.({}));
});

test("a provider's mount says what it made for management to wire: connections, skills and the person's capability; one inside the agent says only what it mounted", () => {
  const provider = compiled(capabilityProvider);
  const mounted = provider["mount.output"];
  assert.ok(mounted);
  assert.ok(mounted({ mounted: "mnt_1" }));
  const made = {
    connections: [{ slot: "computer", connection: "act_c", target: "this computer" }],
    skills: [{ name: "computer", files: ["SKILL.md", "ALWAYS.md"] }],
    capability: { actor: "act_w", rows: { place: [{ label: "Where", value: "Here" }] } },
  };
  assert.ok(mounted({ mounted: "mnt_1", made }));
  assert.ok(mounted({ mounted: "mnt_1", made: {} }));
  assert.ok(mounted({ problems: [{ message: "No room." }] }));
  // Nothing beside what was made, and no skill without its files.
  assert.equal(mounted({ mounted: "mnt_1", made: { ...made, results: [] } }), false);
  assert.equal(
    mounted({ mounted: "mnt_1", made: { skills: [{ name: "computer", files: [] }] } }),
    false,
  );
  assert.equal(mounted({ mounted: "mnt_1", made: { capability: { rows: {} } } }), false);
  // A skill's files are read through the provider, by the capability that makes them.
  assert.ok(
    provider["skill.input"]?.({ capability: "computer", name: "computer", path: "SKILL.md" }),
  );
  assert.equal(
    provider["skill.input"]?.({ unit: "computer", name: "computer", path: "SKILL.md" }),
    false,
  );
  // Management's own mount still answers what was mounted, and nothing it made.
  assert.equal(compiled(agents)["mount.output"]?.({ mounted: "mnt_1", made }), false);
});

test("agents@2 makes an agent empty and is what is mounted on it, and carries every call a page makes beside units", () => {
  const a = compiled(agents2);
  assert.deepEqual(Object.keys(agents2.methods).sort(), [
    "activity",
    "capabilities",
    "create",
    "expose",
    "get",
    "list",
    "live",
    "models",
    "mount",
    "remove",
    "removeTemplate",
    "saveTemplate",
    "setModel",
    "start",
    "stop",
    "templates",
    "unexpose",
    "unmount",
  ]);
  // The calls carried over are agents@1's, as they are.
  for (const name of [
    "start",
    "stop",
    "activity",
    "live",
    "models",
    "setModel",
    "expose",
    "unexpose",
  ])
    assert.equal(
      agents2.methods[name as keyof typeof agents2.methods],
      agents.methods[name as keyof typeof agents.methods],
      name,
    );
  assert.ok(a["create.input"]?.({ name: "Pat" }));
  assert.ok(a["create.input"]?.({ name: "Pat", purpose: "Keeps the docs." }));
  // A stack or a template isn't how an agent is made.
  assert.equal(
    a["create.input"]?.({ stack: { base: { provider: "act_2", creatable: "assistant" } } }),
    false,
  );
  const entry = { agent: "act_1", name: "Pat", status: { state: "running" }, provider: "act_2" };
  assert.ok(a["list.output"]?.({ agents: [entry] }));
  const template = {
    mounted: "mnt_t",
    provider: "act_m",
    capability: "assistant",
    title: "Assistant",
    arguments: {},
    by: "person",
    children: [],
  };
  const computer = {
    mounted: "mnt_c",
    provider: "act_c",
    capability: "computer",
    title: "Computer",
    arguments: { kind: "this" },
    by: "person",
    children: [],
    parent: "mnt_t",
  };
  const part = { name: "memory", title: "Memory", state: "mounted" };
  // What the page reads of an agent, but its base, its template and its units.
  const detail = {
    ...entry,
    instructions: "Be plain.",
    skills: [{ name: "notes", description: "Notes." }],
    mcp: [],
    capabilities: [],
  };
  assert.ok(a["get.output"]?.({ ...detail, mounted: [template, computer], composition: [part] }));
  assert.ok(a["get.output"]?.({ ...detail, mounted: [] }));
  assert.equal(a["get.output"]?.({ ...detail }), false, "what was mounted is always said");
  // A template is capabilities with their arguments; a shipped one says so.
  const saved = {
    id: "keeper",
    title: "Keeper",
    description: "Keeps things.",
    capabilities: [
      { provider: "Computers", capability: "computer", arguments: { kind: "this" } },
      { provider: "Agents", capability: "memory", arguments: {} },
    ],
  };
  assert.ok(a["saveTemplate.input"]?.(saved));
  assert.ok(a["templates.output"]?.({ templates: [{ ...saved, shipped: true }] }));
  assert.equal(
    a["saveTemplate.input"]?.({ ...saved, units: [{ provider: "Units", unit: "files" }] }),
    false,
  );
  assert.ok(a["removeTemplate.input"]?.({ id: "keeper" }));
  // A template as management offers it: its arguments, one property for each capability it lists,
  // each that capability's own schema, a computer's token secret among them.
  const remote = {
    id: "remote-keeper",
    title: "Remote keeper",
    description: "Keeps things on a computer elsewhere.",
    arguments: {
      type: "object",
      properties: {
        computer: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["this", "new"] },
            address: { type: "string" },
            token: { type: "string", title: "Token", secret: true },
          },
        },
        memory: { type: "object", properties: {} },
        "memory-2": { type: "object", properties: {} },
      },
    },
    provider: "act_management",
  };
  assert.ok(a["capabilities.output"]?.({ capabilities: [remote] }));
  // Filled as it is mounted: what is given overrides the template's, a secret among it.
  assert.ok(
    a["mount.input"]?.({
      agent: "act_1",
      provider: "act_management",
      capability: "remote-keeper",
      arguments: { computer: { address: "https://far.example/", token: "tok" } },
    }),
  );
  // A required argument left empty is a problem at its key's path, and nothing is mounted.
  assert.ok(
    a["mount.output"]?.({
      problems: [{ path: "/computer/token", message: "Token must be given." }],
    }),
  );
  assert.ok(a["mount.output"]?.({ mounted: "mnt_1" }));
  assert.ok(a["capabilities.output"]?.({ capabilities: [] }));
});
