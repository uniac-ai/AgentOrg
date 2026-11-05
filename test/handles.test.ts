/** Schema 10: handles unique among open Actors, from homes whose handles were unique among siblings. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Handle } from "../src/domain/model/index.ts";
import { SqliteStore } from "../src/storage/sqlite/index.ts";

test("schema 9 renames each later open duplicate handle to the first free one, within the limit", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agentorg-handles-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "core.db");
  new SqliteStore(path).close();
  const long = "a".repeat(40);
  const rows: [string, string, string | null, string | null][] = [
    ["act_root", "root", null, null],
    ["act_lead", "lead", "act_root", null],
    ["act_b", "storage", "act_root", null],
    ["act_c", "storage", "act_lead", null],
    ["act_d", "storage-2", "act_lead", null],
    ["act_e", "storage", "act_b", "2026-11-02T00:00:00.000Z"],
    ["act_f", long, "act_root", null],
    ["act_g", long, "act_lead", null],
  ];
  const old = new DatabaseSync(path);
  old.exec(`
    DROP INDEX handles_unique_among_open;
    CREATE UNIQUE INDEX one_root ON actors ((manager IS NULL)) WHERE manager IS NULL;
    CREATE UNIQUE INDEX handles_unique_among_siblings ON actors (manager, name) WHERE closed_at IS NULL;
    PRAGMA user_version = 9;`);
  const insert = old.prepare(
    "INSERT INTO actors (id, name, purpose, manager, credential_hash, created_at, closed_at) VALUES (?, ?, 'p', ?, ?, '2026-11-01T00:00:00.000Z', ?)",
  );
  for (const [id, name, manager, closed] of rows)
    insert.run(id, name, manager, `hash-${id}`, closed);
  old.close();

  const store = new SqliteStore(path);
  t.after(() => store.close());
  assert.equal(store.database.all("PRAGMA user_version")[0]?.user_version, 10);
  const names = Object.fromEntries(rows.map(([id]) => [id, store.actors.get(id)?.name]));
  assert.deepEqual(names, {
    act_root: "root",
    act_lead: "lead",
    act_b: "storage",
    act_c: "storage-3",
    act_d: "storage-2",
    act_e: "storage",
    act_f: long,
    act_g: `${"a".repeat(38)}-2`,
  });
  for (const name of Object.values(names)) assert.ok(Handle.safeParse(name).success, name);
  assert.deepEqual(
    store.database
      .all(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'actors' AND sql IS NOT NULL ORDER BY name",
      )
      .map((row) => row.name),
    ["handles_unique_among_open"],
  );
  assert.throws(
    () =>
      store.database.run(
        "INSERT INTO actors (id, name, purpose, manager, credential_hash, created_at) VALUES ('act_h', 'lead', 'p', NULL, 'hash-h', '2026-11-03T00:00:00.000Z')",
      ),
    /UNIQUE constraint failed/,
  );
});
