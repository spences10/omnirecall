import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { digest, parser_version } from './files.ts';
import { sql } from './queries.ts';
import {
	InputError,
	type Agent,
	type Message,
	type Source,
	type Transcript,
} from './types.ts';

const application_id = 0x4f4d4e49;
const schema = readFileSync(
	new URL('./schema.sql', import.meta.url),
	'utf8',
);

type SourceFilter = { agent?: Agent; source?: string };
type PageOptions = { limit: number; offset: number };
type SessionOptions = SourceFilter &
	PageOptions & {
		project?: string;
		session?: string;
		include_history?: boolean;
	};
type SearchOptions = SessionOptions & {
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
	current_revision: 0 | 1;
	project: string;
	title: string | null;
	parent_session: string | null;
	indexed_at: string;
	omitted_records: number;
};
export type SessionRecord = Provenance & {
	native_id: string;
	revision_id: string;
	hash: string;
	parser_version: number;
	timestamp: string;
	recorded_path: string;
};
export type ArchivedMessage = Omit<Message, 'active'> & {
	rowid: number;
	revision_id: string;
	active: 0 | 1;
	content_truncated: 0 | 1;
};
export type SearchMatch = ArchivedMessage &
	Provenance & {
		snippet: string;
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

	constructor(path: string, read_only = false) {
		const existed = path !== ':memory:' && existsSync(path);
		if (!read_only && path !== ':memory:')
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.#db = new DatabaseSync(path, { readOnly: read_only });
		try {
			this.#db.exec(
				'PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;',
			);
			const id = this.#statement('PRAGMA application_id').get()
				?.application_id;
			if (id !== application_id) {
				if (existed || read_only)
					throw new InputError(
						'database',
						'Not an Omni Recall archive; refusing to modify it',
					);
				this.#transaction(() =>
					this.#db.exec(`
					${schema}
					PRAGMA application_id=${application_id};
					PRAGMA user_version=1;
				`),
				);
			}
			if (
				this.#statement('PRAGMA user_version').get()?.user_version !==
				1
			)
				throw new InputError(
					'database',
					'Unsupported archive schema',
				);
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
		this.#db.exec('BEGIN IMMEDIATE');
		try {
			const result = fn();
			this.#db.exec('COMMIT');
			return result;
		} catch (error) {
			this.#db.exec('ROLLBACK');
			throw error;
		}
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
		const indexed_at = new Date().toISOString();
		return this.#transaction(() => {
			const known = this.#statement(sql.find_revision).get({
				revision_id,
			});
			this.#statement(sql.select_revision).run({
				session_id,
				source_id: source.source_id,
				native_id: transcript.native_id,
				revision_id,
			});
			if (!known) {
				this.#statement(sql.insert_revision).run({
					revision_id,
					session_id,
					hash: snapshot.hash,
					parser_version,
					project: transcript.project,
					title: transcript.title,
					parent_session: transcript.parent_session,
					timestamp: transcript.timestamp,
					indexed_at,
					omitted_records: transcript.omitted_records,
					recorded_path: path,
				});
				const insert_message = this.#statement(sql.insert_message);
				for (const message of transcript.messages)
					insert_message.run({
						...message,
						revision_id,
						active: Number(message.active),
					});
			}
			if (refresh_title)
				this.#statement(sql.refresh_title).run({
					title: transcript.title,
					revision_id,
				});
			this.#statement(sql.store_path).run({
				source_id: source.source_id,
				path,
				session_id,
				revision_id,
				status: snapshot.partial ? 'partial' : 'available',
				byte_offset: snapshot.byte_offset,
				parser_version,
				checked_at: indexed_at,
			});
			return { session_id, revision_id, added: !known };
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

	sessions(options: SessionOptions): SessionRecord[] {
		return this.#statement(sql.sessions).all(
			session_parameters(options),
		) as SessionRecord[];
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
				match.revision_id,
				match.native_id,
				options.context,
			),
		}));
	}

	#message(
		revision_id: string,
		native_id: string,
	): ArchivedMessage | undefined {
		return this.#statement(sql.message).get({
			revision_id,
			native_id,
		}) as ArchivedMessage | undefined;
	}

	context(
		revision_id: string,
		native_id: string,
		count: number,
	): MessageContext {
		const match = this.#message(revision_id, native_id);
		if (!match) throw new Error('Missing archived match');
		const before: ArchivedMessage[] = [];
		let cursor = match;
		for (let i = 0; i < count && cursor.parent_id; i++) {
			const parent = this.#message(revision_id, cursor.parent_id);
			if (!parent) break;
			before.unshift(parent);
			cursor = parent;
		}
		const after: ArchivedMessage[] = [];
		cursor = match;
		let branch_boundary = false;
		for (let i = 0; i < count; i++) {
			const children = this.#statement(sql.children).all({
				revision_id,
				parent_id: cursor.native_id,
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
