/** Domain storage operations over the SQLite tables in schema.ts. */

import type { SQLInputValue } from "node:sqlite";
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
  };

  readonly calls: Store["calls"] = {
    get: (id) => this.database.get("calls", id),
  };

  readonly progress: Store["progress"] = {
    insert: (progress) => this.database.insert("progress", progress),
    latest: (actor, limit) =>
      this.database.select("progress", "actor = ?", [actor], "version DESC", limit),
  };

  readonly questions: Store["questions"] = {
    insert: (question) => this.database.insert("questions", question),
    get: (id) => this.database.get("questions", id),
    list: (query) => {
      const { where, parameters } = conditions([
        query.to !== undefined && [`"to" = ?`, query.to],
        query.from !== undefined && [`"from" = ?`, query.from],
        query.open === true && ["answer IS NULL"],
        query.since !== undefined && ["cursor > ?", query.since],
      ]);
      return this.database.select("questions", where, parameters, "cursor DESC", query.limit ?? -1);
    },
    answer: (id, answer, cursor) => {
      this.database.run(
        "UPDATE questions SET answer = ?, cursor = ? WHERE id = ? AND answer IS NULL",
        [JSON.stringify(answer), cursor, id],
      );
    },
  };

  readonly messages: Store["messages"] = {
    insert: (message) => this.database.insert("messages", message),
    get: (id) => this.database.get("messages", id),
    list: (query) => {
      const { where, parameters } = conditions([
        query.viewer !== null && [
          `EXISTS (SELECT 1 FROM actors WHERE actors.id IN (messages."from", messages."to") AND (actors.id = ? OR actors.manager = ?))`,
          query.viewer,
          query.viewer,
        ],
        query.to !== undefined && [`"to" = ?`, query.to],
        query.from !== undefined && [`"from" = ?`, query.from],
        query.unread === true && ["read_at IS NULL"],
        query.since !== undefined && ["cursor > ?", query.since],
      ]);
      return this.database.select("messages", where, parameters, "cursor DESC", query.limit ?? -1);
    },
    read: (ids, at) => {
      this.database.run(
        `UPDATE messages SET read_at = ? WHERE read_at IS NULL AND id IN (${ids.map(() => "?").join(", ")})`,
        [at, ...ids],
      );
    },
  };

  readonly claims: Store["claims"] = {
    get: (resource) => this.database.select("claims", "resource = ?", [resource])[0],
    put: (claim) => {
      this.database.run(
        "INSERT OR REPLACE INTO claims (resource, holder, note, until, claimed_at) VALUES (?, ?, ?, ?, ?)",
        [claim.resource, claim.holder, claim.note, claim.until, claim.claimed_at],
      );
    },
    remove: (resource) => {
      this.database.run("DELETE FROM claims WHERE resource = ?", [resource]);
    },
    heldBy: (actor) => this.database.select("claims", "holder = ?", [actor]),
  };

  head(): number {
    const [row] = this.database.all(
      "SELECT max(cursor) AS head FROM (SELECT cursor FROM questions UNION ALL SELECT cursor FROM messages)",
    );
    return Number(row?.head ?? 0);
  }

  transaction<T>(work: () => T): T {
    return this.database.transaction(work);
  }

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

/** The conditions that apply, each with its parameters, joined into one SQL condition. */
function conditions(given: (false | [string, ...SQLInputValue[]])[]): {
  where: string;
  parameters: SQLInputValue[];
} {
  const applying = given.filter((each) => each !== false);
  return {
    where: applying.map(([condition]) => condition).join(" AND ") || "1",
    parameters: applying.flatMap(([, ...values]) => values),
  };
}
