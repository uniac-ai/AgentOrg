import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { z } from "zod";
import { errorBodyOf } from "../src/errors.ts";
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
  normalizeSchema,
  OutcomeUnknown,
  Refused,
  sha256,
} from "../src/index.ts";

const BOARD_HASH = "sha256-b854931fbb0f9b7d2dc42b545e4039fe4d0cef89d535b9403c66c543bca16179";

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

test("sha256 is the standard digest, in plain JavaScript so it bundles anywhere", () => {
  assert.equal(sha256(""), `sha256-${createHash("sha256").update("").digest("hex")}`);
  for (const size of [1, 55, 56, 63, 64, 65, 1000]) {
    const bytes = new Uint8Array(size).map((_, i) => (i * 31 + size) & 255);
    assert.equal(sha256(bytes), `sha256-${createHash("sha256").update(bytes).digest("hex")}`);
  }
});

test("canonical JSON sorts keys at every depth and keeps array order", () => {
  assert.equal(
    canonicalJson({ b: [3, { y: 1, x: "a" }], a: null, c: undefined }),
    '{"a":null,"b":[3,{"x":"a","y":1}]}',
  );
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.throws(() => canonicalJson({ n: Number.NaN }), TypeError);
  assert.throws(() => canonicalJson({ f: () => {} }), TypeError);
  assert.throws(() => canonicalJson({ at: new Date(0) }), /Date instance/);
  assert.throws(() => canonicalJson(new Map()), /Map instance/);
  assert.equal(canonicalJson(Object.create(null)), "{}");
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
  assert.deepEqual(Object.keys(describeInterface(site)), ["id", "kind", "hash"]);
  assert.notEqual(described.hash, describeInterface({ ...shell, protocol: "raw" }).hash);
  assert.throws(
    () =>
      defineInterface({
        name: "shell",
        major: 1,
        kind: "stream",
        protocol: "",
        open: z.object({}),
      }),
    /names its protocol/,
  );
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

test("field order and zod's $defs numbering are not part of the contract", () => {
  const record = (fields: "pq" | "qp") =>
    describeInterface(
      defineInterface({
        name: "store",
        major: 1,
        kind: "rpc",
        methods: {
          put: method({
            input:
              fields === "pq"
                ? z.object({ p: z.json(), q: z.array(z.json()) })
                : z.object({ q: z.array(z.json()), p: z.json() }),
            output: z.object({}),
          }),
        },
      }),
    );
  assert.equal(record("pq").hash, record("qp").hash);
  const described = record("pq");
  assert.ok(described.kind === "rpc");
  const input = described.methods.put as { input: Record<string, unknown> };
  assert.equal(input.input.$schema, undefined);
  assert.deepEqual(input.input.required, ["p", "q"]);
  assert.deepEqual(Object.keys(input.input.$defs as object), ["d0", "d1"]);
  assert.deepEqual(normalizeSchema(input.input), input.input);
});

test("board@1's hash is pinned, so a change in zod's JSON Schema output fails here first", () => {
  assert.equal(describeInterface(board()).hash, BOARD_HASH);
});

test("a recorded hash is recomputed from the description, so an edited schema or hash is caught", () => {
  const { hash, ...description } = describeInterface(board());
  assert.equal(hashInterface(description), hash);
  assert.ok(description.kind === "rpc");
  const edited = structuredClone(description);
  const add = edited.methods.add;
  assert.ok(add);
  (add.input as { properties: { title: { minLength: number } } }).properties.title.minLength = 0;
  assert.notEqual(hashInterface(edited), hash);
  assert.notEqual(hashInterface({ ...description, id: "board@2" }), hash);
});

test("a slot and an export bind only with the same name@major and the same hash", () => {
  const ours = { id: "board@1", hash: describeInterface(board()).hash };
  assert.equal(compareInterfaces(ours, describeInterface(board())), "same");
  assert.equal(compareInterfaces(ours, describeInterface(board(z.string()))), "conflict");
  assert.equal(compareInterfaces(ours, { id: "board@2", hash: ours.hash }), "unrelated");
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
  assert.throws(
    () =>
      defineInterface({
        name: "board",
        major: 1,
        kind: "rpc",
        methods: { changed: method({ input: z.object({}), output: z.object({}) }) },
        events: { changed: event(z.object({})) },
      }),
    /both a method and an event/,
  );
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

test("an interface keeps each schema's own type, which module handles infer from", () => {
  const add: z.ZodObject<{ title: z.ZodString }> = board().methods.add.input;
  const changed: z.ZodObject<{ id: z.ZodString }> = board().events.changed.payload;
  assert.ok(add && changed);
});

test("the three errors carry what a caller needs", () => {
  const notConnected = new NotConnected("store");
  assert.equal(notConnected.name, "NotConnected");
  assert.equal(notConnected.target, "store");
  const refused = new Refused("invalid", "title is required");
  assert.equal(refused.name, "Refused");
  assert.equal(refused.code, "invalid");
  assert.equal(refused.message, "title is required");
  assert.ok(new OutcomeUnknown() instanceof Error);
});

test("an error from another copy of the SDK is the same error", () => {
  // A package's bundle and the runner each carry the SDK; an error crosses between them as is.
  const other = Object.assign(new Error("no such card"), {
    name: "Refused",
    code: "not_found",
    [Symbol.for("@agentorg/sdk/error")]: "Refused",
  });
  assert.ok(other instanceof Refused);
  assert.ok(!(other instanceof NotConnected));
  assert.deepEqual(errorBodyOf(other), {
    name: "Refused",
    message: "no such card",
    code: "not_found",
  });
  // An error that only shares the name is not one.
  assert.ok(!(Object.assign(new Error("x"), { name: "Refused" }) instanceof Refused));
  assert.ok(new Refused("quota", "full") instanceof Error);
  // A copy of an error's fields isn't the error, and a subclass is checked as a subclass.
  assert.ok(!({ ...new Refused("invalid", "x") } instanceof Refused));
  class QuotaRefused extends Refused {}
  assert.ok(new QuotaRefused("quota", "full") instanceof Refused);
  assert.ok(new QuotaRefused("quota", "full") instanceof QuotaRefused);
  assert.ok(!(new Refused("invalid", "x") instanceof QuotaRefused));
});
