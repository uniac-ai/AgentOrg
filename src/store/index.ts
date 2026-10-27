/**
 * SQLite storage for the record, in WAL mode, through Node's built-in `node:sqlite`.
 *
 * Each record schema has a table (`TABLES`) with a column per field. The store turns records into
 * rows and back, validating rows against their schema as it reads; the rules of the record live in
 * the service layer.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { z } from "zod";
import { Agent, Ask, AuditEntry, Evidence, Message, Session } from "../contract/index.ts";
import { SCHEMA, SCHEMA_VERSION } from "./schema.ts";

export const TABLES = {
  agents: Agent,
  sessions: Session,
  asks: Ask,
  messages: Message,
  evidence: Evidence,
  audit: AuditEntry,
} as const;

export type Table = keyof typeof TABLES;
export type RecordOf<T extends Table> = z.output<(typeof TABLES)[T]>;

const quote = (column: string) => `"${column}"`;

export class Store {
  readonly db: DatabaseSync;
  private readonly kinds: Record<string, Record<string, string>> = {};

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;",
    );
    this.createSchema();
    for (const table of Object.keys(TABLES)) {
      const columns = this.all(`PRAGMA table_info(${table})`) as { name: string; type: string }[];
      this.kinds[table] = Object.fromEntries(columns.map((column) => [column.name, column.type]));
    }
  }

  private createSchema(): void {
    const { user_version: version } = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version === SCHEMA_VERSION) return;
    if (version !== 0) {
      throw new Error(`the database has schema ${version}; this agentorg reads ${SCHEMA_VERSION}`);
    }
    this.transaction(() => this.db.exec(`${SCHEMA}\nPRAGMA user_version = ${SCHEMA_VERSION};`));
  }

  close(): void {
    this.db.close();
  }

  /** Run `work` as one transaction, rolled back if it throws. */
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  run(sql: string, parameters: SQLInputValue[] = []): void {
    this.db.prepare(sql).run(...parameters);
  }

  all(sql: string, parameters: SQLInputValue[] = []): Record<string, SQLInputValue>[] {
    return this.db.prepare(sql).all(...parameters) as Record<string, SQLInputValue>[];
  }

  insert<T extends Table>(table: T, record: RecordOf<T>): void {
    const row = this.row(table, record);
    const columns = Object.keys(row);
    this.run(
      `INSERT INTO ${table} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      Object.values(row),
    );
  }

  /** Replace the row with the record's id. */
  update<T extends Table>(table: T, record: RecordOf<T> & { id: string }): void {
    const { id, ...row } = this.row(table, record);
    const assignments = Object.keys(row).map((column) => `${quote(column)} = ?`);
    this.run(`UPDATE ${table} SET ${assignments.join(", ")} WHERE id = ?`, [
      ...Object.values(row),
      id ?? null,
    ]);
  }

  get<T extends Table>(table: T, id: string): RecordOf<T> | undefined {
    return this.select(table, "id = ?", [id])[0];
  }

  /** Records matching an SQL condition, oldest first unless `order` says otherwise. */
  select<T extends Table>(
    table: T,
    where = "1",
    parameters: SQLInputValue[] = [],
    order = "rowid",
    limit = -1,
  ): RecordOf<T>[] {
    const rows = this.all(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ?`, [
      ...parameters,
      limit,
    ]);
    return rows.map((row) => this.record(table, row));
  }

  count(table: Table, where: string, parameters: SQLInputValue[] = []): number {
    const [row] = this.all(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, parameters);
    return Number(row?.n ?? 0);
  }

  private row(table: Table, record: object): Record<string, SQLInputValue> {
    const kinds = this.kinds[table] ?? {};
    return Object.fromEntries(
      Object.entries(record).map(([column, value]) => {
        if (value === null || value === undefined) return [column, null];
        if (kinds[column] === "JSON") return [column, JSON.stringify(value)];
        if (kinds[column] === "BOOLEAN") return [column, value ? 1 : 0];
        return [column, value as SQLInputValue];
      }),
    );
  }

  private record<T extends Table>(table: T, row: Record<string, SQLInputValue>): RecordOf<T> {
    const kinds = this.kinds[table] ?? {};
    const fields = Object.fromEntries(
      Object.entries(row).map(([column, value]) => {
        if (value === null) return [column, null];
        if (kinds[column] === "JSON") return [column, JSON.parse(String(value))];
        if (kinds[column] === "BOOLEAN") return [column, value === 1];
        return [column, value];
      }),
    );
    return TABLES[table].parse(fields) as RecordOf<T>;
  }
}
