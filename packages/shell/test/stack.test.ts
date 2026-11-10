// What a stack comes to, worked out from form descriptions alone.
import assert from "node:assert/strict";
import test from "node:test";
import {
  type CatalogUnit,
  chosenNotes,
  type Draft,
  type Field,
  givesOf,
  isReady,
  isShown,
  nameOf,
  needsAttention,
  pickName,
  toStack,
} from "../src/fixed/stack.ts";

const adds = (slot: string, ...skills: string[]) => ({
  slots: [{ name: slot }],
  skills: skills.map((name) => ({ name, files: ["SKILL.md"] })),
});
const form: Field[] = [
  {
    id: "access",
    type: "choice",
    value: "string",
    title: "Access",
    options: [
      { value: "none", title: "None" },
      { value: "read", title: "Read", adds: adds("computer", "files") },
    ],
  },
  {
    id: "browser",
    type: "toggle",
    value: "boolean",
    title: "Browser",
    default: false,
    adds: adds("browser", "browser"),
  },
  {
    id: "dir",
    type: "directory",
    value: "string",
    title: "Folder",
    required: true,
    visible: { field: "access", in: ["read"] },
  },
  {
    id: "sub",
    type: "text",
    value: "string",
    title: "Below the folder",
    visible: { field: "dir", in: ["/x"] },
  },
  { id: "key", type: "secret", value: "secret", title: "Key" },
];
const unit: CatalogUnit = {
  provider: "p",
  providerName: "P",
  id: "computer",
  title: "Computer",
  description: "",
  needs: [],
  gives: { slots: [], skills: [{ name: "always", files: ["SKILL.md"] }], results: [] },
  form,
};
const base = {
  provider: "p",
  providerName: "P",
  id: "a",
  title: "A",
  description: "",
  instructions: "",
  asks: [],
  skills: [],
  mcp: [],
};
const draftOf = (values: Draft["units"][number]["values"], secrets = {}): Draft => ({
  mode: "agent",
  name: "N",
  suggested: "",
  purpose: "",
  base,
  answers: {},
  units: [{ key: 1, unit, id: "computer", values, secrets }],
  problems: [],
});

test("what a unit gives follows its answers", () => {
  assert.deepEqual(givesOf(unit, {}), { slots: [], skills: ["always"] });
  assert.deepEqual(givesOf(unit, { access: "read", browser: true }), {
    slots: ["computer", "browser"],
    skills: ["always", "files", "browser"],
  });
});

test("a field shows on another's value, and not when that other isn't shown", () => {
  const sub = form[3] as Field;
  assert.equal(isShown(form[2] as Field, form, { access: "none" }), false);
  assert.equal(isShown(sub, form, { access: "read", dir: "/x" }), true);
  assert.equal(isShown(sub, form, { access: "none", dir: "/x" }), false);
});

test("conditions in a circle hide the field instead of hanging", () => {
  const circle: Field[] = [
    { id: "a", type: "text", value: "string", title: "A", visible: { field: "b", in: ["x"] } },
    { id: "b", type: "text", value: "string", title: "B", visible: { field: "a", in: ["x"] } },
  ];
  assert.equal(isShown(circle[0] as Field, circle, { a: "x", b: "x" }), false);
});

test("a required field counts only while it's shown", () => {
  assert.equal(isReady(draftOf({ access: "read" })), false);
  assert.equal(isReady(draftOf({ access: "read", dir: "/x" })), true);
  assert.equal(isReady(draftOf({ access: "none" })), true);
});

test("the stack holds only what's shown and filled in, with secrets apart", () => {
  const stack = toStack(draftOf({ access: "none", dir: "/typed/earlier", sub: "" }, { key: "k" }));
  assert.deepEqual(stack.units, [
    { provider: "p", unit: "computer", values: { access: "none" }, secrets: { key: "k" } },
  ]);
});

test("what's chosen says what it means, for any unit, in the form's order", () => {
  const described: Field[] = [
    {
      id: "one",
      type: "choice",
      value: "string",
      title: "One",
      options: [
        { value: "a", title: "A", description: "First." },
        { value: "b", title: "B" },
      ],
    },
    {
      id: "many",
      type: "choices",
      value: "strings",
      title: "Many",
      options: [
        { value: "x", title: "X", description: "Second." },
        { value: "y", title: "Y", description: "Not this." },
      ],
    },
    {
      id: "gone",
      type: "choice",
      value: "string",
      title: "Gone",
      default: "z",
      visible: { field: "one", in: ["b"] },
      options: [{ value: "z", title: "Z", description: "Hidden." }],
    },
  ];
  assert.deepEqual(chosenNotes({ one: "a", many: ["x"] }, described), ["First.", "Second."]);
});

test("the name offered is one no agent has, and it's what an untouched field means", () => {
  const first = pickName([], () => 0);
  assert.notEqual(
    pickName([first], () => 0),
    first,
  );
  assert.deepEqual(
    [nameOf({ name: " ", suggested: "Wren" }), nameOf({ name: "Mine", suggested: "Wren" })],
    ["Wren", "Mine"],
  );
  assert.equal(isReady({ ...draftOf({ access: "none" }), name: "", suggested: "Wren" }), true);
  assert.equal(isReady({ ...draftOf({ access: "none" }), name: "", suggested: "" }), false);
});

test("a card asks for attention only when there's something on it to do", () => {
  const entry = (values: Draft["units"][number]["values"]) =>
    draftOf(values).units[0] as Draft["units"][number];
  assert.equal(needsAttention(entry({ access: "none" }), []), false);
  assert.equal(needsAttention(entry({ access: "read" }), []), true, "a required field is empty");
  assert.equal(needsAttention(entry({ access: "read", dir: "/x" }), []), false);
  assert.equal(needsAttention({ key: 1, id: "gone", values: {}, secrets: {} }, []), true);
});
