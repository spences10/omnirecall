import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import {
	compact_outline,
	compact_recall,
	compact_search,
	compact_session_matches,
	compact_sessions,
} from '../../../packages/core/src/compact.ts';
import type { Archive } from '../../../packages/core/src/database.ts';
import {
	focused_read,
	raw_read,
	slim_read,
	turn_evidence,
} from '../../../packages/core/src/read.ts';
import {
	error_code,
	sync,
	type SyncProgress,
} from '../../../packages/core/src/sync.ts';
import {
	InputError,
	type Source,
} from '../../../packages/core/src/types.ts';
import { agents } from './agents.ts';
import type { Args, Request } from './request.ts';
import { automatic_sources } from './sources.ts';

export type Context = {
	name: string;
	args: Args;
	archive: Archive | undefined;
	request: Request;
	compact: boolean;
};
type Result = Record<string, unknown>;

/** Queries fetch one row beyond the limit to detect a further page. */
function page<T>(
	rows: T[],
	{ limit, offset }: { limit: number; offset: number },
) {
	const has_more = rows.length > limit;
	const results = rows.slice(0, limit);
	return {
		results,
		offset,
		returned_count: results.length,
		has_more,
		next_offset: has_more ? offset + results.length : null,
		truncated: has_more,
	};
}

function indexed(
	archive: Archive | undefined,
	action: string,
): Archive {
	if (!archive)
		throw new InputError(
			'unindexed',
			`Archive does not exist; sync sources before ${action}`,
		);
	return archive;
}

export async function run_sync(
	archive: Archive,
	request: Request,
	on_progress?: (progress: SyncProgress) => void,
) {
	const selected = request.explicit_roots
		? request.sources
		: (await automatic_sources(archive)).filter(request.selects);
	const result: Awaited<ReturnType<typeof sync>> & {
		message?: string;
		sources_selected?: number;
	} = await sync(
		archive,
		selected,
		agents.map(({ adapter }) => adapter),
		on_progress,
	);
	if (!selected.length) {
		result.status = 'empty';
		result.message =
			'No available or configured sources match. Use root flags to add a custom location.';
	}
	result.sources_selected = selected.length;
	if (result.status === 'partial') process.exitCode = 2;
	else if (result.status === 'error') process.exitCode = 1;
	return result;
}

function run_outline({ archive, request }: Context): Result {
	const { options, query } = request;
	const outline = indexed(archive, 'outlining a session').outline(
		query,
		options,
	);
	const { results: rows, ...paging } = page(outline.rows, options);
	return {
		status: 'ok',
		format: 'compact',
		...compact_outline({ ...outline, rows }),
		...paging,
	};
}

function run_evidence({ archive, request }: Context): Result {
	const { options, query } = request;
	const { turn, rows } = turn_evidence(
		indexed(archive, 'reading a reference'),
		query,
		options.limit,
		options.offset,
	);
	const paged = page(rows, options);
	return {
		status: paged.results.length ? 'ok' : 'empty',
		format: 'compact',
		turn,
		...paged,
	};
}

function run_read({ args, archive, request }: Context): Result {
	const { options, query, char_offset, chars } = request;
	const found = indexed(archive, 'reading a reference');
	const read =
		args.raw || query.startsWith('r')
			? raw_read(found, query, char_offset, chars)
			: focused_read(
					found,
					query,
					options.context,
					char_offset,
					chars,
				);
	return {
		status: 'ok',
		format: 'compact',
		...(args.full ? read : slim_read(found, read)),
		offset: 0,
		returned_count: 1,
		has_more: false,
		next_offset: null,
		truncated: false,
	};
}

/** Explicit roots as they are now, beside what the archive last recorded. */
async function live_sources(
	sources: Source[],
	archive: Archive | undefined,
) {
	const rows: object[] = [];
	for (const source of sources) {
		let live_status = 'available';
		try {
			await access(source.root, constants.R_OK | constants.X_OK);
			if (!(await stat(source.root)).isDirectory())
				live_status = 'unsupported';
		} catch (error) {
			live_status = error_code(error);
		}
		const stored = archive?.source(source.source_id);
		rows.push({
			...source,
			archive_status: stored?.status ?? 'unindexed',
			live_status,
			checked_at: stored?.checked_at ?? null,
		});
	}
	return rows;
}

/** sources, sessions, search and recall: paged rows with archive coverage. */
async function run_list({
	name,
	args,
	archive,
	request,
	compact,
}: Context): Promise<Result> {
	const { options, query } = request;
	let rows: object[] = [];
	let shared: Result =
		compact && name === 'recall' ? { messages: [] } : {};
	if (name === 'sources' && request.sources.length) {
		rows = (await live_sources(request.sources, archive)).slice(
			options.offset,
			options.offset + options.limit + 1,
		);
	} else if (archive) {
		if (name === 'sources') rows = archive.sources(options);
		else if (name === 'sessions') {
			const sessions = archive.sessions(options);
			rows = compact ? compact_sessions(sessions) : sessions;
		} else if (name === 'recall') {
			const matches = archive.recall(query, options);
			if (compact) {
				const response = compact_recall(matches);
				rows = response.results;
				shared = { messages: response.messages };
			} else rows = matches;
		} else if (args['by-session']) {
			rows = compact_session_matches(
				archive.search_sessions(query, options),
			);
		} else {
			const matches = archive.search(query, options);
			rows = compact ? compact_search(matches) : matches;
		}
	}
	const paged = page(rows, options);
	const coverage = archive?.coverage(options) ?? {
		indexed_sessions: 0,
		source_statuses: [],
		freshness: 'last_explicit_sync',
	};
	return {
		...(compact ? { format: 'compact' } : {}),
		...shared,
		coverage,
		status:
			!archive || (name !== 'sources' && !coverage.indexed_sessions)
				? 'unindexed'
				: paged.results.length
					? 'ok'
					: 'empty',
		...paged,
	};
}

const handlers: Record<
	string,
	(context: Context) => Result | Promise<Result>
> = {
	outline: run_outline,
	evidence: run_evidence,
	read: run_read,
};

/** Run any command other than sync. */
export async function run_query(context: Context): Promise<Result> {
	return (handlers[context.name] ?? run_list)(context);
}
