// What a stack comes to, worked out from form descriptions alone.
import assert from "node:assert/strict";
import test from "node:test";
import {
  answersOf,
  type CatalogUnit,
  type Draft,
  type Field,
  givesOf,
  isReady,
  isShown,
  offeredName,
  placeholderOf,
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

test("an agent or a template has to be named", () => {
  assert.equal(isReady({ ...draftOf({ access: "none" }), name: " " }), false);
  // An agent is ready with the name it is offered; a template isn't.
  assert.equal(isReady({ ...draftOf({ access: "none" }), name: " " }, "Scout"), true);
  assert.equal(
    isReady({ ...draftOf({ access: "none" }), mode: "template", name: " " }, "Scout"),
    false,
  );
  assert.equal(isReady({ ...draftOf({ access: "none" }), name: "Mine" }), true);
  assert.equal(isReady({ ...draftOf({ access: "none" }), mode: "template", name: "" }), false);
});

test("{name} in greyed text is the agent's name, and stays as written with no agent", () => {
  const field = { ...(form[2] as Field), placeholder: "~/Agents/{name}/{name}" };
  assert.equal(placeholderOf(field, "Wren"), "~/Agents/Wren/Wren");
  assert.equal(placeholderOf(field, undefined), "~/Agents/{name}/{name}");
  assert.equal(placeholderOf(form[2] as Field, "Wren"), undefined);
});

test("an agent is offered the first of the names that no agent has, and none once all are taken", () => {
  assert.equal(offeredName([]), "Scout");
  assert.equal(offeredName(["Scout", "Wren"]), "Juniper");
  assert.equal(offeredName(["scout"]), "Wren", "a name in another case is the same name");
  assert.equal(offeredName(["Scout", "Wren", "Juniper", "Cedar", "Maple", "Sage"]), "");
});

test("a unit's answers are read with their questions, and a secret or a hidden field is never read back", () => {
  const asked: Field[] = [
    {
      id: "where",
      type: "choice",
      value: "string",
      title: "Where it resides",
      options: [{ value: "local", title: "This computer" }],
    },
    { id: "folder", type: "directory", value: "string", title: "Workspace directory" },
    { id: "browser", type: "toggle", value: "boolean", title: "With a browser", default: false },
    { id: "limit", type: "number", value: "number", title: "How many at once", unit: "agents" },
    {
      id: "places",
      type: "choices",
      value: "strings",
      title: "Where new agents go",
      options: [{ value: "own", title: "Its own computer" }],
    },
    { id: "via", type: "connection", value: "string", title: "Connection" },
    { id: "token", type: "secret", value: "secret", title: "Token" },
    {
      id: "address",
      type: "text",
      value: "string",
      title: "Address",
      visible: { field: "where", in: ["remote"] },
    },
  ];
  const values = {
    where: "local",
    folder: "/work/scout",
    limit: 3,
    places: ["own", "remote"],
    via: "c-github",
    token: "kept apart",
    address: "build.example.com",
  };
  const named = (id: string) => (id === "c-github" ? "GitHub acme" : undefined);
  assert.deepEqual(
    answersOf(values, asked, named).map(({ question, answer }) => [question, answer]),
    [
      ["Where it resides", "This computer"],
      ["Workspace directory", "/work/scout"],
      ["With a browser", "Off"],
      ["How many at once", "3 agents"],
      ["Where new agents go", "Its own computer, remote"],
      ["Connection", "GitHub acme"],
    ],
  );
  assert.deepEqual(
    answersOf(values, asked)
      .filter((a) => a.path)
      .map((a) => a.id),
    ["folder"],
  );
  assert.equal(answersOf(values, asked).find((a) => a.id === "via")?.answer, "c-github");
});
