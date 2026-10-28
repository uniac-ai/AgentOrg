/**
 * The tables. Each holds one record schema, with a column per field; columns declared JSON hold
 * lists and nested objects, and columns declared BOOLEAN hold 0 or 1. Times are ISO 8601 text in
 * UTC. Only the hash of an actor's credential is stored.
 */

import { ActorRecord, AuditEntry, Call, Message, Progress } from "../../domain/model/index.ts";

export const SCHEMA_VERSION = 3;

export const SCHEMA = `
CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  manager TEXT REFERENCES actors (id),
  credential_hash TEXT NOT NULL UNIQUE,
  online BOOLEAN NOT NULL,
  interfaces JSON NOT NULL,
  status JSON,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE UNIQUE INDEX one_root ON actors ((manager IS NULL)) WHERE manager IS NULL;
CREATE UNIQUE INDEX handles_unique_among_siblings ON actors (manager, name) WHERE closed_at IS NULL;

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
CREATE INDEX pending_calls ON calls ("to") WHERE state = 'pending';

CREATE TABLE progress (
  actor TEXT NOT NULL REFERENCES actors (id),
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  summary TEXT NOT NULL,
  items JSON NOT NULL,
  links JSON NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (actor, version)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  "from" TEXT NOT NULL REFERENCES actors (id),
  "to" TEXT NOT NULL REFERENCES actors (id),
  text TEXT NOT NULL,
  links JSON NOT NULL,
  options JSON NOT NULL,
  recommendation TEXT,
  expects_reply BOOLEAN NOT NULL,
  answerer TEXT REFERENCES actors (id),
  cause TEXT REFERENCES messages (id),
  reply_to JSON NOT NULL,
  choice TEXT,
  public BOOLEAN NOT NULL,
  answer TEXT REFERENCES messages (id),
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX messages_to ON messages ("to");
CREATE INDEX messages_from ON messages ("from");

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
  calls: Call,
  progress: Progress,
  messages: Message,
  audit: AuditEntry,
} as const;
