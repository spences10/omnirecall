import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { digest, parser_version } from './files.ts';
import { InputError, type Source, type Transcript } from './types.ts';

const application_id = 0x4f4d4e49;
function message_columns(alias: string) {
	return `${alias}.rowid,${alias}.revision_id,${alias}.native_id,${alias}.parent_id,${alias}.role,substr(${alias}.content,1,4000) AS content,length(${alias}.content)>4000 AS content_truncated,${alias}.timestamp,${alias}.source_order,${alias}.active,${alias}.turn_id`;
}

const schema = `
CREATE TABLE sources(source_id TEXT PRIMARY KEY, agent TEXT NOT NULL, root TEXT NOT NULL, status TEXT NOT NULL, checked_at TEXT);
CREATE TABLE sessions(session_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources, native_id TEXT NOT NULL, current_revision TEXT NOT NULL);
CREATE TABLE revisions(revision_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions, hash TEXT NOT NULL, parser_version INTEGER NOT NULL, project TEXT NOT NULL, title TEXT, parent_session TEXT, timestamp TEXT NOT NULL, indexed_at TEXT NOT NULL, omitted_records INTEGER NOT NULL, recorded_path TEXT NOT NULL);
CREATE TABLE paths(source_id TEXT NOT NULL REFERENCES sources, path TEXT NOT NULL, session_id TEXT, revision_id TEXT, status TEXT NOT NULL, byte_offset INTEGER, parser_version INTEGER, checked_at TEXT NOT NULL, PRIMARY KEY(source_id,path));
CREATE TABLE messages(rowid INTEGER PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES revisions, native_id TEXT NOT NULL, parent_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL, source_order INTEGER NOT NULL, active INTEGER NOT NULL, turn_id TEXT, UNIQUE(revision_id,native_id));
CREATE INDEX message_order ON messages(revision_id,source_order);
CREATE INDEX message_parent ON messages(revision_id,parent_id);
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');
CREATE TRIGGER messages_insert AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid,content) VALUES(new.rowid,new.content); END;
`;

export interface QueryOptions {
	agent?: string;
	source?: string;
	project?: string;
	session?: string;
	after?: string;
	before?: string;
	include_history?: boolean;
	limit: number;
	offset: number;
	context: number;
}

