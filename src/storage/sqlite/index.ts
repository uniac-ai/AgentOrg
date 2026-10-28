/**
 * The domain's `Store` over a SQLite database: each read and write the domain needs, as one SQL
 * statement on the tables in `schema.ts`.
 */

import type { SQLInputValue } from "node:sqlite";
import type { MessageQuery, Store } from "../../domain/ports.ts";
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

  readonly progress: Store["progress"] = {
    insert: (progress) => this.database.insert("progress", progress),
    latest: (actor, limit) =>
      this.database.select("progress", "actor = ?", [actor], "version DESC", limit),
  };

  readonly messages: Store["messages"] = {
    insert: (message) => this.database.insert("messages", message),
    get: (id) => this.database.get("messages", id),
    list: (query) => {
      const { where, parameters } = messageConditions(query);
      return this.database.select("messages", where, parameters, "rowid DESC", query.limit ?? -1);
    },
    read: (ids, at) => {
      this.database.run(
        `UPDATE messages SET read_at = ? WHERE read_at IS NULL AND id IN (${ids.map(() => "?").join(", ")})`,
        [at, ...ids],
      );
    },
    answer: (question, reply) => {
      this.database.run(
        "UPDATE messages SET answer = ? WHERE id = ? AND expects_reply = 1 AND answer IS NULL",
        [reply, question],
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

/** The SQL condition for a message query, with its parameters. */
function messageConditions(query: MessageQuery): { where: string; parameters: SQLInputValue[] } {
  const conditions: string[] = [];
  const parameters: SQLInputValue[] = [];
  const add = (condition: string, ...values: SQLInputValue[]) => {
    conditions.push(condition);
    parameters.push(...values);
  };
  if (query.viewer !== null) {
    add(
      `(public = 1 OR EXISTS (SELECT 1 FROM actors WHERE actors.id IN (messages."from", messages."to") AND (actors.id = ? OR actors.manager = ?)))`,
      query.viewer,
      query.viewer,
    );
  }
  if (query.to !== undefined) add(`"to" = ?`, query.to);
  if (query.from !== undefined) add(`"from" = ?`, query.from);
  for (const party of query.parties ?? []) add(`(? IN ("from", "to"))`, party);
  if (query.replyTo !== undefined) {
    add("EXISTS (SELECT 1 FROM json_each(messages.reply_to) WHERE value = ?)", query.replyTo);
  }
  if (query.pending) {
    add("(CASE WHEN expects_reply = 1 THEN answer IS NULL ELSE read_at IS NULL END)");
  }
  if (query.questions) add("expects_reply = 1");
  if (query.since !== undefined) add("created_at > ?", query.since);
  return { where: conditions.join(" AND ") || "1", parameters };
}
