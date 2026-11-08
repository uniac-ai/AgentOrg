import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hubActors, hubBindings, hubGrants, kv } from "@agentorg/interfaces";
import { defineInterface, describeInterface, method, Refused } from "@agentorg/sdk";
import { buildPackage, writeTar } from "@agentorg/sdk/build";
import { readTar } from "@agentorg/sdk/manifest";
import { z } from "zod";
import { HUB, HubState, PERSON, type RequestRecord, type StateEvents } from "../src/index.ts";

const notes = (min = 1) =>
  describeInterface(
    defineInterface({
      name: "notes",
      major: 1,
      kind: "rpc",
      methods: {
        write: method({ input: z.object({ text: z.string().min(min) }), output: z.object({}) }),
      },
    }),
  );
const other = describeInterface(
  defineInterface({
    name: "other",
    major: 1,
    kind: "rpc",
    methods: { ping: method({ input: z.object({}), output: z.object({}) }) },
  }),
);
const refused = (code: string) => (e: unknown) => e instanceof Refused && e.code === code;
const mode = (path: string) => statSync(path).mode & 0o777;

function open(t: test.TestContext, events: StateEvents = {}) {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-hub-")), "home");
  t.after(() => rmSync(dirname(home), { recursive: true, force: true }));
  const state = HubState.open(home, events);
  t.after(() => state.close());
  return { home, state };
}

/** Three external Actors: a provider of notes@1, and two that could consume it. */
function cast(state: HubState) {
  const make = (name: string) => state.createActor(PERSON, { name }).actorId;
  const provider = make("provider");
  const holder = make("holder");
  const stranger = make("stranger");
  state.declareExternal(provider, { slots: {}, exports: { notes: notes() } });
  for (const id of [holder, stranger])
    state.declareExternal(id, { slots: { notes: notes() }, exports: {} });
  return { provider, holder, stranger };
}

test("first start creates the hub and the person, bound to every hub export, in a private home", async (t) => {
  const { home, state } = open(t);
  assert.deepEqual(
    state.actors().map((a) => [a.actorId, a.package, a.state]),
    [
      [HUB, "builtin", "running"],
      [PERSON, "external", "created"],
      ["storage", "builtin", "running"],
      ["net", "builtin", "running"],
    ],
  );
  assert.deepEqual(
    state.bindings(PERSON).map((b) => `${b.slot}→${b.provider}.${b.export}`),
    [
      "packages→hub.packages",
      "actors→hub.actors",
      "bindings→hub.bindings",
      "grants→hub.grants",
      "exports→hub.exports",
      "audit→hub.audit",
    ],
  );
  assert.equal(mode(home), 0o700);
  for (const file of ["hub.db", "hub.db-wal", "hub.db-shm"])
    assert.equal(mode(join(home, file)), 0o600);
  const credentialFile = join(home, "person-credential");
  assert.equal(mode(credentialFile), 0o600);
  const credential = readFileSync(credentialFile, "utf8").trim();
  assert.equal(state.authenticate(PERSON, credential), true);
  assert.equal(state.authenticate(PERSON, `${credential}x`), false);
  assert.equal(state.isManager(PERSON), true);
  state.close();
  const again = HubState.open(home);
  t.after(() => again.close());
  assert.equal(
    readFileSync(credentialFile, "utf8").trim(),
    credential,
    "a restart keeps the person",
  );
  assert.equal(again.audit().entries.filter((e) => e.kind === "bootstrap").length, 1);
});

test("an external Actor's credential is returned once and checked in constant time", (t) => {
  const { state } = open(t);
  const { actorId, credential } = state.createActor(PERSON, { name: "cli" });
  assert.ok(credential && credential.length >= 40);
  assert.equal(state.authenticate(actorId, credential), true);
  assert.equal(state.authenticate(actorId, "wrong"), false);
  assert.equal(state.authenticate("act_nobody", credential), false);
  state.closeActor(PERSON, actorId);
  assert.equal(state.authenticate(actorId, credential), false, "a closed Actor is out");
});

