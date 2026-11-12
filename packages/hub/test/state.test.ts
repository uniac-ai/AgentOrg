import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { hubActors, hubAudit, hubBindings, hubGrants, tools } from "@agentorg/interfaces";
import { defineInterface, describeInterface, method, Refused } from "@agentorg/sdk";
import { z } from "zod";
import { HUB, HubState, PERSON, type StateEvents } from "../src/index.ts";

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
    ],
  );
  assert.deepEqual(
    state.bindings(PERSON).map((b) => `${b.slot}→${b.provider}.${b.export}`),
    [
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

  assert.deepEqual(state.bind(PERSON, wire(holder)), { bound: true }, "a manager holds both ends");
  // The provider offering itself, or a holder passing it on, is only the export side.
  assert.throws(() => state.bind(provider, wire(stranger)), refused("forbidden"));
  assert.throws(() => state.bind(holder, wire(third)), refused("forbidden"));
  // The consumer asking is only the slot side.
  assert.throws(() => state.bind(stranger, wire(stranger)), refused("forbidden"));
  assert.throws(() => state.bind(stranger, wire(holder)), refused("forbidden"), "neither end");
  assert.equal(state.binding(stranger, "notes"), undefined);
  // An Actor wiring its own slot to its own export holds both ends.
  assert.deepEqual(
    state.bind(third, { consumer: third, slot: "notes", provider: third, export: "notes" }),
    { bound: true },
  );
  state.unbind(third, third, "notes");
  assert.throws(() => state.createActor(stranger, { name: "x" }), refused("forbidden"));
  assert.throws(() => state.unbind(third, holder, "notes"), refused("forbidden"));
  // Delegation: binding hub.bindings@1 makes a manager, with no role flag.
  state.declareExternal(third, {
    slots: { notes: notes(), bindings: describeInterface(hubBindings) },
    exports: { notes: notes() },
  });
  state.bind(PERSON, { consumer: third, slot: "bindings", provider: HUB, export: "bindings" });
  assert.equal(state.isManager(third), true);
  assert.deepEqual(state.bind(third, wire(stranger)), { bound: true });
  state.unbind(third, stranger, "notes");
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

test("a holder of hub.grants can't pass it on by itself", (t) => {
  const { state } = open(t);
  const { holder, stranger } = cast(state);
  for (const id of [holder, stranger])
    state.declareExternal(id, {
      slots: { notes: notes(), grants: describeInterface(hubGrants) },
      exports: {},
    });
  state.bind(PERSON, { consumer: holder, slot: "grants", provider: HUB, export: "grants" });
  const wiring = { consumer: stranger, slot: "grants", provider: HUB, export: "grants" };
  assert.throws(() => state.bind(holder, wiring), refused("forbidden"));
  assert.equal(state.binding(stranger, "grants"), undefined);
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
  // A bound slot redeclared at another version of its interface keeps its binding, marked as
  // differing.
  state.declareExternal(holder, { slots: { notes: notes(9) }, exports: {} });
  assert.equal(state.binding(holder, "notes")?.mismatched, true);
  assert.throws(
    () =>
      state.declareExternal(holder, {
        slots: { forged: { ...notes(), hash: other.hash } },
        exports: {},
      }),
    refused("invalid"),
  );
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
  const slot = (name: "actors", iface: Parameters<typeof describeInterface>[0]) => {
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
  assert.equal(state.isManager(holder), false, "hub.actors@1 doesn't make a manager");
  assert.throws(
    () => state.bind(holder, { consumer: stranger, slot: "notes", provider: HUB, export: "audit" }),
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
});

test("an earlier home loses its records of storage, the network and the package store", (t) => {
  const home = mkdtempSync(join(tmpdir(), "agentorg-older-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  HubState.open(home).close();
  const db = new DatabaseSync(join(home, "hub.db"));
  const at = new Date().toISOString();
  const iface = JSON.stringify(notes());
  for (const id of ["storage", "net"])
    db.prepare(
      "INSERT INTO actors (id, name, package, state, created_at) VALUES (?, ?, 'builtin', 'running', ?)",
    ).run(id, id, at);
  db.prepare("INSERT INTO declarations VALUES ('storage', 'export', 'kv', ?, 0)").run(iface);
  db.prepare("INSERT INTO declarations VALUES ('hub', 'export', 'packages', ?, 0)").run(iface);
  db.prepare("INSERT INTO declarations VALUES ('person', 'slot', 'packages', ?, 0)").run(iface);
  db.prepare(
    "INSERT INTO bindings (consumer, slot, provider, export, interface, made_by, at) VALUES ('person', 'packages', 'hub', 'packages', 'hub.packages@1', 'hub', ?)",
  ).run(at);
  db.prepare(
    "INSERT INTO bindings (consumer, slot, provider, export, interface, made_by, at) VALUES ('person', 'old', 'storage', 'kv', 'kv@1', 'person', ?)",
  ).run(at);
  db.exec("PRAGMA user_version = 2");
  db.close();
  const state = HubState.open(home);
  t.after(() => state.close());
  assert.equal(state.actor("storage").state, "closed");
  assert.equal(state.actor("net").state, "closed");
  assert.deepEqual(
    state.bindings(PERSON).filter((b) => b.export === "packages" || b.provider === "storage"),
    [],
  );
  assert.equal(state.declaration("hub", "export", "packages"), undefined);
  assert.equal(state.declaration("person", "slot", "packages"), undefined);
});

test("a home from a newer version isn't opened", (t) => {
  const { home, state } = open(t);
  state.close();
  const db = new DatabaseSync(join(home, "hub.db"));
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.throws(() => HubState.open(home), /newer version/);
});

test("an update on either end keeps a binding: it differs until both ends declare the same, and an exposure follows its export", (t) => {
  const kinds: { kind: string; why?: unknown }[] = [];
  const { state } = open(t, {
    audited: (entry) => kinds.push({ kind: entry.kind, why: entry.details.why }),
  });
  const { provider, holder } = cast(state);
  const agent = state.createActor(PERSON, { name: "agent" }).actorId;
  state.declareExternal(agent, { slots: {}, exports: {} });
  state.bind(PERSON, { consumer: holder, slot: "notes", provider, export: "notes" });
  state.expose(PERSON, { provider, export: "notes", to: agent, as: "pad" });
  const wired = () =>
    state
      .bindings(provider)
      .map(
        (b) =>
          `${b.consumer === holder ? "holder" : "agent"} ${b.slot} ${b.interface}${b.mismatched ? " differs" : ""}`,
      )
      .sort();
  assert.deepEqual(wired(), ["agent pad notes@1", "holder notes notes@1"]);

  // The provider is updated first: both bindings are kept. The agent's slot was made by expose,
  // so it is the export's interface and takes the new one; the holder's declares the old.
  kinds.length = 0;
  state.declareExternal(provider, { slots: {}, exports: { notes: notes(2) } });
  assert.deepEqual(wired(), ["agent pad notes@1", "holder notes notes@1 differs"]);
  assert.equal(state.declaration(agent, "slot", "pad")?.iface.hash, notes(2).hash);
  assert.deepEqual(kinds, [
    { kind: "binding.keep", why: "its two ends declare different versions of its interface" },
    { kind: "binding.keep", why: "its slot follows its export" },
  ]);
  // Then the holder: the binding works again as it was, with nothing made anew.
  state.declareExternal(holder, { slots: { notes: notes(2) }, exports: {} });
  assert.deepEqual(wired(), ["agent pad notes@1", "holder notes notes@1"]);
  // Declared as another interface, the export no longer offers what was exposed: the exposure
  // goes, and can be made again. The holder's binding is kept, and whole once its slot declares
  // that interface too, under the slot's interface.
  kinds.length = 0;
  state.declareExternal(provider, { slots: {}, exports: { notes: other } });
  assert.deepEqual(wired(), ["holder notes notes@1 differs"]);
  assert.equal(state.declaration(agent, "slot", "pad"), undefined);
  assert.deepEqual(kinds, [
    { kind: "binding.keep", why: "its two ends declare different versions of its interface" },
    { kind: "binding.drop", why: "its export is another interface now" },
  ]);
  state.expose(PERSON, { provider, export: "notes", to: agent, as: "pad" });
  state.declareExternal(holder, { slots: { notes: other }, exports: {} });
  assert.deepEqual(wired(), ["agent pad other@1", "holder notes other@1"]);
  // A binding still goes when a name is no longer declared.
  state.declareExternal(holder, { slots: {}, exports: {} });
  assert.deepEqual(wired(), ["agent pad other@1"]);
});

test("one optional member added to tools@1 keeps an agent's exposed tools as they were, and its model kept until both ends declare the same", (t) => {
  const { state } = open(t);
  const make = (name: string) => state.createActor(PERSON, { name }).actorId;
  const [connection, model, agent] = [make("Fixture"), make("ChatGPT"), make("Elder")];
  const session = notes();
  state.declareExternal(connection, { slots: {}, exports: { tools: describeInterface(tools) } });
  state.declareExternal(model, { slots: {}, exports: { session } });
  state.declareExternal(agent, { slots: { model: session }, exports: {} });
  state.bind(PERSON, { consumer: agent, slot: "model", provider: model, export: "session" });
  state.expose(PERSON, { provider: connection, export: "tools", to: agent, as: "fixture" });
  const bound = () =>
    state
      .bindings(agent)
      .filter((b) => b.consumer === agent)
      .map(
        (b) =>
          `${b.slot} ${b.interface} ${b.provider} ${b.export}${b.mismatched ? " differs" : ""}`,
      )
      .sort();
  const before = bound();

  // As the upgrade trial did: a connection comes back declaring tools@1 with one optional member.
  const call = tools.methods.call;
  const newer = describeInterface(
    defineInterface({
      name: "tools",
      major: 1,
      kind: "rpc",
      methods: {
        ...tools.methods,
        call: method({
          input: (call.input as z.ZodObject).extend({ group: z.string().max(64).optional() }),
          output: call.output,
        }),
      },
      events: tools.events,
    }),
  );
  assert.notEqual(newer.hash, describeInterface(tools).hash);
  state.declareExternal(connection, { slots: {}, exports: { tools: newer } });
  assert.deepEqual(bound(), before, "its tools are kept, its slot taking the new version");
  assert.equal(state.declaration(agent, "slot", "fixture")?.iface.hash, newer.hash);
  // A change to its model's interface: kept while the two programs differ, whole once both are.
  state.declareExternal(model, { slots: {}, exports: { session: notes(3) } });
  assert.deepEqual(
    bound().find((line) => line.startsWith("model")),
    `model notes@1 ${model} session differs`,
  );
  state.declareExternal(agent, { slots: { model: notes(3) }, exports: {} });
  assert.deepEqual(bound(), before);
});

test("a new version of the Hub keeps a slot exposed from its exports, which follows it", (t) => {
  const { home, state } = open(t);
  const agent = state.createActor(PERSON, { name: "agent" }).actorId;
  state.declareExternal(agent, { slots: {}, exports: {} });
  const { slot } = state.expose(PERSON, { provider: HUB, export: "audit", to: agent });
  state.close();
  // As an earlier Hub declared it: the same interface, one method fewer.
  const earlier = describeInterface(
    defineInterface({
      name: "hub.audit",
      major: 1,
      kind: "rpc",
      methods: { list: hubAudit.methods.list },
    }),
  );
  const db = new DatabaseSync(join(home, "hub.db"));
  const set = db.prepare(
    "UPDATE declarations SET iface = ? WHERE actor = ? AND side = ? AND name = ?",
  );
  set.run(JSON.stringify(earlier), HUB, "export", "audit");
  set.run(JSON.stringify(earlier), agent, "slot", slot);
  db.close();
  const again = HubState.open(home);
  t.after(() => again.close());
  assert.equal(again.binding(agent, slot)?.mismatched, undefined);
  assert.equal(
    again.declaration(agent, "slot", slot)?.iface.hash,
    describeInterface(hubAudit).hash,
  );
});

test("the person keeps its hub bindings through redeclaration, and a restart repairs them", (t) => {
  const { home, state } = open(t);
  state.declareExternal(PERSON, { slots: { notes: notes() }, exports: {} });
  assert.equal(state.isManager(PERSON), true);
  assert.equal(state.bindings(PERSON).filter((b) => b.provider === HUB).length, 5);
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
    says("forbidden", named(stranger), named(provider), named(holder), "A manager can bind it"),
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
});
