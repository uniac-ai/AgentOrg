-- Exact schema 7 from commit 9576a6315a568a6d1b8cfcea0ed89f8305e8b07b.
CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  manager TEXT REFERENCES actors (id),
  credential_hash TEXT NOT NULL UNIQUE,
  created_at_attach BOOLEAN NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE UNIQUE INDEX one_root ON actors ((manager IS NULL)) WHERE manager IS NULL;
CREATE UNIQUE INDEX handles_unique_among_siblings ON actors (manager, name) WHERE closed_at IS NULL;

CREATE TABLE exposures (
  id TEXT PRIMARY KEY REFERENCES actors (id),
  interfaces JSON NOT NULL
);

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

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL UNIQUE,
  "from" TEXT NOT NULL REFERENCES actors (id),
  "to" TEXT NOT NULL REFERENCES actors (id),
  text TEXT NOT NULL,
  links JSON NOT NULL,
  options JSON NOT NULL,
  recommendation TEXT,
  answerer TEXT REFERENCES actors (id),
  cause TEXT REFERENCES questions (id),
  answer JSON,
  created_at TEXT NOT NULL
);
CREATE INDEX questions_to ON questions ("to");
CREATE INDEX questions_from ON questions ("from");

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL UNIQUE,
  "from" TEXT NOT NULL REFERENCES actors (id),
  "to" TEXT NOT NULL REFERENCES actors (id),
  text TEXT NOT NULL,
  links JSON NOT NULL,
  reply_to TEXT REFERENCES messages (id),
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX messages_to ON messages ("to");
CREATE INDEX messages_from ON messages ("from");

CREATE TABLE claims (
  resource TEXT PRIMARY KEY,
  holder TEXT NOT NULL REFERENCES actors (id),
  note TEXT NOT NULL,
  until TEXT,
  claimed_at TEXT NOT NULL
);
CREATE INDEX claims_holder ON claims (holder);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT,
  operation TEXT NOT NULL,
  target TEXT,
  outcome TEXT NOT NULL
);