test("a binding needs both ends: each cell of the table", (t) => {
  const { state } = open(t);
  const { provider, holder, stranger } = cast(state);
  const third = state.createActor(PERSON, { name: "third" }).actorId;
  state.declareExternal(third, { slots: { notes: notes() }, exports: { notes: notes() } });
  const wire = (consumer: string) => ({ consumer, slot: "notes", provider, export: "notes" });
  const needs = (caller: string, consumer: string) => {
    const made = state.bind(caller, wire(consumer));
    if (made.bound) return "bound";
    return state.requests(PERSON).find((r) => r.requestId === made.requestId)?.needs;
  };

  assert.equal(needs(PERSON, holder), "bound", "a manager holds both ends");
  // The provider offering itself is only the export side: the consumer has to say yes.
  assert.equal(needs(provider, stranger), "slot");
  assert.deepEqual(
    state.requests(stranger).map((r) => r.requestedBy),
    [provider],
    "it goes to the consumer",
  );
  assert.deepEqual(state.requests(holder), [], "not to the export's holders");
  // An Actor wiring its own slot to its own export holds both ends.
  assert.deepEqual(
    state.bind(third, { consumer: third, slot: "notes", provider: third, export: "notes" }),
    {
      bound: true,
    },
  );
  state.unbind(third, third, "notes");
  // A holder passing it on is the export side too.
  assert.equal(needs(holder, third), "slot");
  // The consumer asking is only the slot side: the provider, holders and managers decide.
  const asked = state.bind(stranger, {
    consumer: stranger,
    slot: "notes",
    provider: third,
    export: "notes",
  });
  assert.equal(asked.bound, false);
  assert.equal(
    state.requests(PERSON).find((r) => !asked.bound && r.requestId === asked.requestId)?.needs,
    "export",
  );
  assert.deepEqual(
    state.bind(stranger, { consumer: stranger, slot: "notes", provider: third, export: "notes" }),
    asked,
    "asking again is the same request",
  );
  assert.throws(() => state.bind(stranger, wire(holder)), refused("forbidden"), "neither end");
  assert.throws(() => state.request(stranger, wire(holder), "x"), refused("forbidden"));
  assert.throws(() => state.request(PERSON, wire(holder), "x"), refused("state"), "both ends bind");

  // The other end's bind is the approval.
  assert.deepEqual(state.bind(stranger, wire(stranger)), { bound: true });
  assert.equal(state.binding(stranger, "notes")?.madeBy, stranger);
  assert.deepEqual(
    state.bind(third, wire(third)),
    { bound: true },
    "the holder's request, approved",
  );

  // A requester that lost its end can't be approved: the bind becomes a request of its own.
  const fourth = state.createActor(PERSON, { name: "fourth" }).actorId;
  state.declareExternal(fourth, { slots: { notes: notes() }, exports: {} });
  assert.equal(state.bind(holder, wire(fourth)).bound, false);
  state.unbind(holder, holder, "notes");
  const late = state.bind(fourth, wire(fourth));
  assert.equal(late.bound, false);
  assert.equal(state.binding(fourth, "notes"), undefined);

  assert.throws(() => state.createActor(stranger, { name: "x" }), refused("forbidden"));
  assert.throws(() => state.unbind(fourth, stranger, "notes"), refused("forbidden"));
  // Delegation: binding hub.bindings@1 makes a manager, with no role flag.
  state.declareExternal(fourth, {
    slots: { notes: notes(), bindings: describeInterface(hubBindings) },
    exports: {},
  });
  state.bind(PERSON, { consumer: fourth, slot: "bindings", provider: HUB, export: "bindings" });
  assert.equal(state.isManager(fourth), true);
  assert.deepEqual(state.bind(fourth, wire(fourth)), { bound: true });
  state.unbind(fourth, stranger, "notes");
});

