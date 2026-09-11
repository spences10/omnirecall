CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  root TEXT NOT NULL,
  status TEXT NOT NULL,
  checked_at TEXT
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources,
  native_id TEXT NOT NULL,
  current_revision TEXT NOT NULL
);

CREATE TABLE revisions (
  revision_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions,
  hash TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  project TEXT NOT NULL,
  title TEXT,
  parent_session TEXT,
  timestamp TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  omitted_records INTEGER NOT NULL,
  recorded_path TEXT NOT NULL
);

CREATE TABLE paths (
  source_id TEXT NOT NULL REFERENCES sources,
  path TEXT NOT NULL,
  session_id TEXT,
  revision_id TEXT,
  status TEXT NOT NULL,
  byte_offset INTEGER,
  parser_version INTEGER,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (source_id, path)
);

CREATE TABLE messages (
  rowid INTEGER PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revisions,
  native_id TEXT NOT NULL,
  parent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  source_order INTEGER NOT NULL,
  active INTEGER NOT NULL,
  turn_id TEXT,
  UNIQUE (revision_id, native_id)
);

CREATE INDEX message_order ON messages (revision_id, source_order);
CREATE INDEX message_parent ON messages (revision_id, parent_id);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);

CREATE TRIGGER messages_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