export class Archive {
	readonly db: DatabaseSync;
	constructor(path: string, read_only = false) {
		const existed = path !== ':memory:' && existsSync(path);
		if (!read_only && path !== ':memory:')
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(path, { readOnly: read_only });
		try {
			this.db.exec(
				'PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;',
			);
			const id = Number(
				this.get('PRAGMA application_id')?.application_id,
			);
			if (id !== application_id) {
				if (existed || read_only)
					throw new InputError(
						'database',
						'Not an Omni Recall archive; refusing to modify it',
					);
				this.transaction(() =>
					this.db.exec(
						`${schema} PRAGMA application_id=${application_id}; PRAGMA user_version=1;`,
					),
				);
			}
			if (Number(this.get('PRAGMA user_version')?.user_version) !== 1)
				throw new InputError(
					'database',
					'Unsupported archive schema',
				);
			if (!read_only && path !== ':memory:') chmodSync(path, 0o600);
		} catch (error) {
			this.db.close();
			throw error;
		}
	}
	get(sql: string, ...values: SQLInputValue[]) {
		return this.db.prepare(sql).get(...values);
	}
	all(sql: string, ...values: SQLInputValue[]) {
		return this.db.prepare(sql).all(...values);
	}
	run(sql: string, ...values: SQLInputValue[]) {
		return this.db.prepare(sql).run(...values);
	}
	close() {
		this.db.close();
	}
	transaction<T>(fn: () => T): T {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const result = fn();
			this.db.exec('COMMIT');
			return result;
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}
	register(source: Source, status: string) {
		this.run(
			'INSERT INTO sources VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET status=excluded.status, checked_at=excluded.checked_at',
			source.source_id,
			source.agent,
			source.root,
			status,
			new Date().toISOString(),
		);
	}
	store(
		source: Source,
		path: string,
		transcript: Transcript,
		snapshot: { hash: string; byte_offset: number; partial: boolean },
		refresh_title = false,
	) {
		const session_id = `${source.source_id}:${encodeURIComponent(transcript.native_id)}`;
		const revision_id = digest(
			`${session_id}:${parser_version}:${snapshot.hash}`,
		);
		return this.transaction(() => {
			const known = this.get(
				'SELECT 1 FROM revisions WHERE revision_id=?',
				revision_id,
			);
			this.run(
				'INSERT INTO sessions VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET current_revision=excluded.current_revision',
				session_id,
				source.source_id,
				transcript.native_id,
				revision_id,
			);
			if (!known) {
				this.run(
					'INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?,?,?,?)',
					revision_id,
					session_id,
					snapshot.hash,
					parser_version,
					transcript.project,
					transcript.title,
					transcript.parent_session,
					transcript.timestamp,
					new Date().toISOString(),
					transcript.omitted_records,
					path,
				);
				for (const message of transcript.messages)
					this.run(
						'INSERT INTO messages(revision_id,native_id,parent_id,role,content,timestamp,source_order,active,turn_id) VALUES(?,?,?,?,?,?,?,?,?)',
						revision_id,
						message.native_id,
						message.parent_id,
						message.role,
						message.content,
						message.timestamp,
						message.source_order,
						Number(message.active),
						message.turn_id,
					);
			}
			if (refresh_title)
				this.run(
					'UPDATE revisions SET title=? WHERE revision_id=?',
					transcript.title,
					revision_id,
				);
			this.run(
				'INSERT INTO paths VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_id,path) DO UPDATE SET session_id=excluded.session_id, revision_id=excluded.revision_id, status=excluded.status, byte_offset=excluded.byte_offset, parser_version=excluded.parser_version, checked_at=excluded.checked_at',
				source.source_id,
				path,
				session_id,
				revision_id,
				snapshot.partial ? 'partial' : 'available',
				snapshot.byte_offset,
				parser_version,
				new Date().toISOString(),
			);
			return { session_id, revision_id, added: !known };
		});
	}
	path_status(source: Source, path: string, status: string) {
		this.run(
			'INSERT INTO paths(source_id,path,status,checked_at) VALUES(?,?,?,?) ON CONFLICT(source_id,path) DO UPDATE SET status=excluded.status, checked_at=excluded.checked_at',
			source.source_id,
			path,
			status,
			new Date().toISOString(),
		);
	}
	filters(options: QueryOptions) {
		const terms: string[] = [];
		const values: SQLInputValue[] = [];
		for (const [column, value] of [
			['s.agent', options.agent],
			['s.source_id', options.source],
			['r.project', options.project],
			['t.session_id', options.session],
		] as const) {
			if (value !== undefined) {
				terms.push(`${column}=?`);
				values.push(value);
			}
		}
		if (!options.include_history)
			terms.push('r.revision_id=t.current_revision');
		return { sql: terms.length ? terms.join(' AND ') : '1', values };
	}
	sources(options: QueryOptions) {
		return this.all(
			'SELECT s.*, (SELECT count(*) FROM sessions t WHERE t.source_id=s.source_id) AS session_count FROM sources s WHERE (? IS NULL OR s.agent=?) AND (? IS NULL OR s.source_id=?) ORDER BY source_id LIMIT ? OFFSET ?',
			options.agent ?? null,
			options.agent ?? null,
			options.source ?? null,
			options.source ?? null,
			options.limit + 1,
			options.offset,
		);
	}
	sessions(options: QueryOptions) {
		const filter = this.filters(options);
		return this.all(
			`SELECT t.session_id,t.native_id,s.source_id,s.agent,s.root,s.status AS source_status,s.checked_at AS source_checked_at,r.*,(r.revision_id=t.current_revision) AS current_revision, ${this.provenance()} FROM sessions t JOIN sources s USING(source_id) JOIN revisions r USING(session_id) WHERE ${filter.sql} ORDER BY r.timestamp DESC,t.session_id,r.revision_id LIMIT ? OFFSET ?`,
			...filter.values,
			options.limit + 1,
			options.offset,
		);
	}
	provenance() {
		return `COALESCE((SELECT p.path FROM paths p WHERE p.revision_id=r.revision_id ORDER BY CASE p.status WHEN 'available' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,p.checked_at DESC,p.path LIMIT 1),r.recorded_path) AS source_path, COALESCE((SELECT p.status FROM paths p WHERE p.revision_id=r.revision_id ORDER BY CASE p.status WHEN 'available' THEN 0 WHEN 'partial' THEN 1 ELSE 2 END,p.path LIMIT 1),'superseded') AS path_status`;
	}
	search(query: string, options: QueryOptions) {
		const filter = this.filters(options);
		const terms = [filter.sql];
		if (!options.include_history) terms.push('m.active=1');
		for (const [operator, value] of [
			['>=', options.after],
			['<=', options.before],
		] as const) {
			if (value !== undefined) {
				terms.push(`m.timestamp ${operator} ?`);
				filter.values.push(value);
			}
		}
		// Plain words are ANDed; SQL/FTS operators are never executed from input.
		const expression = query
			.trim()
			.split(/\s+/)
			.map((word) => `"${word.replaceAll('"', '""')}"`)
			.join(' AND ');
		return this.all(
			`SELECT ${message_columns('m')},t.session_id,s.source_id,s.agent,s.root,s.status AS source_status,s.checked_at AS source_checked_at,r.project,r.title,r.parent_session,r.indexed_at,r.omitted_records,(r.revision_id=t.current_revision) AS current_revision,${this.provenance()},substr(snippet(messages_fts,0,'','','…',32),1,4000) AS snippet,bm25(messages_fts) AS relevance FROM messages_fts JOIN messages m ON m.rowid=messages_fts.rowid JOIN revisions r USING(revision_id) JOIN sessions t ON t.session_id=r.session_id JOIN sources s USING(source_id) WHERE messages_fts MATCH ? AND ${terms.join(' AND ')} ORDER BY relevance,m.timestamp DESC,t.session_id,r.revision_id,m.source_order,m.native_id LIMIT ? OFFSET ?`,
			expression,
			...filter.values,
			options.limit + 1,
			options.offset,
		);
	}
	context(revision_id: string, native_id: string, count: number) {
		const match = this.get(
			`SELECT ${message_columns('m')} FROM messages m WHERE revision_id=? AND native_id=?`,
			revision_id,
			native_id,
		);
		if (!match) throw new Error('Missing archived match');
		const before = [];
		let cursor = match;
		for (let i = 0; i < count && cursor.parent_id; i++) {
			const parent = this.get(
				`SELECT ${message_columns('m')} FROM messages m WHERE revision_id=? AND native_id=?`,
				revision_id,
				cursor.parent_id,
			);
			if (!parent) break;
			before.unshift(parent);
			cursor = parent;
		}
		const after = [];
		cursor = match;
		let branch_boundary = false;
		for (let i = 0; i < count; i++) {
			const children = this.all(
				`SELECT ${message_columns('m')} FROM messages m WHERE revision_id=? AND parent_id=? AND active=? ORDER BY source_order LIMIT 2`,
				revision_id,
				cursor.native_id,
				match.active,
			);
			if (children.length !== 1) {
				branch_boundary = children.length > 1;
				break;
			}
			cursor = children[0]!;
			after.push(cursor);
		}
		return { before, after, branch_boundary };
	}
}