test("create binds the new Actor's slots with the creator's export side, all or nothing", (t) => {
  const { state } = open(t);
  const { provider, holder } = cast(state);
  const grants = { slot: "grants", provider: HUB, export: "grants" };
  const { actorId } = state.createActor(PERSON, { name: "agent", bindings: [grants] });
  assert.equal(state.binding(actorId, "grants")?.madeBy, PERSON);
  assert.equal(state.declaration(actorId, "slot", "grants")?.iface.id, "hub.grants@1");

  // A creator that isn't a manager grants only what it holds.
  state.declareExternal(holder, {
    slots: { notes: notes(), actors: describeInterface(hubActors) },
    exports: {},
  });
  state.bind(PERSON, { consumer: holder, slot: "actors", provider: HUB, export: "actors" });
  state.bind(PERSON, { consumer: holder, slot: "notes", provider, export: "notes" });
  const before = state.actors().length;
  assert.throws(
    () => state.createActor(holder, { name: "greedy", bindings: [grants] }),
    refused("forbidden"),
  );
  assert.equal(state.actors().length, before, "nothing was created");
  const made = state.createActor(holder, {
    name: "helper",
    bindings: [{ slot: "notes", provider, export: "notes" }],
  });
  assert.equal(state.binding(made.actorId, "notes")?.provider, provider);
});

test("a holder of hub.grants passes it on only with the consumer's yes", (t) => {
  const { state } = open(t);
  const { holder, stranger } = cast(state);
  for (const id of [holder, stranger])
    state.declareExternal(id, {
      slots: { notes: notes(), grants: describeInterface(hubGrants) },
      exports: {},
    });
  state.bind(PERSON, { consumer: holder, slot: "grants", provider: HUB, export: "grants" });
  const wiring = { consumer: stranger, slot: "grants", provider: HUB, export: "grants" };
  const asked = state.bind(holder, wiring);
  assert.equal(asked.bound, false);
  assert.deepEqual(
    state.requests(stranger).map((r) => [r.requestedBy, r.needs]),
    [[holder, "slot"]],
  );
  assert.equal(state.binding(stranger, "grants"), undefined);
  assert.deepEqual(state.bind(stranger, wiring), { bound: true }, "the consumer says yes");
  assert.equal(state.binding(stranger, "grants")?.madeBy, stranger);
});

test("a request goes to exactly those who could grant it, and binding it is the approval", (t) => {
  const routed: [RequestRecord, string[]][] = [];
  const { state } = open(t, {
    requested: (request, approvers) => routed.push([request, approvers]),
  });
  const { provider, holder, stranger } = cast(state);
  state.bind(PERSON, { consumer: holder, slot: "notes", provider, export: "notes" });
  const wiring = { consumer: stranger, slot: "notes", provider, export: "notes" };
  const request = state.request(stranger, wiring, "to keep notes");
  assert.equal(request.needs, "export");
  assert.deepEqual(routed[0]?.[1].sort(), [holder, PERSON, provider].sort());
  for (const approver of [provider, holder, PERSON])
    assert.deepEqual(
      state.requests(approver).map((r) => r.requestId),
      [request.requestId],
    );
  assert.deepEqual(state.requests(stranger), [], "not the requester's to decide");
  assert.throws(() => state.decline(stranger, request.requestId), refused("unknown"));
  state.bind(holder, wiring);
  assert.deepEqual(state.requests(PERSON), [], "approved by binding");

  state.unbind(PERSON, stranger, "notes");
  const second = state.request(stranger, wiring, "again");
  state.decline(provider, second.requestId);
  assert.deepEqual(state.requests(holder), []);
});

