import assert from "node:assert/strict";
import test from "node:test";
import type { Field } from "@agentorg/interfaces";
import { filled } from "@agentorg/sdk";
import type { z } from "zod";
import {
  formProblems,
  givesProblems,
  heldProblems,
  schemaOf,
  settle,
  workedOut,
} from "../src/form.ts";

type Form = z.input<typeof Field>[];
const form: Form = [
  {
    id: "mode",
    type: "choice",
    value: "string",
    title: "Mode",
    default: "local",
    options: [
      { value: "local", title: "Local", description: "On this machine." },
      {
        value: "remote",
        title: "Remote",
        adds: { slots: [{ name: "tunnel" }], skills: [] },
      },
    ],
  },
  {
    id: "host",
    type: "text",
    value: "string",
    title: "Host",
    required: true,
    visible: { field: "mode", in: ["remote"] },
  },
  {
    id: "port",
    type: "number",
    value: "number",
    title: "Port",
    min: 1,
    max: 10,
    visible: { field: "host", in: ["a", "b"] },
  },
  {
    id: "key",
    type: "secret",
    value: "secret",
    title: "Key",
    required: true,
    visible: { field: "mode", in: ["remote"] },
  },
  {
    id: "tools",
    type: "choices",
    value: "strings",
    title: "Tools",
    options: [
      { value: "x", title: "X", adds: { slots: [{ name: "x" }], skills: [] } },
      { value: "y", title: "Y" },
    ],
  },
  {
    id: "on",
    type: "toggle",
    value: "boolean",
    title: "On",
    adds: { slots: [], skills: [{ field: "named" }] },
  },
  { id: "named", type: "text", value: "string", title: "Named" },
];
const unit = {
  id: "stand-in",
  title: "Stand-in",
  description: "",
  form,
  needs: [],
  gives: { slots: [{ name: "always" }], skills: [], results: [] },
} as never;

test("a field that isn't shown has no value, however far back the reason is", () => {
  const given = settle(form, { host: "a", port: 3 }, []);
  assert.deepEqual(given.values, { mode: "local" });
  assert.deepEqual(given.problems, []);
  const remote = settle(form, { mode: "remote", host: "a", port: 3 }, ["key"]);
  assert.deepEqual(remote.values, { mode: "remote", host: "a", port: 3 });
  assert.deepEqual(remote.secrets, ["key"]);
  assert.deepEqual(settle(form, { mode: "remote", host: "c", port: 3 }, ["key"]).values, {
    mode: "remote",
    host: "c",
  });
  // A secret not shown is dropped too.
  assert.deepEqual(settle(form, {}, ["key"]).secrets, []);
});

test("what is filled in is held to the form", () => {
  const messages = (values: object, secrets: string[] = []) =>
    settle(form, values as never, secrets).problems.map((p) => p.message);
  assert.deepEqual(messages({ mode: "remote" }), ["Host must be filled in.", "Key must be given."]);
  assert.deepEqual(messages({ mode: "other" }), ["Mode isn't one of its options."]);
  assert.deepEqual(messages({ mode: 3 }), ["Mode must be a string."]);
  assert.deepEqual(messages({ mode: "remote", host: "a", port: 11 }, ["key"]), [
    "Port is out of range.",
  ]);
  assert.deepEqual(messages({ tools: ["x", "z"] }), ["Tools isn't one of its options."]);
  assert.deepEqual(messages({ nothing: 1 }), ["This unit has no field nothing."]);
  assert.deepEqual(messages({ key: "x" }), ["Key is a secret: it isn't a value."]);
  assert.deepEqual(messages({}, ["host"]), ["host isn't a secret of this unit."]);
});

test("an empty answer is no answer", () => {
  const required = [
    { id: "a", type: "text", value: "string", title: "A", required: true },
    { id: "b", type: "text", value: "string", title: "B", default: "x" },
  ];
  const given = settle(required as never, { a: "", b: "" }, []);
  assert.deepEqual(given.values, { b: "x" });
  assert.deepEqual(given.problems, [{ field: "a", message: "A must be filled in." }]);
});

