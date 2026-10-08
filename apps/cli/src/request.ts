import { excerpt_chars } from '../../../packages/core/src/compact.ts';
import type { QueryOptions } from '../../../packages/core/src/database.ts';
import { source_config } from '../../../packages/core/src/files.ts';
import {
	is_short_ref,
	parse_ref,
} from '../../../packages/core/src/refs.ts';
import {
	InputError,
	type Source,
} from '../../../packages/core/src/types.ts';
import { agents } from './agents.ts';

export type Args = Record<string, unknown>;

export function integer(
	value: unknown,
	fallback: number,
	min: number,
	max: number,
): number {
	if (value === undefined) return fallback;
	if (
		typeof value !== 'string' ||
		!/^\d+$/.test(value) ||
		Number(value) < min ||
		Number(value) > max
	)
		throw new InputError(
			'arguments',
			`Expected an integer between ${min} and ${max}`,
		);
	return Number(value);
}
function optional(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}
function date_filter(
	value: unknown,
	upper_bound = false,
): string | undefined {
	if (value === undefined) return undefined;
	const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
	if (!Number.isFinite(parsed))
		throw new InputError('arguments', 'Invalid date filter');
	const date = new Date(parsed);
	if (
		upper_bound &&
		typeof value === 'string' &&
		/^\d{4}-\d{2}-\d{2}$/.test(value)
	)
		date.setUTCHours(23, 59, 59, 999);
	return date.toISOString();
}
function reject(message: string): never {
	throw new InputError('arguments', message);
}

/** Decided before validation, so an argument error uses the same schema. */
export function output_mode(name: string, args: Args) {
	const compact =
		['read', 'outline', 'evidence'].includes(name) ||
		(['search', 'recall', 'sessions'].includes(name) && !args.full);
	return {
		compact,
		schema_version: compact
			? name === 'read' && args.full
				? 2
				: 3
			: 1,
		max_bytes: compact ? 8192 : 65536,
	};
}

/** Validate one command's arguments. Checks run in a fixed order. */
export function parse_request(
	name: string,
	args: Args,
	compact: boolean,
) {
	const searches = name === 'search' || name === 'recall';
	const lists = searches || name === 'sessions';
	const by_ref = name === 'read' || name === 'evidence';

	if (
		(args.full && !lists && name !== 'read') ||
		(args.compact && !lists) ||
		(args.full && args.compact)
	)
		reject(
			'--full applies to search/recall/sessions/read; --compact applies to search/recall/sessions; choose one',
		);
	if (args['by-session'] && (name !== 'search' || args.full))
		reject('--by-session applies to compact search only');
	if (
		name !== 'read' &&
		(args['char-offset'] !== undefined || args.chars !== undefined)
	)
		reject('--char-offset and --chars apply to read only');
	if (
		name === 'read' &&
		[
			'agent',
			'source',
			'project',
			'session',
			'title',
			'include-history',
			'limit',
			'offset',
		].some((key) => args[key] !== undefined && args[key] !== false)
	)
		reject(
			'read uses an exact archived reference; filters and result pagination do not apply',
		);
	const char_offset = integer(args['char-offset'], 0, 0, 67108864);
	const chars = integer(args.chars, excerpt_chars, 1, 2000);
	const agent = optional(args.agent);
	if (
		agent !== undefined &&
		!agents.some((known) => known.agent === agent)
	)
		reject('--agent must be pi, codex, claude, or opencode');
	if (args.raw && name !== 'read')
		reject('--raw applies to read only');
	if (args.raw && args.context !== undefined)
		reject('--raw does not accept context');
	if (args.kind && !searches)
		reject('--kind applies to search/recall only');
	if (args.title !== undefined && !lists)
		reject('Title filters apply to sessions/search/recall only');

	const options: QueryOptions = {
		kind:
			args.kind === 'all'
				? undefined
				: (optional(args.kind) ?? 'message'),
		agent,
		source: optional(args.source),
		project: optional(args.project),
		session: optional(args.session),
		title: optional(args.title),
		after: date_filter(args.after),
		before: date_filter(args.before, true),
		include_history: Boolean(args['include-history']),
		limit: integer(
			args.limit,
			['outline', 'evidence'].includes(name)
				? 50
				: compact && name !== 'sessions'
					? 5
					: 10,
			1,
			100,
		),
		offset: integer(args.offset, 0, 0, 1000000),
		context: integer(
			args.context,
			name === 'read' ? (args.full ? 1 : 0) : compact ? 1 : 2,
			0,
			10,
		),
	};
	if (options.title !== undefined && !options.title.trim())
		reject('Title filter must not be empty');
	if (options.session !== undefined && !options.session.trim())
		reject('Session identifier must not be empty');
	if (
		options.after &&
		options.before &&
		options.after > options.before
	)
		reject('--after must not exceed --before');
	if (!lists && (options.after || options.before))
		reject('Date filters apply to sessions/search/recall only');

	const sources: Source[] = [];
	for (const { agent, root_flag } of agents) {
		const root = optional(args[root_flag]);
		if (root) sources.push(source_config(agent, root));
	}
	if (sources.length && name !== 'sources' && name !== 'sync')
		reject(
			'Root flags apply to sources/sync; queries use --source instead',
		);
	const scoped =
		options.project ||
		options.title ||
		options.session ||
		options.include_history;
	if (name === 'sources' && scoped)
		reject('sources supports agent/source filters only');
	if (name === 'sync' && scoped)
		reject(
			'sync operates on whole source roots, not project/session/history filters',
		);

	const query = optional(args.query)?.trim();
	if (by_ref && !is_short_ref(query ?? '')) parse_ref(query ?? '');
	if (name === 'outline' && !query)
		reject(
			'Provide a session identifier; copy short_id from sessions or search --by-session',
		);
	if (searches && (!query || query.length > 1000))
		reject('Provide a query of 1–1000 characters');
	if (args.verbose && name !== 'sync')
		reject('--verbose applies to sync only');

	/** Apply the --agent and --source filters to a source root. */
	const selects = (source: Source) =>
		(!agent || source.agent === agent) &&
		(!options.source || source.source_id === options.source);
	return {
		options,
		// Present for every command that requires one, as checked above.
		query: query!,
		char_offset,
		chars,
		explicit_roots: sources.length > 0,
		sources: sources.filter(selects),
		selects,
	};
}
export type Request = ReturnType<typeof parse_request>;