test("a slot binds only an export of the same interface and schemas, once", (t) => {
  const { state } = open(t);
  const { provider, holder } = cast(state);
  const odd = state.createActor(PERSON, { name: "odd" }).actorId;
  state.declareExternal(odd, { slots: { notes: notes(5), other }, exports: {} });
  assert.throws(
    () => state.bind(PERSON, { consumer: odd, slot: "notes", provider, export: "notes" }),
    (e: Refused) => e.code === "conflict" && /schemas differ/.test(e.message),
  );
  assert.throws(
    () => state.bind(PERSON, { consumer: odd, slot: "other", provider, export: "notes" }),
    (e: Refused) => e.code === "conflict" && /takes other@1/.test(e.message),
  );
  assert.throws(
    () => state.bind(PERSON, { consumer: odd, slot: "nope", provider, export: "notes" }),
    refused("unknown"),
  );
  state.bind(PERSON, { consumer: holder, slot: "notes", provider, export: "notes" });
  assert.throws(
    () => state.bind(PERSON, { consumer: holder, slot: "notes", provider, export: "notes" }),
    refused("bound"),
  );
  // A bound slot can't change its interface underneath.
  assert.throws(
    () => state.declareExternal(holder, { slots: { notes: notes(9) }, exports: {} }),
    refused("conflict"),
  );
  assert.throws(
    () =>
      state.declareExternal(holder, {
        slots: { forged: { ...notes(), hash: other.hash } },
        exports: {},
      }),
    refused("invalid"),
  );
});

test("exports offered at run time list as dynamic; withdrawing one ends its bindings", (t) => {
  const changed: string[] = [];
  const { state } = open(t, { exportsChanged: (actor) => changed.push(actor) });
  const { provider, holder } = cast(state);
  state.offer(provider, "extra", notes());
  assert.deepEqual(
    state.exports(provider).map((e) => [e.export, e.dynamic]),
    [
      ["extra", true],
      ["notes", false],
    ],
  );
  state.bind(PERSON, { consumer: holder, slot: "notes", provider, export: "extra" });
  state.withdraw(provider, "extra");
  assert.equal(state.binding(holder, "notes"), undefined);
  assert.ok(changed.includes(provider));
  assert.throws(() => state.offer(provider, "notes", notes()), refused("conflict"));
});