test("a form that can't be right is said to be", () => {
  const field = { type: "text", value: "string", title: "A" } as const;
  assert.deepEqual(formProblems(form as never), []);
  assert.deepEqual(
    formProblems([
      { id: "a", ...field },
      { id: "a", ...field },
      { id: "b", ...field, default: 3 },
      { id: "c", ...field, value: "secret", default: "x" },
      { id: "d", ...field, visible: { field: "nowhere", in: ["x"] } },
      { id: "e", ...field, value: "number", min: 2, max: 1 },
    ] as never),
    [
      "a is in the form twice.",
      "b's default isn't a string.",
      "c is a secret, which has no default.",
      "e's min is above its max.",
      "d depends on nowhere, which isn't in the form.",
    ],
  );
  // A field that depends on itself is never shown, and nothing hangs.
  const circular = [
    { id: "a", ...field, visible: { field: "b", in: ["x"] } },
    { id: "b", ...field, visible: { field: "a", in: ["x"] } },
  ];
  assert.deepEqual(settle(circular as never, { a: "x", b: "x" }, []).values, {});
});

test("what a unit gives is worked out from its description and the values alone", () => {
  const numeric = {
    ...(unit as object),
    form: [
      {
        id: "size",
        type: "choice",
        value: "number",
        title: "Size",
        options: [{ value: "1", title: "One", adds: { slots: [{ name: "one" }], skills: [] } }],
      },
    ],
  } as never;
  assert.deepEqual(workedOut(numeric, { size: 1 }).slots, ["always", "one"]);
  assert.deepEqual(workedOut(unit, { mode: "local" }), {
    slots: ["always"],
    skills: [],
    surfaces: [],
    views: [],
  });
  assert.deepEqual(workedOut(unit, { mode: "remote", tools: ["x", "y"] }).slots, [
    "always",
    "tunnel",
    "x",
  ]);
  assert.deepEqual(workedOut(unit, { on: true, named: "mine" }).skills, [{ name: "mine" }]);
  assert.deepEqual(workedOut(unit, { on: false, named: "mine" }).skills, []);
});

