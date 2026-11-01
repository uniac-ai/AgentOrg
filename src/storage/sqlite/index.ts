/** Hub state and one package-owned Workspace store for the same private Hub home. */

import { chmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openSqlite, type WorkspaceStore } from "@uniac/agentic-workspace/persistence";
import { ActorRecord } from "../../domain/model/records.ts";
import type { Store } from "../../domain/ports.ts";
import { Database } from "./database.ts";
import { importLegacyMessages, writeImportBaseline } from "./workspace-import.ts";

export { Database };

export class SqliteStore implements Store {
  readonly database: Database;
  readonly workspace: WorkspaceStore;

  constructor(path: string) {
    this.database = new Database(path);
    const workspacePath =
      path === ":memory:" ? path : join(dirname(path), `${basename(path, ".db")}.workspace.db`);
    let workspace: WorkspaceStore | undefined;
    try {
      workspace = openSqlite(workspacePath);
      if (workspacePath !== ":memory:") chmodSync(workspacePath, 0o600);
      const baseline = importLegacyMessages(this.database, workspace);
      if (path !== ":memory:") writeImportBaseline(`${workspacePath}.import.json`, baseline);
      this.workspace = workspace;
    } catch (error) {
      workspace?.close();
      this.database.close();
      throw error;
    }
  }

  close(): void {
    try {
      this.workspace.close();
    } finally {
      this.database.close();
    }
  }

  readonly actors: Store["actors"] = {
    insert: (actor) => this.database.insert("actors", actor),
    update: (actor) => this.database.update("actors", actor),
    get: (id) => this.database.get("actors", id),
    byCredentialHash: (hash) =>
      this.database.select("actors", "credential_hash = ? AND closed_at IS NULL", [hash])[0],
    root: () => this.database.select("actors", "manager IS NULL")[0],
    reports: (manager) =>
      this.database.select("actors", "manager = ? AND closed_at IS NULL", [manager]),
    open: () => this.database.select("actors", "closed_at IS NULL"),
    directory: (after, limit) => {
      const rows = this.database.all(
        "SELECT rowid AS ordinal, * FROM actors WHERE closed_at IS NULL AND rowid > ? ORDER BY rowid LIMIT ?",
        [after, limit],
      );
      return {
        items: rows.map(({ ordinal: _, ...actor }) => ActorRecord.parse(actor)),
        after: Number(rows.at(-1)?.ordinal ?? after),
        head: Number(
          this.database.all("SELECT coalesce(max(rowid),0) AS head FROM actors")[0]?.head ?? 0,
        ),
      };
    },
  };
  readonly calls: Store["calls"] = { get: (id) => this.database.get("calls", id) };
  readonly claims: Store["claims"] = {
    get: (resource) => this.database.select("claims", "resource = ?", [resource])[0],
    put: (claim) => {
      this.database.run(
        "INSERT OR REPLACE INTO claims (resource,holder,note,until,claimed_at) VALUES (?,?,?,?,?)",
        [claim.resource, claim.holder, claim.note, claim.until, claim.claimed_at],
      );
    },
    remove: (resource) => {
      this.database.run("DELETE FROM claims WHERE resource = ?", [resource]);
    },
  };
  readonly audit: Store["audit"] = {
    append: (entry) => {
      this.database.run(
        "INSERT INTO audit (at,actor,operation,target,outcome) VALUES (?,?,?,?,?)",
        [entry.at, entry.actor, entry.operation, entry.target, entry.outcome],
      );
    },
    list: (since, limit) => {
      const shown = "operation NOT IN ('message_read','message_acknowledge','message_handle')";
      return since === undefined
        ? this.database.select("audit", shown, [], "id DESC", limit).reverse()
        : this.database.select("audit", `id > ? AND ${shown}`, [since], "id", limit);
    },
  };
  transaction<T>(work: () => T): T {
    return this.database.transaction(work);
  }
}
