/** Retire schema-7 Actor execution without losing identity, history or unrelated state. */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { organization } from "../src/domain/index.ts";
import { SqliteStore } from "../src/storage/sqlite/index.ts";

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
    assert.equal(store.database.all("PRAGMA user_version")[0]?.user_version, 8);
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
      assert.deepEqual(
        store.database.all(`SELECT * FROM ${table} ORDER BY rowid`),
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
          "hub:questions",
          "hub:messages",
          "hub:claims",
          "hub:calls",
          "hub:activity",
        ],
      );
      assert.equal(org.available(actor).flatMap((tool) => tool.interfaces).length, 15);
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
