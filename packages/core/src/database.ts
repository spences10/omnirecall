import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { InputError } from './errors.ts';
import { digest, parser_version } from './files.ts';
import { sql } from './queries.ts';
import { all_parts } from './readers.ts';
import { record_ref } from './refs.ts';
import { apply_schema } from './schema.ts';
import { search_expression } from './search-query.ts';
import { parse_cache, type SyncCache } from './sync-cache.ts';
import type {
	Agent,
	ImportInput,
	Message,
	RecordLine,
	Source,
	Transcript,
} from './types.ts';

type SourceFilter = { agent?: Agent; source?: string };
type PageOptions = { limit: number; offset: number };
type SessionScope = SourceFilter & { project?: string };
type SessionOptions = SessionScope &
	PageOptions & {
		session?: string;
		title?: string;
		after?: string;
		before?: string;
		include_history?: boolean;
	};
type SearchOptions = SessionOptions & { kind?: string };
type SessionCandidate = {
	session_id: string;
	archive_id: string;
	exact: 0 | 1;
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
export type SessionMatch = SearchMatch & {
	short_id: string;
	hits: number;
	last_hit: string | null;
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
		const row = this.#statement(sql.cached_unit).get(
			source.source_id,
			key,
			signature,
		);
		if (!row) return;
		const cache = parse_cache(String(row.data));
		if (!cache || !cache.sessions.length || !cache.inputs.length)
			return;
		for (const session of cache.sessions) {
			const current = this.#statement(sql.session_archive_id).get(
				session.session_id,
				source.source_id,
			);
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
		this.#statement(sql.store_cache).run(
			source.source_id,
			key,
			signature,
			JSON.stringify(data),
		);
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
		const row = this.#statement(sql.checkpoint).get(
			source.source_id,
			key,
		);
		return row ? parse_cache(String(row.data)) : undefined;
	}
	record_lines(archive_id: string): RecordLine[] {
		return this.#statement(sql.record_lines)
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
			inputs?: ImportInput[];
			append?: boolean;
		},
	) {
		const version = snapshot.parser_version ?? parser_version;
		const session_id = `${source.source_id}:${encodeURIComponent(transcript.session_key ?? transcript.native_id)}`;
		const archive_id = digest(session_id);
		const indexed_at = new Date().toISOString();
		return this.#transaction(() => {
			const known = this.#statement(sql.session_version).get(
				archive_id,
			);
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
				this.#statement(sql.delete_links).run(archive_id);
				if (!snapshot.append) {
					this.#statement(sql.delete_parts).run(archive_id);
					this.#statement(sql.delete_records).run(archive_id);
				}

				const stored_keys = snapshot.append
					? new Set(
							this.#statement(sql.record_keys)
								.all(archive_id)
								.map((row) => String(row.record_key)),
						)
					: new Set<string>();
				for (const record of transcript.records ?? []) {
					if (stored_keys.has(record.key)) continue;
					this.#statement(sql.insert_record).run(
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
					this.#statement(sql.insert_link).run(
						archive_id,
						link.record_key,
						link.kind,
						link.namespace,
						link.target,
					);
				if (snapshot.append) {
					const ids = new Set(
						all_parts(transcript).map((m) => m.native_id),
					);
					for (const row of this.#statement(sql.part_ids).all(
						archive_id,
					))
						if (!ids.has(String(row.native_id)))
							this.#statement(sql.delete_part).run(
								archive_id,
								row.native_id,
							);
				}

				const insert_message = this.#statement(sql.insert_message);
				for (const message of all_parts(transcript))
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

				this.#statement(sql.store_input).run(
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

	#session_candidates(session: string, scope: SessionScope = {}) {
		return this.#statement(sql.session_candidates).all({
			...source_parameters(scope),
			project: scope.project ?? null,
			session,
		}) as SessionCandidate[];
	}

	#resolve_session(options: SessionOptions) {
		const selector = options.session;
		if (selector === undefined) return null;
		if (!selector.trim())
			throw new InputError(
				'arguments',
				'Session identifier must not be empty',
			);
		const [first, second] = this.#session_candidates(
			selector,
			options,
		);
		if (first && second && first.exact === second.exact)
			throw new InputError(
				'arguments',
				'Ambiguous session identifier; use a longer unique prefix, an exact session_id/archive_id, or narrow --agent, --source or --project',
			);
		// Preserve empty-result semantics for an unmatched session filter.
		return first?.session_id ?? selector;
	}

	#session_parameters(options: SessionOptions) {
		return {
			...source_parameters(options),
			project: options.project ?? null,
			session: this.#resolve_session(options),
			title: options.title ?? null,
			after: options.after ?? null,
			before: options.before ?? null,
			include_history: Number(Boolean(options.include_history)),
			limit: options.limit + 1,
			offset: options.offset,
		};
	}

	archive_ids(prefix: string) {
		return (
			this.#statement(sql.archive_ids).all(prefix, prefix) as {
				archive_id: string;
			}[]
		).map((row) => row.archive_id);
	}

	part_ids(archive_id: string) {
		return (
			this.#statement(sql.part_ids).all(archive_id) as {
				native_id: string;
			}[]
		).map((row) => row.native_id);
	}

	/** Shortest archive-ID prefix (12+ characters) unique in this archive. */
	short_id(archive_id: string) {
		// Check the whole archive, not just the displayed page or active filters.
		for (let length = 12; length < archive_id.length; length++) {
			const prefix = archive_id.slice(0, length);
			if (this.#session_candidates(prefix).length === 1)
				return prefix;
		}
		return archive_id;
	}

	sessions(options: SessionOptions): (SessionRecord & {
		short_id: string;
		first_record_ref: string | null;
	})[] {
		const { include_history: _history, ...parameters } =
			this.#session_parameters(options);
		const rows = this.#statement(sql.sessions).all(
			parameters,
		) as SessionRecord[];
		return rows.map((row) => {
			const first = this.#statement(sql.first_record_key).get(
				row.archive_id,
			);
			return {
				...row,
				short_id: this.short_id(row.archive_id),
				first_record_ref: first
					? record_ref(row.archive_id, String(first.record_key))
					: null,
			};
		});
	}

	/** One session's user prompts and summaries, in source order. */
	outline(
		session: string,
		options: PageOptions & { include_history?: boolean },
	) {
		const [found] = this.sessions({ session, limit: 1, offset: 0 });
		if (!found)
			throw new InputError(
				'not_found',
				'Session not found in this archive; copy short_id from sessions or search --by-session',
			);
		const scope = {
			archive_id: found.archive_id,
			include_history: Number(Boolean(options.include_history)),
		};
		return {
			session: found,
			parts: Object.fromEntries(
				(
					this.#statement(sql.part_counts).all(scope) as {
						kind: string;
						count: number;
					}[]
				).map((row) => [row.kind, row.count]),
			),
			rows: this.#statement(sql.outline).all({
				...scope,
				limit: options.limit + 1,
				offset: options.offset,
			}) as ArchivedMessage[],
		};
	}

	/** Tool calls, results and operations in the turn containing a message. */
	evidence(
		archive_id: string,
		native_id: string,
		options: PageOptions,
	) {
		const target = this.#message(archive_id, native_id);
		if (!target) return undefined;
		const position = {
			archive_id,
			active: target.active,
			source_order: target.source_order,
		};
		const prompt = this.#statement(sql.turn_start).get(position) as
			| ArchivedMessage
			| undefined;
		const next_prompt = this.#statement(sql.turn_end).get(
			position,
		) as ArchivedMessage | undefined;
		return {
			prompt,
			next_prompt,
			rows: this.#statement(sql.turn_evidence).all({
				archive_id,
				active: target.active,
				start: prompt?.source_order ?? 0,
				end: next_prompt?.source_order ?? null,
				limit: options.limit + 1,
				offset: options.offset,
			}) as ArchivedMessage[],
		};
	}

	search(query: string, options: SearchOptions): SearchMatch[] {
		return this.#match(query, options, (parameters) =>
			this.#statement(sql.search).all(parameters),
		) as SearchMatch[];
	}

	/** Matching sessions, each with its best hit and hit count. */
	search_sessions(
		query: string,
		options: SearchOptions,
	): SessionMatch[] {
		return this.#match(query, options, (parameters) =>
			(
				this.#statement(sql.search_sessions).all(parameters) as {
					part: number;
					hits: number;
					last_hit: string | null;
				}[]
			).map(({ part, hits, last_hit }) => {
				const {
					limit: _limit,
					offset: _offset,
					...filters
				} = parameters;
				const hit = this.#statement(sql.search_hit).get({
					...filters,
					part,
				}) as SearchMatch;
				return {
					...hit,
					short_id: this.short_id(hit.archive_id),
					hits,
					last_hit,
				};
			}),
		);
	}

	#match<T>(
		query: string,
		options: SearchOptions,
		run: (parameters: Record<string, string | number | null>) => T,
	): T {
		const expression = search_expression(query);
		try {
			return run({
				...this.#session_parameters(options),
				query: expression,
				kind: options.kind ?? null,
			});
		} catch (error) {
			if (
				error instanceof Error &&
				/^(?:fts5: syntax error|unterminated string|no such column:|fts5: column queries are not supported)/.test(
					error.message,
				)
			) {
				throw new InputError(
					'arguments',
					'Invalid FTS5 query. Use balanced double quotes and parentheses, uppercase AND/OR/NOT, or a trailing * for prefixes. Package/path terms containing -, ., / or @ are quoted automatically; quote other punctuation explicitly. See search --help.',
				);
			}
			throw error;
		}
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
		return this.#statement(
			direct ? sql.raw_record : sql.raw_record_of_part,
		).get({ archive_id, native_id, offset, chars }) as
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
		return this.#statement(sql.record_links).all(
			archive_id,
			record_key,
		);
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