test("packages are verified, stored privately, and give their Actor its slots, exports and wiring", async (t) => {
  const { home, state } = open(t);
  const board = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "examples",
    "board",
  );
  const out = mkdtempSync(join(tmpdir(), "board-for-hub-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const built = await buildPackage(board, { out });
  const added = state.addPackage(PERSON, built.file);
  assert.equal(added.hash, built.hash);
  assert.equal(mode(join(home, "packages", built.hash, "agentorg.json")), 0o600);
  assert.equal(mode(join(home, "packages", built.hash)), 0o700);
  assert.deepEqual(
    state.addPackage(PERSON, built.file).hash,
    built.hash,
    "adding again is a no-op",
  );
  assert.deepEqual(state.packages(), [{ hash: built.hash, name: "board", version: "0.1.0" }]);

  const store = state.createActor(PERSON, { name: "store" }).actorId;
  state.declareExternal(store, { slots: {}, exports: { kv: describeInterface(kv) } });
  const wired = state.createActor(PERSON, {
    name: "board-with-store",
    package: built.hash,
    bindings: [{ slot: "logic.store", provider: store, export: "kv" }],
  }).actorId;
  assert.equal(
    state.binding(wired, "logic.store")?.madeBy,
    PERSON,
    "initial bindings on a package",
  );
  state.closeActor(PERSON, wired);
  const { actorId } = state.createActor(PERSON, { name: "board", package: built.hash });
  assert.equal(state.declaration(actorId, "slot", "logic.store")?.iface.id, "kv@1");
  assert.equal(state.declaration(actorId, "export", "logic.board")?.iface.id, "board@1");
  assert.equal(
    state.binding(actorId, "panel.board")?.export,
    "logic.board",
    "the package's own wiring",
  );
  assert.throws(() => state.removePackage(PERSON, built.hash), refused("in_use"));
  state.start(PERSON, actorId);
  assert.throws(() => state.start(PERSON, actorId), refused("state"));
  state.stop(PERSON, actorId);
  state.closeActor(PERSON, actorId);
  assert.deepEqual(state.bindings(actorId), [], "closing ends its bindings both ways");
  state.removePackage(PERSON, built.hash);

  const files = readTar(new Uint8Array(readFileSync(built.file)));
  files.set("dist/logic.js", new TextEncoder().encode("tampered"));
  const tampered = join(out, `${built.hash}.agentorg`);
  writeFileSync(tampered, writeTar(files));
  assert.throws(() => state.addPackage(PERSON, tampered), refused("invalid"));
  assert.throws(() => state.addPackage(PERSON, join(out, "missing.agentorg")), refused("unknown"));
  assert.throws(() => state.start(PERSON, PERSON), refused("state"));
});

test("the audit trail records every change, in order, and pages", (t) => {
  const seen: string[] = [];
  const { state } = open(t, { audited: (entry) => seen.push(entry.kind) });
  const { provider, holder } = cast(state);
  const wiring = { consumer: holder, slot: "notes", provider, export: "notes" };
  state.bind(PERSON, wiring);
  state.auditCall(holder, wiring, { op: "call", method: "write", outcome: "ok" });
  state.unbind(holder, holder, "notes");
  const kinds = state.audit(0, 1000).entries.map((e) => e.kind);
  assert.deepEqual(kinds.slice(-6), [
    "actor.create",
    "actor.create",
    "actor.create",
    "bind",
    "call",
    "unbind",
  ]);
  assert.deepEqual(seen.slice(-6), [
    "actor.create",
    "actor.create",
    "actor.create",
    "bind",
    "call",
    "unbind",
  ]);
  const first = state.audit(0, 2);
  assert.equal(first.entries.length, 2);
  assert.equal(state.audit(first.next, 1000).entries[0]?.seq, (first.entries[1]?.seq ?? 0) + 1);
  assert.deepEqual(state.audit(0, 1000).entries.find((e) => e.kind === "call")?.details, {
    ...wiring,
    op: "call",
    method: "write",
    outcome: "ok",
  });
});

test("each hub export is the authority for its own part only", (t) => {
  const { state } = open(t);
  const { holder, stranger } = cast(state);
  const slot = (name: "actors" | "packages", iface: Parameters<typeof describeInterface>[0]) => {
    state.declareExternal(holder, {
      slots: { notes: notes(), [name]: describeInterface(iface) },
      exports: {},
    });
    state.bind(PERSON, { consumer: holder, slot: name, provider: HUB, export: name });
  };
  slot("actors", hubActors);
  assert.ok(state.holds(holder, "actors"));
  const made = state.createActor(holder, { name: "by-holder" }).actorId;
  state.closeActor(holder, made);
  assert.throws(() => state.addPackage(holder, "/nowhere.agentorg"), refused("forbidden"));
  assert.throws(
    () => state.removePackage(holder, `sha256-${"0".repeat(64)}`),
    refused("forbidden"),
  );
  assert.equal(state.isManager(holder), false, "hub.actors@1 doesn't make a manager");
  assert.throws(
    () =>
      state.bind(holder, { consumer: stranger, slot: "notes", provider: HUB, export: "packages" }),
    refused("forbidden"),
    "it passes on only what it holds",
  );
  assert.throws(() => state.closeActor(PERSON, PERSON), refused("forbidden"));
  assert.throws(() => state.closeActor(PERSON, HUB), refused("forbidden"));
});

test("the person's hub bindings can't be removed, so the Hub always has a manager", (t) => {
  const { state } = open(t);
  const { stranger } = cast(state);
  state.declareExternal(stranger, {
    slots: { bindings: describeInterface(hubBindings) },
    exports: {},
  });
  state.bind(PERSON, { consumer: stranger, slot: "bindings", provider: HUB, export: "bindings" });
  for (const caller of [stranger, PERSON])
    for (const slot of ["bindings", "actors"])
      assert.throws(
        () => state.unbind(caller, PERSON, slot),
        refused("forbidden"),
        `${caller} ${slot}`,
      );
  state.unbind(stranger, stranger, "bindings"); // a delegate can step down
  assert.equal(state.isManager(PERSON), true);
});

test("a request: once per wiring, never for a bound slot, seen by approvers only, closed with its ends", (t) => {
  const decided: [string, string, string[]][] = [];
  const { state } = open(t, {
    decided: (request, status, approvers) => decided.push([request.requestId, status, approvers]),
  });
  const { provider, holder, stranger } = cast(state);
  const fourth = state.createActor(PERSON, { name: "fourth" }).actorId;
  state.declareExternal(fourth, { slots: {}, exports: {} });
  // A delegated manager is an approver like the person.
  state.declareExternal(fourth, {
    slots: { bindings: describeInterface(hubBindings) },
    exports: {},
  });
  const wiring = { consumer: stranger, slot: "notes", provider, export: "notes" };
  const first = state.request(stranger, wiring, "one");
  assert.equal(state.request(stranger, wiring, "two").requestId, first.requestId, "deduplicated");
  assert.deepEqual(state.requests(fourth), [], "an unrelated Actor sees nothing");
  assert.deepEqual(state.requests(holder), [], "nor does a would-be consumer of the same export");
  state.bind(PERSON, { consumer: fourth, slot: "bindings", provider: HUB, export: "bindings" });
  assert.deepEqual(
    state.requests(fourth).map((r) => r.requestId),
    [first.requestId],
  );
  state.bind(PERSON, { consumer: holder, slot: "notes", provider, export: "notes" });
  assert.throws(
    () =>
      state.request(provider, { consumer: holder, slot: "notes", provider, export: "notes" }, "x"),
    refused("bound"),
  );
  state.closeActor(PERSON, provider);
  assert.deepEqual(state.requests(PERSON), []);
  assert.deepEqual(
    decided.map(([id, status]) => [id, status]),
    [[first.requestId, "closed"]],
  );
});

test("events go out after the change commits, never for one that rolled back", (t) => {
  const log: string[] = [];
  let fail = false;
  const { state } = open(t, {
    bound: (b) => log.push(`bound ${b.consumer}.${b.slot}`),
    unbound: (bs) => log.push(`unbound ${bs.map((b) => `${b.consumer}.${b.slot}`).join(",")}`),
    audited: (entry) => {
      log.push(`audit ${entry.kind}`);
      if (fail) throw new Error("listener broke");
    },
  });
  const { provider, holder, stranger } = cast(state);
  const odd = state.createActor(PERSON, { name: "odd" }).actorId;
  state.declareExternal(odd, { slots: {}, exports: {} });
  log.length = 0;
  // The second name is refused after the first was written: all of it rolls back, silently.
  assert.throws(
    () => state.declareExternal(odd, { slots: { good: notes(), Bad: notes() }, exports: {} }),
    refused("invalid"),
  );
  assert.equal(state.declaration(odd, "slot", "good"), undefined);
  assert.deepEqual(log, []);

  fail = true;
  state.bind(PERSON, { consumer: holder, slot: "notes", provider, export: "notes" });
  assert.ok(state.binding(holder, "notes"), "a listener's failure doesn't undo the change");
  fail = false;
  state.bind(PERSON, { consumer: stranger, slot: "notes", provider, export: "notes" });
  log.length = 0;
  // Redeclaring without the export drops it, and both bindings to it.
  state.declareExternal(provider, { slots: {}, exports: {} });
  assert.deepEqual(log, [`unbound ${holder}.notes,${stranger}.notes`]);
  assert.deepEqual(state.exports(provider), []);
  const seq = state.audit(0, 1000).next;
  state.offer(provider, "extra", notes());
  assert.equal(state.audit(0, 1000).next, seq + 1, "audit seqs stay contiguous");
});

test("run-time exports: only they can be withdrawn, and they go when the Actor disconnects", (t) => {
  const { state } = open(t);
  const { provider, holder } = cast(state);
  assert.throws(() => state.withdraw(provider, "notes"), refused("unknown"), "static");
  assert.throws(() => state.withdraw(provider, "never"), refused("unknown"));
  state.offer(provider, "extra", notes());
  state.bind(PERSON, { consumer: holder, slot: "notes", provider, export: "extra" });
  assert.equal(state.resolveCall(holder, "notes")?.target.name, "extra");
  state.disconnected(provider);
  assert.equal(state.binding(holder, "notes"), undefined);
  assert.equal(state.resolveCall(holder, "notes"), undefined);
  assert.deepEqual(
    state.exports(provider).map((e) => e.export),
    ["notes"],
  );
  state.closeActor(PERSON, holder);
  assert.throws(() => state.offer(holder, "late", notes()), refused("state"));
  assert.throws(() => state.offer("act_nobody", "late", notes()), refused("unknown"));
});

test("a home from a newer version isn't opened", (t) => {
  const { home, state } = open(t);
  state.close();
  const db = new DatabaseSync(join(home, "hub.db"));
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.throws(() => HubState.open(home), /newer version/);
});

test("the person keeps its hub bindings through redeclaration, and a restart repairs them", (t) => {
  const { home, state } = open(t);
  state.declareExternal(PERSON, { slots: { notes: notes() }, exports: {} });
  assert.equal(state.isManager(PERSON), true);
  assert.equal(state.bindings(PERSON).filter((b) => b.provider === HUB).length, 6);
  state.close();
  // However it came to be, a hub slot wired elsewhere is put back on the hub at the next start.
  const db = new DatabaseSync(join(home, "hub.db"));
  db.prepare(
    "UPDATE bindings SET provider = 'act_elsewhere' WHERE consumer = ? AND slot = 'bindings'",
  ).run(PERSON);
  db.close();
  const again = HubState.open(home);
  t.after(() => again.close());
  assert.equal(again.binding(PERSON, "bindings")?.provider, HUB);
});

test("a transaction that can't begin leaves the state usable", (t) => {
  const kinds: string[] = [];
  const { home, state } = open(t, { audited: (e) => kinds.push(e.kind) });
  const other = new DatabaseSync(join(home, "hub.db"));
  other.exec("BEGIN IMMEDIATE");
  assert.throws(() => state.createActor(PERSON, { name: "blocked" }), /locked/);
  other.exec("ROLLBACK");
  other.close();
  state.createActor(PERSON, { name: "after" });
  assert.equal(kinds.at(-1), "actor.create", "events flow again");
  assert.throws(
    () => state.declareExternal(PERSON, { slots: { ok: notes(), Bad: notes() }, exports: {} }),
    refused("invalid"),
  );
  assert.equal(state.declaration(PERSON, "slot", "ok"), undefined, "and transactions roll back");
});

test("a decision reaches every approver its request went to, and binding a slot settles all its requests", (t) => {
  const routed = new Map<string, string[]>();
  const decided = new Map<string, [string, string[]]>();
  const { state } = open(t, {
    requested: (r, approvers) => routed.set(r.requestId, approvers.sort()),
    decided: (r, status, approvers) => decided.set(r.requestId, [status, approvers.sort()]),
  });
  const { provider, holder, stranger } = cast(state);
  const second = state.createActor(PERSON, { name: "second" }).actorId;
  state.declareExternal(second, { slots: {}, exports: { notes: notes() } });
  state.bind(PERSON, { consumer: holder, slot: "notes", provider, export: "notes" });
  const one = state.request(
    stranger,
    { consumer: stranger, slot: "notes", provider, export: "notes" },
    "a",
  );
  state.declareExternal(provider, { slots: {}, exports: {} });
  const withRequester = (id: string) => [...(routed.get(id) ?? []), stranger].sort();
  assert.deepEqual(decided.get(one.requestId), ["closed", withRequester(one.requestId)]);

  const wiring = { consumer: stranger, slot: "notes", provider: second, export: "notes" };
  const two = state.request(stranger, wiring, "b");
  state.declareExternal(provider, { slots: {}, exports: { notes: notes() } });
  const three = state.request(stranger, { ...wiring, provider }, "c");
  state.bind(second, wiring);
  assert.equal(decided.get(two.requestId)?.[0], "approved");
  assert.deepEqual(
    decided.get(two.requestId)?.[1],
    withRequester(two.requestId),
    "the approvers it went to, and its requester",
  );
  assert.equal(decided.get(three.requestId)?.[0], "closed");
  assert.deepEqual(state.requests(provider), []);
});

test("the consumer declines an offer, and the decision reaches the approvers the offer went to", (t) => {
  const decided: [string, string[]][] = [];
  const { state } = open(t, {
    decided: (_, status, approvers) => decided.push([status, approvers]),
  });
  const { provider, stranger } = cast(state);
  const offer = state.bind(provider, {
    consumer: stranger,
    slot: "notes",
    provider,
    export: "notes",
  });
  assert.ok(!offer.bound);
  state.decline(stranger, offer.requestId);
  assert.deepEqual(decided, [["declined", [stranger, PERSON, provider]]], "and to the requester");
  assert.deepEqual(
    state.mine(provider).map((r) => [r.requestId, r.status]),
    [[offer.requestId, "declined"]],
    "which can read it later too",
  );
  assert.deepEqual(state.mine(stranger), []);
});

test("approvers are exactly the Actors that hold the side a request needs", (t) => {
  const { state } = open(t);
  const { provider, holder, stranger } = cast(state);
  state.bind(PERSON, { consumer: holder, slot: "notes", provider, export: "notes" });
  const everyone = state.actors().map((a) => a.actorId);
  const wiring = { consumer: stranger, slot: "notes", provider, export: "notes" };
  for (const needs of ["export", "slot"] as const)
    assert.deepEqual(
      state.approvers({ ...wiring, needs }).sort(),
      everyone.filter((a) => state.sides(a, wiring)[needs]).sort(),
      needs,
    );
});

test("a request closes when its requester loses the end it brought", (t) => {
  const decided: string[] = [];
  const { state } = open(t, { decided: (r, status) => decided.push(`${r.requestedBy}:${status}`) });
  const { provider, holder, stranger } = cast(state);
  state.bind(PERSON, { consumer: holder, slot: "notes", provider, export: "notes" });
  const wiring = { consumer: stranger, slot: "notes", provider, export: "notes" };
  const asked = state.bind(holder, wiring);
  assert.ok(!asked.bound);
  assert.throws(() => state.request(stranger, wiring, "x"), refused("state"), "bind to approve");
  state.unbind(holder, holder, "notes");
  assert.deepEqual(decided, [`${holder}:closed`]);
  assert.deepEqual(state.requests(stranger), []);
});

test("a refusal names Actors as Name (id) and says what the caller can do", (t) => {
  const { state } = open(t);
  const { provider, holder, stranger } = cast(state);
  const named = (id: string) => `${state.actor(id).name} (${id})`;
  const says =
    (code: string, ...parts: string[]) =>
    (e: unknown) =>
      e instanceof Refused && e.code === code && parts.every((part) => e.message.includes(part));
  const wiring = { consumer: holder, slot: "notes", provider, export: "notes" };
  assert.throws(
    () => state.bind(stranger, wiring),
    says("forbidden", named(stranger), named(provider), named(holder), "Ask one of them"),
  );
  state.bind(PERSON, wiring);
  assert.throws(
    () => state.unbind(stranger, holder, "notes"),
    says("forbidden", named(stranger), named(holder), "its consumer, its provider or a manager"),
  );
  assert.throws(() => state.actor("act_nobody"), says("unknown", "hub.actors.list"));
  assert.throws(
    () => state.bind(PERSON, { ...wiring, slot: "nope" }),
    says("unknown", named(holder), "hub.grants.expose"),
  );
  state.closeActor(PERSON, stranger);
  assert.throws(
    () => state.offer(stranger, "x", other),
    says("state", named(stranger), "make another"),
  );
});
