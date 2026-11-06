import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  canonicalJson,
  compareInterfaces,
  defineInterface,
  describeInterface,
  event,
  hashInterface,
  interfaceId,
  method,
  NotConnected,
  OutcomeUnknown,
  Refused,
} from "../src/index.ts";

/** The spec's board@1, built fresh each call so equal definitions are separate zod objects. */
const board = (title = z.string().min(1)) => {
  const Card = z.object({ id: z.string(), title: z.string(), done: z.boolean() });
  return defineInterface({
    name: "board",
    major: 1,
    kind: "rpc",
    methods: {
      list: method({ input: z.object({}), output: z.object({ cards: z.array(Card) }) }),
      add: method({ input: z.object({ title }), output: Card }),
    },
    events: { changed: event(z.object({ id: z.string() })) },
  });
};

test("canonical JSON sorts keys at every depth and keeps array order", () => {
  assert.equal(
    canonicalJson({ b: [3, { y: 1, x: "a" }], a: null, c: undefined }),
    '{"a":null,"b":[3,{"x":"a","y":1}]}',
  );
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.throws(() => canonicalJson({ n: Number.NaN }), TypeError);
  assert.throws(() => canonicalJson({ f: () => {} }), TypeError);
});

test("an rpc interface describes each method and event as JSON Schema", () => {
  const described = describeInterface(board());
  assert.equal(interfaceId(board()), "board@1");
  assert.equal(described.kind, "rpc");
  assert.ok(described.kind === "rpc");
  assert.deepEqual(Object.keys(described.methods).sort(), ["add", "list"]);
  const add = described.methods.add?.input as { properties: { title: { minLength: number } } };
  assert.equal(add.properties.title.minLength, 1);
  assert.deepEqual(Object.keys(described.events), ["changed"]);
  assert.match(described.hash, /^sha256-[0-9a-f]{64}$/);
});

test("stream and http interfaces name their protocol instead of method schemas", () => {
  const shell = defineInterface({
    name: "computer.shell",
    major: 1,
    kind: "stream",
    protocol: "pty",
    open: z.object({ cols: z.number(), rows: z.number() }),
  });
  const site = defineInterface({ name: "site", major: 1, kind: "http" });
  const described = describeInterface(shell);
  assert.ok(described.kind === "stream");
  assert.equal(described.protocol, "pty");
  assert.deepEqual(Object.keys((described.open as { properties: object }).properties), [
    "cols",
    "rows",
  ]);
  assert.deepEqual(Object.keys(describeInterface(site)), ["kind", "hash"]);
  assert.notEqual(describeInterface(site).hash, describeInterface({ ...site, major: 2 }).hash);
});

test("an interface's hash is stable across rebuilds and changes with any schema", () => {
  const first = describeInterface(board()).hash;
  assert.equal(describeInterface(board()).hash, first);
  // The definition's member order is not part of the contract.
  const reordered = board();
  assert.equal(
    describeInterface({
      ...reordered,
      methods: { add: reordered.methods.add, list: reordered.methods.list },
    }).hash,
    first,
  );
  assert.notEqual(describeInterface(board(z.string().min(2))).hash, first);
  const withEvent = board();
  assert.notEqual(
    describeInterface({
      ...withEvent,
      events: { ...withEvent.events, removed: event(z.object({})) },
    }).hash,
    first,
  );
});

test("a recorded hash is recomputed from the description, so an edited schema or hash is caught", () => {
  const { hash, ...description } = describeInterface(board());
  assert.equal(hashInterface("board@1", description), hash);
  assert.ok(description.kind === "rpc");
  const edited = structuredClone(description);
  const add = edited.methods.add;
  assert.ok(add);
  (add.input as { properties: { title: { minLength: number } } }).properties.title.minLength = 0;
  assert.notEqual(hashInterface("board@1", edited), hash);
});

test("a slot and an export bind only with the same name@major and the same hash", () => {
  const ours = { id: "board@1", hash: describeInterface(board()).hash };
  assert.equal(compareInterfaces(ours, { ...ours }), "same");
  assert.equal(
    compareInterfaces(ours, { id: "board@1", hash: describeInterface(board(z.string())).hash }),
    "mismatch",
  );
  assert.equal(compareInterfaces(ours, { id: "board@2", hash: ours.hash }), "different");
});

test("invalid names, majors and members are refused at definition", () => {
  const rpc =
    (name: string, major = 1, member = "list") =>
    () =>
      defineInterface({
        name,
        major,
        kind: "rpc",
        methods: { [member]: method({ input: z.object({}), output: z.object({}) }) },
      });
  assert.throws(rpc("Board"), /dotted lowercase/);
  assert.throws(rpc("board."), /dotted lowercase/);
  assert.throws(rpc("board", 0), /major/);
  assert.throws(rpc("board", 1.5), /major/);
  assert.throws(rpc("board", 1, "list-all"), /valid method or event name/);
  assert.doesNotThrow(rpc("llm.session"));
});

test("a schema with no JSON Schema form is refused when described, naming where", () => {
  const dated = defineInterface({
    name: "clock",
    major: 1,
    kind: "rpc",
    methods: { now: method({ input: z.object({}), output: z.date() }) },
  });
  assert.throws(() => describeInterface(dated), /clock@1 now output/);
});

test("the three errors carry what a caller needs", () => {
  const notConnected = new NotConnected("store");
  assert.equal(notConnected.name, "NotConnected");
  assert.equal(notConnected.slot, "store");
  const refused = new Refused("invalid", "title is required");
  assert.equal(refused.name, "Refused");
  assert.equal(refused.code, "invalid");
  assert.equal(refused.message, "title is required");
  assert.ok(new OutcomeUnknown() instanceof Error);
});