test("the schema an agent fills leaves secrets out and says when a field applies", () => {
  const schema = schemaOf(form as never) as {
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
  assert.deepEqual(Object.keys(schema.properties), [
    "mode",
    "host",
    "port",
    "tools",
    "on",
    "named",
  ]);
  assert.deepEqual(schema.required, []);
  const withDefault = [
    { id: "a", type: "text", value: "string", title: "A", required: true, default: "x" },
    { id: "b", type: "text", value: "string", title: "B", required: true },
  ];
  assert.deepEqual((schemaOf(withDefault as never) as { required: string[] }).required, ["b"]);
  assert.deepEqual(schema.properties.mode?.enum, ["local", "remote"]);
  assert.match(schema.properties.mode?.description as string, /local: On this machine/);
  assert.equal(schema.properties.mode?.default, "local");
  assert.match(schema.properties.host?.description as string, /Only when mode is remote/);
  assert.deepEqual(
    [
      schema.properties.port?.minimum,
      schema.properties.port?.maximum,
      schema.properties.port?.type,
    ],
    [1, 10, "number"],
  );
  assert.deepEqual(schema.properties.tools?.items, { type: "string", enum: ["x", "y"] });
  assert.equal(schema.properties.on?.type, "boolean");
});

test("the reader gives each kind, and a wrong question throws at once", () => {
  const read = filled(
    form as never,
    { mode: "remote", port: 3, on: true, tools: ["x"] },
    { key: "k" },
  );
  assert.equal(read.string("mode"), "remote");
  assert.equal(read.number("port"), 3);
  assert.equal(read.boolean("on"), true);
  assert.deepEqual(read.strings("tools"), ["x"]);
  assert.equal(read.secret("key"), "k");
  assert.equal(read.string("host"), undefined);
  assert.throws(() => read.string("nothing"), TypeError);
  assert.throws(() => read.number("mode"), TypeError);
  assert.throws(() => read.string("key"), TypeError);
});

test("what a unit gives the person's side is worked out the same way, in the order given, each once", () => {
  const top = { surface: "top", protocol: "stand-in@1" };
  const lamp = { surface: "lamp", protocol: "stand-in@1" };
  const where = { id: "where", place: "column", kind: "facts" };
  const glow = { id: "glow", place: "column", kind: "meters", surface: "lamp" };
  const desk = {
    id: "desk",
    title: "Desk",
    description: "",
    capability: { id: "desk", title: "Desk" },
    needs: [],
    gives: { slots: [], skills: [], results: [], surfaces: [top], views: [where] },
    form: [
      {
        id: "lamp",
        type: "toggle",
        value: "boolean",
        title: "Lamp",
        // What is given already stands: a surface or a view is given once.
        adds: { slots: [], skills: [], surfaces: [lamp, top], views: [glow, where] },
      },
    ],
  } as never;
  assert.deepEqual(workedOut(desk, {}).surfaces, [top]);
  assert.deepEqual(workedOut(desk, { lamp: true }).surfaces, [top, lamp]);
  assert.deepEqual(workedOut(desk, { lamp: true }).views, [where, glow]);
  assert.deepEqual(givesProblems(desk), []);
});

test("a unit that gives surfaces or views with no capability, or a view whose data is not one of the three, is not well made", () => {
  const base = { id: "u", title: "U", description: "", needs: [], form: [] };
  const gives = (more: object) => ({ slots: [], skills: [], results: [], ...more });
  assert.deepEqual(
    givesProblems({
      ...base,
      gives: gives({ surfaces: [{ surface: "top", protocol: "x@1" }] }),
    } as never),
    ["U gives surfaces or views and builds no capability to hold them."],
  );
  const view = (id: string, more: object) => ({ id, place: "column", kind: "facts", ...more });
  assert.deepEqual(
    givesProblems({
      ...base,
      capability: { id: "u", title: "U" },
      gives: gives({
        views: [
          view("both", { operation: "about", slot: "u", surface: "top" }),
          view("nowhere", { operation: "about" }),
          view("picked", { rows: ["Wood"] }),
          view("fine", { operation: "about", slot: "u", rows: ["Wood"] }),
          view("fixed", {}),
        ],
      }),
      // And in what an answer adds.
      form: [
        {
          id: "on",
          type: "toggle",
          value: "boolean",
          title: "On",
          adds: { slots: [], skills: [], views: [view("added", { slot: "u" })] },
        },
      ],
    } as never),
    [
      'U\'s view "both" has an operation and a surface: a view shows one or the other.',
      'U\'s view "nowhere" needs an operation and the slot it is at, both or neither.',
      'U\'s view "picked" picks rows of an answer and has no operation to answer.',
      'U\'s view "added" needs an operation and the slot it is at, both or neither.',
    ],
  );
});

test("what a capability holds with these answers is checked: what its views show, and how much", () => {
  const surface = (name: string) => ({ surface: name, protocol: "stand-in@1" });
  const many = Array.from({ length: 16 }, (_, i) => surface(`s${i}`));
  const desk = {
    id: "desk",
    title: "Desk",
    description: "",
    capability: { id: "desk", title: "Desk" },
    needs: [],
    gives: {
      slots: [{ name: "desk" }],
      skills: [],
      results: [],
      surfaces: many,
      views: [
        { id: "glow", place: "column", kind: "meters", surface: "lamp" },
        { id: "about", place: "column", kind: "facts", operation: "about", slot: "elsewhere" },
      ],
    },
    form: [
      {
        id: "lamp",
        type: "toggle",
        value: "boolean",
        title: "Lamp",
        adds: { slots: [], skills: [], surfaces: [surface("lamp")] },
      },
    ],
  } as never;
  // The description is within its bounds; an answer's additions take it past what one holds.
  assert.deepEqual(givesProblems(desk), []);
  assert.deepEqual(heldProblems(desk, workedOut(desk, {})), [
    "Desk's view \"glow\" shows a surface it doesn't give: lamp.",
    "Desk's view \"about\" is at a slot it doesn't give: elsewhere.",
  ]);
  assert.deepEqual(heldProblems(desk, workedOut(desk, { lamp: true })), [
    "Desk gives more than 16 surfaces.",
    "Desk's view \"about\" is at a slot it doesn't give: elsewhere.",
  ]);
});
