/** Retire schema-7 Actor execution without losing identity, history or unrelated state. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openSqlite } from "@uniac/agentic-workspace/persistence";
import { organization } from "../src/domain/index.ts";
import { Database } from "../src/storage/sqlite/database.ts";
import { SqliteStore } from "../src/storage/sqlite/index.ts";
import { importLegacyMessages } from "../src/storage/sqlite/workspace-import.ts";

const at = "2026-10-30T00:00:00.000Z";
const invocation = () => ({ signal: new AbortController().signal, progress: async () => {} });

async function legacy() {
  const directory = mkdtempSync(join(tmpdir(), "agentorg-retire-"));
  const file = join(directory, "core.db");
  const db = new DatabaseSync(file);
  db.exec(readFileSync(new URL("../../test/fixtures/schema-7.sql", import.meta.url), "utf8"));
  db.exec("PRAGMA user_version = 7");
  const credential = "sentinel-root-credential";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
  const hash = Buffer.from(digest).toString("hex");
  const actor = db.prepare("INSERT INTO actors VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  actor.run("act_root", "root", "Root", null, hash, 1, at, null);
  actor.run("act_worker", "worker", "Worker", "act_root", "sentinel-worker-hash", 0, at, null);
  db.prepare("INSERT INTO exposures VALUES (?, ?)").run(
    "act_worker",
    JSON.stringify([
      { name: "control", input: { type: "object" }, one_way: false, long_running: false },
    ]),
  );
  const call = db.prepare("INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const [id, state, run] of [
    ["pending-offline", "pending", null],
    ["pending-running", "pending", "legacy-run"],
    ["completed", "done", "completed-run"],
    ["withdrawn", "withdrawn", null],
  ] as const) {
    call.run(
      id,
      "act_root",
      "act_worker",
      "control",
      '{"sentinel":"original-input"}',
      state,
      state === "done" ? '{"value":{"kept":true},"parts":[]}' : null,
      null,
      null,
      run,
      at,
      run ? at : null,
      state === "pending" ? null : at,
    );
  }
  db.prepare("INSERT INTO progress VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "act_worker",
    1,
    "waiting",
    "Kept",
    "[]",
    "[]",
    at,
  );
  db.prepare("INSERT INTO questions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "question",
    1,
    "act_worker",
    "act_root",
    "Kept question",
    "[]",
    "[]",
    null,
    null,
    null,
    null,
    at,
  );
  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "message",
    2,
    "act_root",
    "act_worker",
    "Kept private message",
    "[]",
    null,
    at,
    null,
  );
  db.prepare("INSERT INTO claims VALUES (?, ?, ?, ?, ?)").run(
    "fixture",
    "act_worker",
    "Kept claim",
    null,
    at,
  );
  db.prepare(
    "INSERT INTO audit (at, actor, operation, target, outcome) VALUES (?, ?, ?, ?, ?)",
  ).run(at, "act_root", "message_send", "message", "ok");
  const snapshot = Object.fromEntries(
    ["actors", "calls", "progress", "questions", "messages", "claims", "audit"].map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );
  db.close();
  chmodSync(file, 0o600);
  const config = join(directory, "providers.json");
  writeFileSync(config, '[{"providerId":"fixture","credentialHash":"sentinel-provider-hash"}]\n', {
    mode: 0o600,
  });
  return { directory, file, config, snapshot, credential };
}

test("schema7 retirement preserves records, fails pending calls once and exposes only Hub Tools", async (t) => {
  const fixture = await legacy();
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const config = readFileSync(fixture.config);
  let store = new SqliteStore(fixture.file);
  try {
    assert.equal(store.database.all("PRAGMA user_version")[0]?.user_version, 9);
    assert.deepEqual(
      store.database.all("SELECT name FROM sqlite_schema WHERE name='exposures'"),
      [],
    );
    assert.equal(
      store.database
        .all("PRAGMA table_info(actors)")
        .some((column) => column.name === "created_at_attach"),
      false,
    );
    for (const table of ["progress", "questions", "messages", "claims"]) {
      const retained = table === "claims" ? table : `legacy_${table}`;
      assert.deepEqual(
        store.database.all(`SELECT * FROM ${retained} ORDER BY rowid`),
        fixture.snapshot[table],
      );
    }
    const beforeActors = fixture.snapshot.actors as Record<string, unknown>[];
    assert.deepEqual(
      store.database.all("SELECT * FROM actors ORDER BY rowid").map((row) => ({ ...row })),
      beforeActors.map(({ created_at_attach: _, ...actor }) => actor),
    );
    for (const old of fixture.snapshot.calls as Record<string, unknown>[]) {
      const current = store.database.all("SELECT * FROM calls WHERE id=?", [String(old.id)])[0];
      assert.ok(current);
      if (old.state === "pending") {
        assert.equal(typeof current.settled_at, "string");
        assert.deepEqual(
          { ...current },
          {
            ...old,
            state: "failed",
            error: "Actor interface execution was retired",
            settled_at: current.settled_at,
          },
        );
      } else assert.deepEqual(current, old);
    }
    const audit = store.database.all("SELECT * FROM audit ORDER BY id");
    assert.deepEqual(audit[0], fixture.snapshot.audit?.[0]);
    assert.deepEqual(
      audit.slice(1).map((row) => [row.operation, row.target, row.outcome]),
      [
        ["call", "pending-offline", "failed"],
        ["call", "pending-running", "failed"],
      ],
    );
    const org = organization(store);
    assert.equal((await org.registry.byCredential(fixture.credential))?.id, "act_root");
    for (const actor of ["act_root", "act_worker"]) {
      assert.deepEqual(
        org.available(actor).map((tool) => tool.id),
        [
          "hub:actors",
          "hub:team",
          "hub:directory",
          "hub:messages",
          "hub:work",
          "hub:forms",
          "hub:claims",
          "hub:calls",
          "hub:activity",
        ],
      );
      assert.equal(org.available(actor).flatMap((tool) => tool.interfaces).length, 23);
      for (const alias of [
        "worker.control",
        "manager.control",
        "act_worker.control",
        "control",
        "call_withdraw",
      ]) {
        const answer = await org.invoke(actor, alias, {}, invocation());
        assert.equal(answer.state === "refused" && answer.code, "not_found");
      }
      const answer = await org.invoke(
        actor,
        "team",
        { actor: "act_root", depth: 10 },
        invocation(),
      );
      assert.ok(answer.state === "done");
      for (const position of (answer.value as { positions: object[] }).positions) {
        assert.equal("interfaces" in position || "created_at_attach" in position, false);
      }
    }
    const allowed = await org.invoke(
      "act_root",
      "call_result",
      { call: "pending-running" },
      invocation(),
    );
    assert.ok(allowed.state === "done");
    assert.equal((allowed.value as { state: string }).state, "failed");
    const denied = await org.invoke(
      "act_worker",
      "call_result",
      { call: "completed" },
      invocation(),
    );
    assert.equal(denied.state === "refused" && denied.code, "forbidden");
    assert.equal(store.database.all("SELECT count(*) AS n FROM calls")[0]?.n, 4);
    const auditCount = store.database.all("SELECT count(*) AS n FROM audit")[0]?.n;
    store.close();
    store = new SqliteStore(fixture.file);
    assert.equal(store.database.all("SELECT count(*) AS n FROM audit")[0]?.n, auditCount);
    assert.deepEqual(store.database.all("PRAGMA foreign_key_check"), []);
    assert.equal(store.database.all("PRAGMA integrity_check")[0]?.integrity_check, "ok");
    assert.deepEqual(readFileSync(fixture.config), config);
    assert.equal(statSync(fixture.file).mode & 0o777, 0o600);
  } finally {
    store.close();
  }
});

test("a failed retirement transaction leaves schema7 and original pending records intact", async (t) => {
  const fixture = await legacy();
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const db = new DatabaseSync(fixture.file);
  db.exec("DROP TABLE exposures");
  db.close();
  assert.throws(() => new SqliteStore(fixture.file), /exposures/);
  const original = new DatabaseSync(fixture.file, { readOnly: true });
  try {
    assert.equal(original.prepare("PRAGMA user_version").get()?.user_version, 7);
    assert.deepEqual(
      original.prepare("SELECT * FROM calls ORDER BY rowid").all(),
      fixture.snapshot.calls,
    );
    assert.deepEqual(
      original.prepare("SELECT * FROM audit ORDER BY id").all(),
      fixture.snapshot.audit,
    );
  } finally {
    original.close();
  }
});

test("historical Message import preserves source provenance, private metadata and one stable cursor across restart", async (t) => {
  const fixture = await legacy();
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const source = fixture.snapshot.messages?.[0] as Record<string, unknown>;
  const db = new DatabaseSync(fixture.file);
  db.prepare("UPDATE messages SET read_at=?,links=?,reply_to=? WHERE id=?").run(
    at,
    '[{"url":"https://example.com/original"}]',
    null,
    source.id as string,
  );
  db.prepare("INSERT INTO audit (at,actor,operation,target,outcome) VALUES (?,?,?,?,?)").run(
    at,
    "act_worker",
    "message_read",
    source.id as string,
    "ok",
  );
  const original = db.prepare("SELECT * FROM messages").get();
  db.close();
  let store = new SqliteStore(fixture.file);
  try {
    const message = store.workspace.messages.get("message");
    assert.deepEqual(message, {
      messageID: "message",
      senderID: "act_root",
      recipientID: "act_worker",
      text: source.text,
      createdAt: at,
      revision: 1,
      cursor: 1,
    });
    const history = store.workspace.messages.history("message");
    assert.deepEqual(history, [
      {
        actorID: "act_root",
        at,
        action: "sent",
        detail: { recipientID: "act_worker", text: source.text },
        revision: 1,
        cursor: 1,
      },
    ]);
    assert.deepEqual(store.database.all("SELECT * FROM legacy_messages"), [original]);
    const ledger = store.database.all("SELECT * FROM workspace_imports");
    assert.deepEqual(
      ledger.map((row) => ({ ...row })),
      [
        {
          message_id: "message",
          source_hash: createHash("sha256").update(JSON.stringify(original)).digest("hex"),
          recipient_id: "act_worker",
          workspace_cursor: 1,
        },
      ],
    );
    const org = organization(store);
    const publicMessage = await org.invoke(
      "act_worker",
      "message_get",
      { messageID: "message" },
      invocation(),
    );
    assert.equal(publicMessage.state, "done");
    assert.doesNotMatch(JSON.stringify(publicMessage), /read_at|reply_to|links|source_hash|import/);
    const activity = await org.invoke("act_root", "activity", {}, invocation());
    assert.doesNotMatch(JSON.stringify(activity), /message_read/);
    assert.equal(
      store.database.all("SELECT * FROM audit WHERE operation='message_read'").length,
      1,
    );
    const manifest = join(fixture.directory, "core.workspace.db.import.json");
    assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")).messages, [
      { messageID: "message", recipientID: "act_worker", cursor: 1 },
    ]);
    assert.equal(statSync(manifest).mode & 0o777, 0o600);
    store.close();
    store = new SqliteStore(fixture.file);
    assert.deepEqual(store.workspace.messages.get("message"), message);
    assert.deepEqual(store.workspace.messages.history("message"), history);
    assert.deepEqual(store.database.all("SELECT * FROM workspace_imports"), ledger);
  } finally {
    store.close();
  }
});

test("import failure before package commit rolls every Message back", async (t) => {
  const fixture = await legacy();
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const database = new Database(fixture.file);
  const workspace = openSqlite(join(fixture.directory, "workspace.db"));
  try {
    database.run(
      'INSERT INTO legacy_messages SELECT \'message2\',3,"from","to",text,links,reply_to,created_at,read_at FROM legacy_messages',
    );
    const save = workspace.messages.save.bind(workspace.messages);
    const mocked = t.mock.method(workspace.messages, "save", (...args: Parameters<typeof save>) => {
      const result = save(...args);
      if (args[0] === "message2") throw new Error("owned failure before commit");
      return result;
    });
    assert.throws(() => importLegacyMessages(database, workspace), /owned failure/);
    assert.deepEqual(workspace.messages.all(), []);
    assert.deepEqual(database.all("SELECT * FROM workspace_imports"), []);
    mocked.mock.restore();
    const baseline = importLegacyMessages(database, workspace);
    assert.deepEqual(
      baseline.map((item) => item.cursor),
      [1, 2],
    );
  } finally {
    workspace.close();
    database.close();
  }
});

test("restart recovers a committed package import when the Hub ledger commit fails", async (t) => {
  const fixture = await legacy();
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const database = new Database(fixture.file);
  database.db.exec(
    "CREATE TRIGGER import_failure BEFORE INSERT ON workspace_imports BEGIN SELECT RAISE(ABORT,'owned ledger failure'); END",
  );
  database.close();
  assert.throws(() => new SqliteStore(fixture.file), /owned ledger failure/);
  const workspace = openSqlite(join(fixture.directory, "core.workspace.db"));
  const message = workspace.messages.get("message");
  const history = workspace.messages.history("message");
  assert.equal(history.length, 1);
  workspace.close();
  const recovery = new DatabaseSync(fixture.file);
  recovery.exec("DROP TRIGGER import_failure");
  recovery.close();
  const store = new SqliteStore(fixture.file);
  try {
    assert.deepEqual(store.workspace.messages.get("message"), message);
    assert.deepEqual(store.workspace.messages.history("message"), history);
    assert.equal(store.database.all("SELECT * FROM workspace_imports").length, 1);
  } finally {
    store.close();
  }
});

test("restart rematerializes the private baseline after its write fails, without another send", async (t) => {
  const fixture = await legacy();
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const manifest = join(fixture.directory, "core.workspace.db.import.json");
  mkdirSync(manifest);
  assert.throws(() => new SqliteStore(fixture.file), /directory|EISDIR/);
  rmSync(manifest, { recursive: true });
  const store = new SqliteStore(fixture.file);
  try {
    assert.equal(store.workspace.messages.history("message").length, 1);
    assert.equal(store.workspace.messages.head(), 1);
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).messages[0].cursor, 1);
  } finally {
    store.close();
  }
});

test("changed originals, conflicting imported records and missing retained imports fail safely", async (t) => {
  for (const change of ["source", "collision", "missing"] as const) {
    const fixture = await legacy();
    t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
    if (change !== "collision") new SqliteStore(fixture.file).close();
    else new Database(fixture.file).close();
    if (change === "source") {
      const database = new DatabaseSync(fixture.file);
      database.exec("UPDATE legacy_messages SET read_at='changed-private-source'");
      database.close();
    } else if (change === "collision") {
      const workspace = openSqlite(join(fixture.directory, "core.workspace.db"));
      workspace.transaction(() =>
        workspace.messages.save(
          "message",
          {
            messageID: "message",
            senderID: "act_root",
            recipientID: "act_worker",
            text: "Different",
            createdAt: at,
          },
          { actorID: "act_root", at, action: "sent", detail: {} },
        ),
      );
      workspace.close();
    } else rmSync(join(fixture.directory, "core.workspace.db"));
    assert.throws(
      () => new SqliteStore(fixture.file),
      /source changed|conflicts with original send|imported record is missing/,
    );
  }
});

test("unrepresentable source fields are refused before importing or trimming any text", async (t) => {
  const fixture = await legacy();
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const db = new DatabaseSync(fixture.file);
  db.exec("UPDATE messages SET text='  original whitespace  '");
  db.close();
  assert.throws(() => new SqliteStore(fixture.file), /source fields cannot be preserved/);
  const workspace = openSqlite(join(fixture.directory, "core.workspace.db"));
  try {
    assert.deepEqual(workspace.messages.all(), []);
  } finally {
    workspace.close();
  }
});

test("a failed schema8 archive transaction rolls renames back and retains original rows", async (t) => {
  const fixture = await legacy();
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }));
  const db = new DatabaseSync(fixture.file);
  db.exec(
    "DROP TABLE exposures; DROP INDEX pending_calls; ALTER TABLE actors DROP COLUMN created_at_attach; DROP TABLE messages; PRAGMA user_version=8",
  );
  db.close();
  assert.throws(() => new SqliteStore(fixture.file), /messages/);
  const unchanged = new DatabaseSync(fixture.file, { readOnly: true });
  try {
    assert.equal(unchanged.prepare("PRAGMA user_version").get()?.user_version, 8);
    for (const table of ["progress", "questions"])
      assert.deepEqual(
        unchanged.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        fixture.snapshot[table],
      );
    assert.deepEqual(
      unchanged.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'legacy_%'").all(),
      [],
    );
  } finally {
    unchanged.close();
  }
});
