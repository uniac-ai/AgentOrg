/** SQLite tables and their record schemas; times are ISO 8601 UTC and credentials are hashed. */

import { ActorRecord, AuditEntry, Claim } from "../../domain/model/index.ts";

export const SCHEMA_VERSION = 9;

export const SCHEMA = `
CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  manager TEXT REFERENCES actors (id),
  credential_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE UNIQUE INDEX one_root ON actors ((manager IS NULL)) WHERE manager IS NULL;
CREATE UNIQUE INDEX handles_unique_among_siblings ON actors (manager, name) WHERE closed_at IS NULL;

-- Retired Actor-call history, retained privately; no operation reads it.
CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  "from" TEXT NOT NULL REFERENCES actors (id),
  "to" TEXT NOT NULL REFERENCES actors (id),
  interface TEXT NOT NULL,
  input JSON NOT NULL,
  state TEXT NOT NULL,
  output JSON,
  error TEXT,
  cause TEXT REFERENCES calls (id),
  run TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  settled_at TEXT
);
CREATE TABLE claims (
  resource TEXT PRIMARY KEY,
  holder TEXT NOT NULL REFERENCES actors (id),
  note TEXT NOT NULL,
  until TEXT,
  claimed_at TEXT NOT NULL
);
CREATE INDEX claims_holder ON claims (holder);

CREATE TABLE workspace_imports (
  message_id TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  recipient_id TEXT NOT NULL REFERENCES actors(id),
  workspace_cursor INTEGER NOT NULL
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT,
  operation TEXT NOT NULL,
  target TEXT,
  outcome TEXT NOT NULL
);
`;

export const TABLES = {
  actors: ActorRecord,
  claims: Claim,
  audit: AuditEntry,
} as const;
