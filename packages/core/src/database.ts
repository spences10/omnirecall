import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { digest, parser_version } from './files.ts';
import { sql } from './queries.ts';
import { apply_schema } from './schema.ts';
import { parse_cache, type SyncCache } from './sync-cache.ts';
import {
	type Agent,
	type Message,
	type Source,
	type Transcript,
} from './types.ts';

type SourceFilter = { agent?: Agent; source?: string };
type PageOptions = { limit: number; offset: number };
type SessionOptions = SourceFilter &
	PageOptions & {
		project?: string;
		session?: string;
		include_history?: boolean;
	};
type SearchOptions = SessionOptions & {
	kind?: string;
	after?: string;
	before?: string;
};
export type QueryOptions = SearchOptions & { context: number };

export type SourceRecord = {
	source_id: string;
	agent: Agent;
	root: string;
	status: string;
	checked_at: string | null;
};
export type SourceSummary = SourceRecord & { session_count: number };
export type Coverage = {
	indexed_sessions: number;
	source_statuses: { status: string; count: number }[];
	freshness: 'last_explicit_sync';
};
type Provenance = Pick<
	SourceRecord,
	'source_id' | 'agent' | 'root'
> & {
	session_id: string;
	source_status: string;
	source_checked_at: string | null;
	source_path: string;
	path_status: string;
	project: string;
	title: string | null;
	parent_session: string | null;
	indexed_at: string;
	unindexed_records: number;
};
export type SessionRecord = Provenance & {
	native_id: string;
	archive_id: string;
	hash: string;
	parser_version: number;
	timestamp: string;
	recorded_path: string;
};
export type ArchivedMessage = Omit<Message, 'active'> & {
	rowid: number;
	archive_id: string;
	active: 0 | 1;
	content_truncated: 0 | 1;
};
export type LocatedMessage = ArchivedMessage & Provenance;
export type SearchMatch = LocatedMessage & {
	snippet: string;
	char_offset: number;
	relevance: number;
};
export type MessageContext = {
	before: ArchivedMessage[];
	after: ArchivedMessage[];
	branch_boundary: boolean;
};

function source_parameters(options: SourceFilter) {
	return {
		agent: options.agent ?? null,
		source: options.source ?? null,
	};
}
function session_parameters(options: SessionOptions) {
	return {
		...source_parameters(options),
		project: options.project ?? null,
		session: options.session ?? null,
		include_history: Number(Boolean(options.include_history)),
		limit: options.limit + 1,
		offset: options.offset,
	};
}

export class Archive {
	#db: DatabaseSync;
	#statements = new Map<string, StatementSync>();
	#in_transaction = false;

	constructor(path: string, read_only = false) {
		const existed = path !== ':memory:' && existsSync(path);
		if (!read_only && path !== ':memory:')
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new DatabaseSync(path, { readOnly: read_only });
		try {
			this.#db.exec(
				'PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;',
			);
			apply_schema(this.#db, { read_only, allow_create: !existed });
			if (!read_only && path !== ':memory:') chmodSync(path, 0o600);
		} catch (error) {
			this.close();
			throw error;
		}
	}

