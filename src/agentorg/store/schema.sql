-- The record. Each table holds one record model, with a column per field; columns declared
-- JSON hold lists and nested objects. Times are ISO 8601 text in UTC.

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    client TEXT NOT NULL,
    client_session_id TEXT,
    title TEXT NOT NULL,
    parent TEXT REFERENCES sessions (id),
    task TEXT REFERENCES tasks (id),
    role TEXT,
    machine TEXT NOT NULL,
    started_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE (client, client_session_id)
);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    project TEXT NOT NULL,
    owner TEXT REFERENCES sessions (id),
    parent TEXT REFERENCES tasks (id),
    state TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    closed_at TEXT
);

CREATE TABLE asks (
    id TEXT PRIMARY KEY,
    task TEXT REFERENCES tasks (id),
    session TEXT NOT NULL REFERENCES sessions (id),
    title TEXT NOT NULL,
    context TEXT NOT NULL,
    options JSON NOT NULL,
    recommendation TEXT NOT NULL,
    state TEXT NOT NULL,
    answer JSON,
    opened_at TEXT NOT NULL
);

CREATE TABLE items (
    id TEXT PRIMARY KEY,
    task TEXT REFERENCES tasks (id),
    session TEXT REFERENCES sessions (id),
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    summary TEXT NOT NULL,
    links JSON NOT NULL,
    evidence JSON NOT NULL,
    blockers JSON NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT
);

CREATE TABLE evidence (
    id TEXT PRIMARY KEY,
    item TEXT NOT NULL REFERENCES items (id),
    kind TEXT NOT NULL,
    width INTEGER,
    caption TEXT NOT NULL,
    file TEXT NOT NULL,
    content_type TEXT NOT NULL,
    added_at TEXT NOT NULL
);

CREATE TABLE reports (
    id TEXT PRIMARY KEY,
    sender TEXT NOT NULL REFERENCES sessions (id),
    recipient TEXT REFERENCES sessions (id),
    outcome TEXT NOT NULL,
    open_asks JSON NOT NULL,
    evidence JSON NOT NULL,
    sent_at TEXT NOT NULL,
    acknowledged_at TEXT
);

CREATE TABLE resources (
    session TEXT NOT NULL REFERENCES sessions (id),
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    registered_at TEXT NOT NULL
);

CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    session TEXT,
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
