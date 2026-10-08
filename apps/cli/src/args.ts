import { agent_list, agents } from './agents.ts';

const descriptions: Record<string, string> = {
	sources:
		'Inspect archive coverage and last sync times; retrieval never syncs automatically',
	sync: 'Import session evidence; inspect partial status and issue_counts before retrieval',
	search:
		'Search conversation messages; --by-session lists matching sessions first; then read a result ref',
	recall:
		'Search with bounded context; compact by default, --full for detailed rows',
	sessions:
		'List sessions with short_id for scoped searches; compact by default, --full for all metadata',
	outline:
		"List one session's user prompts and summaries with refs; then read a ref",
	evidence:
		'List tool calls, results and operations in the turn containing a message ref',
	read: 'Read one message by ref; --context adds neighbours, --full adds provenance; follow next_char_offset',
};

const root_flags = agents.map(({ root_flag }) => root_flag);
const root_args = Object.fromEntries(
	agents.map(({ root_flag, root_help }) => [
		root_flag,
		{ type: 'string', description: root_help },
	]),
) as Record<string, { type: 'string'; description: string }>;

const command_options: Record<string, string[]> = {
	sources: [...root_flags, 'agent', 'source', 'limit', 'offset'],
	sync: [...root_flags, 'agent', 'source', 'verbose'],
	search: [
		'query',
		'agent',
		'source',
		'project',
		'session',
		'title',
		'kind',
		'after',
		'before',
		'include-history',
		'limit',
		'offset',
		'full',
		'compact',
		'by-session',
		'context',
	],
	recall: [
		'query',
		'agent',
		'source',
		'project',
		'session',
		'title',
		'kind',
		'after',
		'before',
		'include-history',
		'limit',
		'offset',
		'full',
		'compact',
		'context',
	],
	sessions: [
		'agent',
		'source',
		'project',
		'session',
		'title',
		'after',
		'before',
		'limit',
		'offset',
		'include-history',
		'full',
		'compact',
	],
	outline: ['query', 'include-history', 'limit', 'offset'],
	evidence: ['query', 'limit', 'offset'],
	read: ['query', 'raw', 'chars', 'char-offset', 'context', 'full'],
};

/** Flags every command accepts, whatever its own option list. */
const shared_options = ['json', 'db', 'max-bytes'];

function all_args(name: string) {
	return {
		json: { type: 'boolean', description: 'Machine-readable JSON' },
		verbose: {
			type: 'boolean',
			description: 'Sync: show individual issue paths and errors',
		},
		full: {
			type: 'boolean',
			description:
				'Search/recall/sessions: detailed schema v1 rows; read: full provenance (schema v2)',
		},
		'by-session': {
			type: 'boolean',
			description:
				'Search: one row per matching session with hit count and best snippet; narrow with --session <short_id>',
		},
		compact: {
			type: 'boolean',
			description:
				'Search/recall/sessions: compact schema v3 output with shared metadata',
		},
		'char-offset': {
			type: 'string',
			description:
				'Read: Unicode offset within a part/raw record; use next_char_offset to continue',
		},
		chars: {
			type: 'string',
			description:
				'Read: characters per message, 1–2000 (default 1200)',
		},
		query: {
			type: 'positional',
			required: false,
			description:
				name === 'read' || name === 'evidence'
					? 'Exact ref copied from search, recall or outline'
					: name === 'outline'
						? 'Session short_id, session ID, archive ID or unique prefix'
						: 'FTS5 query: words use AND; "source path", sqlite OR database, migrat*, (a OR b) NOT c. Package/path punctuation (- . / @) is quoted automatically.',
		},
		db: {
			type: 'string',
			description:
				'Archive path; use the same --db for sync and retrieval',
		},
		...root_args,
		raw: {
			type: 'boolean',
			description:
				'Read: original JSON fragments; no --context; follow next_char_offset or previous_ref/next_ref',
		},
		kind: {
			type: 'string',
			description:
				'Evidence kind: message (default), all, reasoning, tool_call, tool_result, summary, operation, context, review_context',
		},
		agent: {
			type: 'string',
			description: `Authoring agent: ${agent_list} (not the caller)`,
		},
		source: {
			type: 'string',
			description: 'Exact source-qualified source ID',
		},
		project: {
			type: 'string',
			description: 'Exact transcript project path',
		},
		session: {
			type: 'string',
			description:
				'Session ID, archive ID, or unique native/archive prefix; copy short_id from sessions',
		},
		title: {
			type: 'string',
			description:
				'Literal session-title substring (ASCII case-insensitive)',
		},
		after: {
			type: 'string',
			description:
				'Inclusive date lower bound (session timestamp for sessions, message timestamp for search/recall); YYYY-MM-DD starts at midnight UTC',
		},
		before: {
			type: 'string',
			description:
				'Inclusive date upper bound (session timestamp for sessions, message timestamp for search/recall); YYYY-MM-DD includes the whole UTC day',
		},
		'include-history': {
			type: 'boolean',
			description:
				'Include inactive branches and alternative representations',
		},
		limit: {
			type: 'string',
			description:
				'Maximum results, 1–100 (compact default 5; detailed and sessions 10; outline/evidence 50)',
		},
		offset: {
			type: 'string',
			description:
				'Result offset, 0–1000000; use next_offset with the same query/filters',
		},
		context: {
			type: 'string',
			description:
				'Recall/read messages per side, 0–10 (recall: compact default 1, detailed 2; read: default 0, 1 with --full)',
		},
		'max-bytes': {
			type: 'string',
			description:
				'JSON bytes, 1024–1048576 (defaults 8192 compact/65536 detailed); on output_budget_exceeded, increase or reduce requested content',
		},
	} as const;
}

/** Command metadata and only the flags that apply to it. */
export function command_definition(name: string) {
	const available = all_args(name);
	return {
		meta: { name, description: descriptions[name] },
		args: Object.fromEntries(
			Object.entries(available).filter(
				([key]) =>
					shared_options.includes(key) ||
					command_options[name]!.includes(key),
			),
		) as typeof available,
	};
}
