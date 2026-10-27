/**
 * The record's tables. Each holds one record schema, with a column per field; columns declared
 * JSON hold lists and nested objects, and columns declared BOOLEAN hold 0 or 1. Times are ISO 8601
 * text in UTC. The partial unique indexes keep one attached session per agent and per client session.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL,
  manager TEXT REFERENCES agents (id),
  created_by TEXT NOT NULL,
  created_at_attach BOOLEAN NOT NULL,
  state TEXT NOT NULL,
  status JSON,
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL REFERENCES agents (id),
  client TEXT NOT NULL,
  client_session_id TEXT,
  machine TEXT NOT NULL,
  attached_at TEXT NOT NULL,
  detached_at TEXT
);
CREATE UNIQUE INDEX one_attached_session_per_agent ON sessions (agent) WHERE detached_at IS NULL;
CREATE UNIQUE INDEX one_attachment_per_client_session ON sessions (client, client_session_id)
  WHERE detached_at IS NULL AND client_session_id IS NOT NULL;

CREATE TABLE asks (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL REFERENCES agents (id),
  session TEXT NOT NULL REFERENCES sessions (id),
  "to" TEXT REFERENCES agents (id),
  title TEXT NOT NULL,
  context TEXT NOT NULL,
  options JSON NOT NULL,
  recommendation TEXT NOT NULL,
  escalates JSON NOT NULL,
  state TEXT NOT NULL,
  answer JSON,
  opened_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  "from" TEXT NOT NULL REFERENCES agents (id),
  "to" TEXT REFERENCES agents (id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  evidence JSON NOT NULL,
  sent_at TEXT NOT NULL,
  read_at TEXT,
  acknowledged_at TEXT
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL REFERENCES messages (id),
  kind TEXT NOT NULL,
  width INTEGER,
  caption TEXT NOT NULL,
  file TEXT NOT NULL,
  content_type TEXT NOT NULL,
  added_at TEXT NOT NULL
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  session TEXT,
  agent TEXT,
  client TEXT,
  operation TEXT NOT NULL,
  target TEXT,
  channel TEXT NOT NULL,
  outcome TEXT NOT NULL
);

-- Sign-in to the decisions page. Only hashes of the secrets are stored.
CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE page_sessions (
  id_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;
