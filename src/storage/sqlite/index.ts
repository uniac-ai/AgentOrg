/**
 * The domain's `Store` over a SQLite database: each read and write the domain needs, as one SQL
 * statement on the tables in `schema.ts`.
 */

import type { Store } from "../../domain/ports.ts";
import { Database } from "./database.ts";

export { Database };

export class SqliteStore implements Store {
  readonly database: Database;

  constructor(path: string) {
    this.database = new Database(path);
  }

  close(): void {
    this.database.close();
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
    setOnline: (id, online) => {
      this.database.run("UPDATE actors SET online = ? WHERE id = ?", [online ? 1 : 0, id]);
    },
    setAllOffline: () => {
      this.database.run("UPDATE actors SET online = 0");
    },
    setInterfaces: (id, interfaces) => {
      this.database.run("UPDATE actors SET interfaces = ? WHERE id = ?", [
        JSON.stringify(interfaces),
        id,
      ]);
    },
  };

  readonly calls: Store["calls"] = {
    insert: (call) => this.database.insert("calls", call),
    get: (id) => this.database.get("calls", id),
    pendingTo: (actor) => this.database.select("calls", `"to" = ? AND state = 'pending'`, [actor]),
    pendingFrom: (actor) =>
      this.database.select("calls", `"from" = ? AND state = 'pending'`, [actor]),
    settled: (actor, limit) =>
      this.database.select(
        "calls",
        `("to" = ? OR "from" = ?) AND state != 'pending'`,
        [actor, actor],
        "settled_at DESC",
        limit,
      ),
    delivered: (id, at) => {
      this.database.run("UPDATE calls SET delivered_at = ?, run = NULL WHERE id = ?", [at, id]);
    },
    setRun: (id, run) => {
      this.database.run("UPDATE calls SET run = ? WHERE id = ?", [run, id]);
    },
    settle: (id, settled) =>
      this.database.run(
        "UPDATE calls SET state = ?, output = ?, error = ?, settled_at = ? WHERE id = ? AND state = 'pending'",
        [
          settled.state,
          settled.output ? JSON.stringify(settled.output) : null,
          settled.error,
          settled.settled_at,
          id,
        ],
      ) > 0,
  };

  readonly audit: Store["audit"] = {
    append: (entry) => {
      this.database.run(
        "INSERT INTO audit (at, actor, operation, target, outcome) VALUES (?, ?, ?, ?, ?)",
        [entry.at, entry.actor, entry.operation, entry.target, entry.outcome],
      );
    },
    list: (since, limit) => this.database.select("audit", "id > ?", [since ?? 0], "id DESC", limit),
  };
}
