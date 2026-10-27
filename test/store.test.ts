import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { databasePath, home } from "../src/home.ts";
import { Store, TABLES } from "../src/store/index.ts";

const directory = mkdtempSync(join(tmpdir(), "agentorg-store-"));
after(() => rmSync(directory, { recursive: true, force: true }));
let count = 0;
const open = () => new Store(join(directory, `${++count}.db`));

const T0 = "2026-01-01T00:00:00.000Z";
const agent = (changes: Record<string, unknown> = {}) => ({
  id: "agt_1",
  title: "Migrate storage",
  purpose: "Move sessions to SQLite.",
  manager: null,
  created_by: "ses_0",
  created_at_attach: false,
  state: "pending" as const,
  status: null,
  created_at: T0,
  closed_at: null,
  ...changes,
});
const session = (changes: Record<string, unknown> = {}) => ({
  id: "ses_1",
  agent: "agt_1",
  client: "codex",
  client_session_id: "c-1",
  machine: "laptop",
  attached_at: T0,
  detached_at: null,
  ...changes,
});

test("the database is in WAL mode with foreign keys on", () => {
  const store = open();
  assert.equal(store.all("PRAGMA journal_mode")[0]?.journal_mode, "wal");
  assert.equal(store.all("PRAGMA foreign_keys")[0]?.foreign_keys, 1);
  store.close();
});

test("every table has a column per field of its record", () => {
  const store = open();
  for (const [table, schema] of Object.entries(TABLES)) {
    const columns = store.all(`PRAGMA table_info(${table})`).map((column) => column.name);
    assert.deepEqual(columns, Object.keys(schema.shape), table);
  }
  store.close();
});

test("records with nested fields, booleans and quoted columns come back unchanged", () => {
  const store = open();
  const status = {
    state: "running",
    summary: "Halfway.\nOn track.",
    links: [],
    blockers: [],
    updated_at: T0,
  };
  const record = agent({ created_at_attach: true, status });
  store.insert("agents", record);
  assert.deepEqual(store.get("agents", "agt_1"), record);
  store.insert("agents", agent({ id: "agt_2", manager: "agt_1" }));
  const message = {
    id: "msg_1",
    from: "agt_2",
    to: "agt_1",
    kind: "report" as const,
    body: "Done.",
    evidence: [],
    sent_at: T0,
    read_at: null,
    acknowledged_at: null,
  };
  store.insert("messages", message);
  store.update("messages", { ...message, read_at: T0 });
  assert.deepEqual(store.select("messages", `"to" = ?`, ["agt_1"]), [{ ...message, read_at: T0 }]);
  assert.equal(store.get("agents", "agt_9"), undefined);
  store.close();
});

test("a reference to a missing record and a second attached session are refused", () => {
  const store = open();
  assert.throws(() => store.insert("agents", agent({ manager: "agt_404" })), /FOREIGN KEY/);
  store.insert("agents", agent());
  store.insert("sessions", session());
  assert.throws(
    () => store.insert("sessions", session({ id: "ses_2", client_session_id: "c-2" })),
    /UNIQUE/,
  );
  store.insert("sessions", session({ id: "ses_3", client_session_id: "c-3", detached_at: T0 }));
  store.close();
});

test("a failed transaction leaves nothing", () => {
  const store = open();
  assert.throws(() =>
    store.transaction(() => {
      store.insert("agents", agent());
      throw new Error("stop");
    }),
  );
  assert.deepEqual(store.select("agents"), []);
  store.close();
});

test("select orders and limits, and count counts", () => {
  const store = open();
  for (const n of [1, 2, 3]) store.insert("agents", agent({ id: `agt_${n}` }));
  assert.deepEqual(
    store.select("agents", "1", [], "rowid DESC", 2).map((record) => record.id),
    ["agt_3", "agt_2"],
  );
  assert.equal(store.count("agents", "id != ?", ["agt_1"]), 2);
  store.close();
});

test("reopening keeps the record, and a newer schema is refused", () => {
  const path = join(directory, "reopen.db");
  const first = new Store(path);
  first.insert("agents", agent());
  first.close();
  const second = new Store(path);
  assert.ok(second.get("agents", "agt_1"));
  second.run("PRAGMA user_version = 99");
  second.close();
  assert.throws(() => new Store(path), /schema 99/);
});

test("the home is overridable", () => {
  const saved = process.env.AGENTORG_HOME;
  delete process.env.AGENTORG_HOME;
  assert.equal(home(), join(homedir(), ".local", "share", "agentorg"));
  process.env.AGENTORG_HOME = directory;
  assert.equal(databasePath(), join(directory, "agentorg.db"));
  if (saved === undefined) delete process.env.AGENTORG_HOME;
  else process.env.AGENTORG_HOME = saved;
});