	#statement(query: string): StatementSync {
		let statement = this.#statements.get(query);
		if (!statement) {
			statement = this.#db.prepare(query);
			this.#statements.set(query, statement);
		}
		return statement;
	}

	#transaction<T>(fn: () => T): T {
		if (this.#in_transaction) return fn();
		this.#db.exec('BEGIN IMMEDIATE');
		this.#in_transaction = true;
		try {
			const result = fn();
			this.#db.exec('COMMIT');
			return result;
		} catch (error) {
			this.#db.exec('ROLLBACK');
			throw error;
		} finally {
			this.#in_transaction = false;
		}
	}

	atomic<T>(fn: () => T): T {
		return this.#transaction(fn);
	}

	close() {
		this.#statements.clear();
		this.#db.close();
	}

	register(source: Source, status: string) {
		this.#statement(sql.register_source).run({
			...source,
			status,
			checked_at: new Date().toISOString(),
		});
	}

	source(source_id: string): SourceRecord | undefined {
		return this.#statement(sql.get_source).get({ source_id }) as
			| SourceRecord
			| undefined;
	}

	coverage(options: SourceFilter = {}): Coverage {
		const parameters = source_parameters(options);
		const counts = this.#statement(sql.indexed_sessions).get(
			parameters,
		) as { indexed_sessions: number };
		const statuses = this.#statement(sql.source_statuses).all(
			parameters,
		) as Coverage['source_statuses'];
		return {
			indexed_sessions: counts.indexed_sessions,
			source_statuses: statuses,
			freshness: 'last_explicit_sync',
		};
	}

	reconcile_paths(source: Source, seen: ReadonlySet<string>) {
		this.#transaction(() => {
			const paths = this.#statement(sql.source_paths).all({
				source_id: source.source_id,
			}) as { path: string }[];
			for (const { path } of paths)
				if (!seen.has(path))
					this.path_status(source, path, 'missing');
		});
	}

	cached(
		source: Source,
		key: string,
		signature: string,
	): SyncCache | undefined {
		const row = this.#statement(
			'SELECT data FROM sync_cache WHERE source_id=? AND unit_key=? AND signature=?',
		).get(source.source_id, key, signature);
		if (!row) return;
		const cache = parse_cache(String(row.data));
		if (!cache || !cache.sessions.length || !cache.inputs.length)
			return;
		for (const session of cache.sessions) {
			const current = this.#statement(
				'SELECT archive_id FROM sessions WHERE session_id=? AND source_id=?',
			).get(session.session_id, source.source_id);
			if (current?.archive_id !== session.archive_id) return;
		}
		return cache;
	}
	cache(
		source: Source,
		key: string,
		signature: string,
		data: SyncCache,
	) {
		this.#statement(
			'INSERT INTO sync_cache VALUES(?,?,?,?) ON CONFLICT(source_id,unit_key) DO UPDATE SET signature=excluded.signature,data=excluded.data',
		).run(source.source_id, key, signature, JSON.stringify(data));
	}
	refresh_cached(source: Source, cache: SyncCache) {
		for (const input of cache.inputs)
			this.path_status(
				source,
				input.path,
				input.partial ? 'partial' : 'available',
			);
	}

	checkpoint(source: Source, key: string): SyncCache | undefined {
		const row = this.#statement(
			'SELECT data FROM sync_cache WHERE source_id=? AND unit_key=?',
		).get(source.source_id, key);
		return row ? parse_cache(String(row.data)) : undefined;
	}
	record_lines(
		archive_id: string,
	): import('./types.ts').RecordLine[] {
		return this.#statement(
			'SELECT raw_json,source_order FROM records WHERE archive_id=? ORDER BY source_order',
		)
			.all(archive_id)
			.map((row) => ({
				value: JSON.parse(String(row.raw_json)),
				raw_json: String(row.raw_json),
				byte_offset: Number(row.source_order),
			}));
	}

	store(
		source: Source,
		path: string,
		transcript: Transcript,
		snapshot: {
			hash: string;
			byte_offset: number;
			partial: boolean;
			parser_version?: number;
			inputs?: import('./types.ts').ImportInput[];
			append?: boolean;
		},
		_refresh_title = false,
	) {
		const version = snapshot.parser_version ?? parser_version;
		const session_id = `${source.source_id}:${encodeURIComponent(transcript.session_key ?? transcript.native_id)}`;
		const archive_id = digest(session_id);
		const indexed_at = new Date().toISOString();
		return this.#transaction(() => {
			const known = this.#statement(
				'SELECT hash,parser_version FROM sessions WHERE archive_id=?',
			).get(archive_id);
			const changed =
				known?.hash !== snapshot.hash ||
				known?.parser_version !== version;
			this.#statement(sql.store_session).run({
				archive_id,
				session_id,
				source_id: source.source_id,
				native_id: transcript.native_id,
				hash: snapshot.hash,
				parser_version: version,
				project: transcript.project,
				title: transcript.title,
				parent_session: transcript.parent_session,
				timestamp: transcript.timestamp,
				indexed_at,
				unindexed_records: transcript.unindexed_records,
				recorded_path: path,
			});
			if (changed) {
				this.#statement('DELETE FROM links WHERE archive_id=?').run(
					archive_id,
				);
				if (!snapshot.append) {
					this.#statement('DELETE FROM parts WHERE archive_id=?').run(
						archive_id,
					);
					this.#statement(
						'DELETE FROM records WHERE archive_id=?',
					).run(archive_id);
				}

				const stored_keys = snapshot.append
					? new Set(
							this.#statement(
								'SELECT record_key FROM records WHERE archive_id=?',
							)
								.all(archive_id)
								.map((row) => String(row.record_key)),
						)
					: new Set<string>();
				for (const record of transcript.records ?? []) {
					if (stored_keys.has(record.key)) continue;
					this.#statement(
						'INSERT INTO records VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(archive_id,record_key) DO NOTHING',
					).run(
						archive_id,
						record.key,
						record.native_id,
						record.native_type,
						record.timestamp,
						record.source_order,
						record.raw_json,
						record.input_path ?? path,
					);
				}
				for (const link of transcript.links ?? [])
					this.#statement(
						'INSERT OR IGNORE INTO links VALUES(?,?,?,?,?)',
					).run(
						archive_id,
						link.record_key,
						link.kind,
						link.namespace,
						link.target,
					);
				if (snapshot.append) {
					const ids = new Set(
						[...transcript.messages, ...(transcript.parts ?? [])].map(
							(m) => m.native_id,
						),
					);
					for (const row of this.#statement(
						'SELECT native_id FROM parts WHERE archive_id=?',
					).all(archive_id))
						if (!ids.has(String(row.native_id)))
							this.#statement(
								'DELETE FROM parts WHERE archive_id=? AND native_id=?',
							).run(archive_id, row.native_id);
				}

				const insert_message = this.#statement(sql.insert_message);
				for (const message of [
					...transcript.messages,
					...(transcript.parts ?? []),
				])
					insert_message.run({
						...message,
						kind: message.kind ?? 'message',
						representation: message.representation ?? 'primary',
						state:
							message.state ??
							(message.active ? 'active' : 'inactive'),
						record_key: message.record_key ?? null,
						json_pointer: message.json_pointer ?? '',
						archive_id,
						active: Number(message.active),
					});
			}

			for (const input of snapshot.inputs ?? [
				{ path, ...snapshot },
			]) {
				this.#statement(sql.store_path).run({
					source_id: source.source_id,
					path: input.path,
					session_id,
					archive_id,
					status: input.partial ? 'partial' : 'available',
					byte_offset: input.byte_offset,
					parser_version: version,
					checked_at: indexed_at,
				});

				this.#statement(
					'INSERT INTO session_inputs VALUES(?,?,?,?,?) ON CONFLICT(archive_id,source_id,path) DO UPDATE SET fingerprint=excluded.fingerprint,byte_offset=excluded.byte_offset',
				).run(
					archive_id,
					source.source_id,
					input.path,
					input.hash,
					input.byte_offset,
				);
			}
			return { session_id, archive_id, added: changed };
		});
	}

	path_status(source: Source, path: string, status: string) {
		this.#statement(sql.path_status).run({
			source_id: source.source_id,
			path,
			status,
			checked_at: new Date().toISOString(),
		});
	}

	sources(options: SourceFilter & PageOptions): SourceSummary[] {
		return this.#statement(sql.sources).all({
			...source_parameters(options),
			limit: options.limit + 1,
			offset: options.offset,
		}) as SourceSummary[];
	}

	sessions(
		options: SessionOptions,
	): (SessionRecord & { first_record_ref: string | null })[] {
		const { include_history: _history, ...parameters } =
			session_parameters(options);
		const rows = this.#statement(sql.sessions).all(
			parameters,
		) as SessionRecord[];
		return rows.map((row) => {
			const first = this.#statement(
				'SELECT record_key FROM records WHERE archive_id=? ORDER BY source_order LIMIT 1',
			).get(row.archive_id);
			return {
				...row,
				first_record_ref: first
					? `r1.${row.archive_id}.${Buffer.from(String(first.record_key)).toString('base64url')}`
					: null,
			};
		});
	}

	search(query: string, options: SearchOptions): SearchMatch[] {
		// Quote each word so callers cannot inject FTS operators.
		const expression = query
			.trim()
			.split(/\s+/)
			.map((word) => `"${word.replaceAll('"', '""')}"`)
			.join(' AND ');
		return this.#statement(sql.search).all({
			...session_parameters(options),
			query: expression,
			kind: options.kind ?? null,
			after: options.after ?? null,
			before: options.before ?? null,
		}) as SearchMatch[];
	}

	recall(
		query: string,
		options: QueryOptions,
	): (SearchMatch & MessageContext)[] {
		return this.search(query, options).map((match) => ({
			...match,
			...this.context(
				match.archive_id,
				match.native_id,
				options.context,
			),
		}));
	}

	#message(
		archive_id: string,
		native_id: string,
	): ArchivedMessage | undefined {
		return this.#statement(sql.message).get({
			archive_id,
			native_id,
		}) as ArchivedMessage | undefined;
	}

	read_message(
		archive_id: string,
		native_id: string,
		char_offset: number,
		chars: number,
	) {
		return this.#statement(sql.read_message).get({
			archive_id,
			native_id,
			char_offset,
			chars,
		}) as (LocatedMessage & { content_length: number }) | undefined;
	}

	raw_record(
		archive_id: string,
		native_id: string,
		offset: number,
		chars: number,
		direct = false,
	) {
		return this.#statement(`SELECT substr(r.raw_json, $offset + 1, $chars) AS content,
    length(r.raw_json) AS content_length, r.record_key, r.native_type,
    (SELECT record_key FROM records WHERE archive_id=r.archive_id AND source_order<r.source_order ORDER BY source_order DESC LIMIT 1) AS previous_key,
    (SELECT record_key FROM records WHERE archive_id=r.archive_id AND source_order>r.source_order ORDER BY source_order LIMIT 1) AS next_key
    FROM records r WHERE r.archive_id=$archive_id AND r.record_key = ${direct ? '$native_id' : '(SELECT record_key FROM parts WHERE archive_id=$archive_id AND native_id=$native_id)'}`).get(
			{ archive_id, native_id, offset, chars },
		) as
			| {
					content: string;
					content_length: number;
					record_key: string;
					native_type: string | null;
					previous_key: string | null;
					next_key: string | null;
			  }
			| undefined;
	}
	record_links(archive_id: string, record_key: string) {
		return this.#statement(
			'SELECT kind, namespace, target FROM links WHERE archive_id=? AND record_key=? ORDER BY kind,namespace,target LIMIT 21',
		).all(archive_id, record_key);
	}

	context(
		archive_id: string,
		native_id: string,
		count: number,
	): MessageContext {
		const match = this.#message(archive_id, native_id);
		if (!match) throw new Error('Missing archived match');
		const before: ArchivedMessage[] = [];
		let cursor = match;
		for (let i = 0; i < count && cursor.parent_id; i++) {
			const parent = this.#message(archive_id, cursor.parent_id);
			if (!parent) break;
			before.unshift(parent);
			cursor = parent;
		}
		const after: ArchivedMessage[] = [];
		cursor = match;
		let branch_boundary = false;
		for (let i = 0; i < count; i++) {
			const children = this.#statement(sql.children).all({
				archive_id,
				parent_id: cursor.native_id,
				kind: cursor.kind ?? 'message',
				active: match.active,
			}) as ArchivedMessage[];
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
