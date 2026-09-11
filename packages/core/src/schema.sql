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
  current_revision TEXT NOT NULL,
  FOREIGN KEY(session_id,current_revision) REFERENCES revisions(session_id,revision_id) DEFERRABLE INITIALLY DEFERRED
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
  unindexed_records INTEGER NOT NULL,
  recorded_path TEXT NOT NULL,
  UNIQUE(session_id,revision_id)
);

CREATE TABLE resources (
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

CREATE TABLE parts (
  rowid INTEGER PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES revisions,
  native_id TEXT NOT NULL,
  parent_id TEXT,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  representation TEXT NOT NULL,
  state TEXT NOT NULL,
  record_key TEXT,
  json_pointer TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT,
  source_order INTEGER NOT NULL,
  active INTEGER NOT NULL,
  turn_id TEXT,
  FOREIGN KEY (revision_id, record_key) REFERENCES records,
  UNIQUE (revision_id, native_id)
);

CREATE INDEX message_order ON parts (revision_id, source_order);
CREATE INDEX message_parent ON parts (revision_id, parent_id);

CREATE VIRTUAL TABLE parts_fts USING fts5(
  content,
  content='parts',
  content_rowid='rowid'
);

CREATE TRIGGER messages_insert AFTER INSERT ON parts BEGIN
  INSERT INTO parts_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE records (
 revision_id TEXT NOT NULL REFERENCES revisions,
 record_key TEXT NOT NULL,
 native_id TEXT,
 native_type TEXT,
 timestamp TEXT,
 source_order INTEGER NOT NULL,
 raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
 input_path TEXT NOT NULL,
 UNIQUE(revision_id,source_order),
 PRIMARY KEY(revision_id, record_key)
);
CREATE TABLE links (
 revision_id TEXT NOT NULL,
 record_key TEXT NOT NULL,
 kind TEXT NOT NULL,
 namespace TEXT NOT NULL,
 target TEXT NOT NULL,
 FOREIGN KEY(revision_id, record_key) REFERENCES records,
 PRIMARY KEY(revision_id, record_key, kind, namespace, target)
);
CREATE INDEX links_target ON links(revision_id, namespace, target);

CREATE TRIGGER messages_update AFTER UPDATE ON parts BEGIN
 INSERT INTO parts_fts(parts_fts,rowid,content) VALUES('delete',old.rowid,old.content);
 INSERT INTO parts_fts(rowid,content) VALUES(new.rowid,new.content);
END;
CREATE TRIGGER messages_delete AFTER DELETE ON parts BEGIN
 INSERT INTO parts_fts(parts_fts,rowid,content) VALUES('delete',old.rowid,old.content);
END;

CREATE TABLE revision_inputs (
 revision_id TEXT NOT NULL REFERENCES revisions,
 source_id TEXT NOT NULL,
 path TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 byte_offset INTEGER NOT NULL,
 PRIMARY KEY(revision_id, source_id, path),
 FOREIGN KEY(source_id, path) REFERENCES resources(source_id,path)
);

CREATE INDEX record_order ON records(revision_id, source_order);
CREATE INDEX record_native ON records(revision_id,native_id);
CREATE INDEX part_kind ON parts(kind);
