import { defineCommand } from 'citty';
import { constants, existsSync, readFileSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { claude_adapter } from '../../../packages/adapter-claude/src/index.ts';
import { codex_adapter } from '../../../packages/adapter-codex/src/index.ts';
import { pi_adapter } from '../../../packages/adapter-pi/src/index.ts';
import {
	Archive,
	type QueryOptions,
} from '../../../packages/core/src/database.ts';
import { source_config } from '../../../packages/core/src/files.ts';
import { bounded_json } from '../../../packages/core/src/output.ts';
import {
	compact_recall,
	compact_search,
	excerpt_chars,
	focused_read,
	parse_ref,
	raw_read,
} from '../../../packages/core/src/retrieval.ts';
import { error_code, sync } from '../../../packages/core/src/sync.ts';
import {
	InputError,
	type Source,
} from '../../../packages/core/src/types.ts';
import { database_path } from './paths.ts';
import { guide } from './guide.ts';
import { sync_progress } from './progress.ts';
import { sync_summary } from './sync-output.ts';
import { automatic_sources } from './sources.ts';

const package_metadata = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };
const capabilities = [
	'guide',
	'sources',
	'sync',
	'search',
	'recall',
	'sessions',
	'read',
];
const info = defineCommand({
	meta: {
		name: 'info',
		description:
			'Show package information and supported capabilities',
	},
	args: {
		json: {
			type: 'boolean',
			description: 'Output machine-readable JSON',
		},
	},
	run({ args }) {
		const result = {
			schema_version: 1,
			name: package_metadata.name,
			version: package_metadata.version,
			status: 'preview',
			capabilities,
			agent_instructions:
				'Run omnirecall guide before retrieving session evidence.',
		};
		console.log(
			args.json
				? JSON.stringify(result)
				: `${result.name} v${result.version}\nPreview: Pi, Claude Code and Codex session evidence; durable local archive.\n${result.agent_instructions}`,
		);
	},
});

function integer(
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
function date_filter(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
	if (!Number.isFinite(parsed))
		throw new InputError('arguments', 'Invalid date filter');
	return new Date(parsed).toISOString();
}

const descriptions: Record<string, string> = {
	sources:
		'Inspect archive coverage and last sync times; run guide for the LLM workflow',
	sync: 'Import session evidence; inspect partial status and issue_counts before retrieval',
	search:
		'Find evidence with short ANDed terms; run guide for query refinement and verification',
	recall:
		'Search with bounded context; use --compact --json for LLM retrieval',
	sessions:
		'List session metadata and IDs for scoped searches and raw-record navigation',
	read: 'Expand an exact ref and verify context; follow next_char_offset for truncated content',
};

function command(name: string) {
	return defineCommand({
		meta: {
			name,
			description: descriptions[name],
		},
		args: {
			json: { type: 'boolean', description: 'Machine-readable JSON' },
			verbose: {
				type: 'boolean',
				description: 'Sync: show individual issue paths and errors',
			},
			full: {
				type: 'boolean',
				description: 'Search: return detailed schema v1 output',
			},
			compact: {
				type: 'boolean',
				description:
					'Search/recall: compact schema v2 output with shared context',
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
					name === 'read'
						? 'Exact ref copied from search or sessions'
						: 'Short terms ANDed within one part; no OR/phrase/prefix syntax (see guide)',
			},
			db: {
				type: 'string',
				description:
					'Archive path; use the same --db for sync and retrieval',
			},
			'pi-root': {
				type: 'string',
				description: 'Explicit Pi session tree root',
			},
			'claude-root': {
				type: 'string',
				description: 'Explicit Claude transcript tree root',
			},
			raw: {
				type: 'boolean',
				description:
					'Read: original JSON fragments; no --context; follow next_char_offset or previous_ref/next_ref',
			},
			kind: {
				type: 'string',
				description:
					'Search/recall: message, reasoning, tool_call, tool_result, summary, or operation',
			},
			'codex-root': {
				type: 'string',
				description: 'Explicit Codex JSONL tree root',
			},
			agent: {
				type: 'string',
				description:
					'Authoring agent: pi, codex, or claude (not the caller)',
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
				description: 'Exact session_id copied from sessions output',
			},
			after: {
				type: 'string',
				description: 'Inclusive message date lower bound',
			},
			before: {
				type: 'string',
				description: 'Inclusive message date upper bound',
			},
			'include-history': {
				type: 'boolean',
				description:
					'Include inactive branches and alternative representations',
			},
			limit: {
				type: 'string',
				description:
					'Maximum results, 1–100 (compact default 5; detailed 10)',
			},
			offset: {
				type: 'string',
				description:
					'Result offset, 0–1000000; use next_offset with the same query/filters',
			},
			context: {
				type: 'string',
				description:
					'Recall/read messages per side, 0–10 (compact default 1; detailed 2)',
			},
			'max-bytes': {
				type: 'string',
				description:
					'JSON bytes, 1024–1048576 (defaults 8192 compact/65536 detailed); on output_budget_exceeded, increase or reduce requested content',
			},
		},
		async run({ args }) {
			let archive: Archive | undefined;
			let progress: ReturnType<typeof sync_progress> | undefined;
			const compact =
				name === 'read' ||
				(name === 'search' && !args.full) ||
				(name === 'recall' && Boolean(args.compact));
			const schema_version = compact ? 2 : 1;
			let max_bytes = compact ? 8192 : 65536;
			try {
				max_bytes = integer(
					args['max-bytes'],
					max_bytes,
					1024,
					1048576,
				);
				if (
					(args.full && name !== 'search') ||
					(args.compact && !['search', 'recall'].includes(name)) ||
					(args.full && args.compact)
				)
					throw new InputError(
						'arguments',
						'--full applies to search; --compact applies to search/recall; choose one',
					);
				if (
					name !== 'read' &&
					(args['char-offset'] !== undefined ||
						args.chars !== undefined)
				)
					throw new InputError(
						'arguments',
						'--char-offset and --chars apply to read only',
					);
				if (
					name === 'read' &&
					[
						'agent',
						'source',
						'project',
						'session',
						'include-history',
						'limit',
						'offset',
					].some(
						(key) => args[key] !== undefined && args[key] !== false,
					)
				)
					throw new InputError(
						'arguments',
						'read uses an exact archived reference; filters and result pagination do not apply',
					);
				const char_offset = integer(
					args['char-offset'],
					0,
					0,
					67108864,
				);
				const chars = integer(args.chars, excerpt_chars, 1, 2000);
				const agent = optional(args.agent);
				if (
					agent !== undefined &&
					agent !== 'pi' &&
					agent !== 'codex' &&
					agent !== 'claude'
				)
					throw new InputError(
						'arguments',
						'--agent must be pi, codex, or claude',
					);
				if (args.raw && name !== 'read')
					throw new InputError(
						'arguments',
						'--raw applies to read only',
					);
				if (args.raw && args.context !== undefined)
					throw new InputError(
						'arguments',
						'--raw does not accept context',
					);
				if (args.kind && !['search', 'recall'].includes(name))
					throw new InputError(
						'arguments',
						'--kind applies to search/recall only',
					);
				const options: QueryOptions = {
					kind: optional(args.kind),
					agent,
					source: optional(args.source),
					project: optional(args.project),
					session: optional(args.session),
					after: date_filter(args.after),
					before: date_filter(args.before),
					include_history: Boolean(args['include-history']),
					limit: integer(args.limit, compact ? 5 : 10, 1, 100),
					offset: integer(args.offset, 0, 0, 1000000),
					context: integer(args.context, compact ? 1 : 2, 0, 10),
				};
				if (
					options.after &&
					options.before &&
					options.after > options.before
				)
					throw new InputError(
						'arguments',
						'--after must not exceed --before',
					);
				if (
					name !== 'search' &&
					name !== 'recall' &&
					(options.after || options.before)
				)
					throw new InputError(
						'arguments',
						'Date filters apply to search/recall only',
					);
				const sources: Source[] = [];
				if (args['claude-root'])
					sources.push(source_config('claude', args['claude-root']));
				if (args['pi-root'])
					sources.push(source_config('pi', args['pi-root']));
				if (args['codex-root'])
					sources.push(source_config('codex', args['codex-root']));
				if (sources.length && name !== 'sources' && name !== 'sync')
					throw new InputError(
						'arguments',
						'Root flags apply to sources/sync; queries use --source instead',
					);
				if (
					name === 'sources' &&
					(options.project ||
						options.session ||
						options.include_history)
				)
					throw new InputError(
						'arguments',
						'sources supports agent/source filters only',
					);
				let selected = sources.filter(
					(source) =>
						(!agent || source.agent === agent) &&
						(!options.source || source.source_id === options.source),
				);

				if (
					name === 'sync' &&
					(options.project ||
						options.session ||
						options.include_history)
				)
					throw new InputError(
						'arguments',
						'sync operates on whole source roots, not project/session/history filters',
					);
				const query = optional(args.query)?.trim();
				if (name === 'read') parse_ref(query ?? '');
				if (
					(name === 'search' || name === 'recall') &&
					(!query || query.length > 1000)
				)
					throw new InputError(
						'arguments',
						'Provide a query of 1–1000 characters',
					);
				if (args.verbose && name !== 'sync')
					throw new InputError(
						'arguments',
						'--verbose applies to sync only',
					);
				if (name === 'sync')
					progress = sync_progress(
						!args.json && Boolean(process.stderr.isTTY),
					);
				const db_path = database_path(args.db);
				if (name === 'sync' || existsSync(db_path))
					archive = new Archive(db_path, name !== 'sync');
				let result: Record<string, unknown>;
				let human_sync: string | undefined;
				if (name === 'sync') {
					if (!sources.length)
						selected = (await automatic_sources(archive!)).filter(
							(s) =>
								(!agent || s.agent === agent) &&
								(!options.source || s.source_id === options.source),
						);
					const synced = await sync(
						archive!,
						selected,
						[pi_adapter, codex_adapter, claude_adapter],
						progress?.update,
					);
					progress?.finish();
					result = synced;
					if (!selected.length) {
						result.status = 'empty';
						result.message =
							'No available or configured sources match. Use root flags to add a custom location.';
					}
					result.sources_selected = selected.length;
					if (!args.json)
						human_sync = sync_summary(
							{
								...synced,
								sources_selected: selected.length,
								message:
									typeof result.message === 'string'
										? result.message
										: undefined,
							},
							Boolean(args.verbose),
						);
					if (result.status === 'partial') process.exitCode = 2;
					else if (result.status === 'error') process.exitCode = 1;
				} else if (name === 'read') {
					if (!archive)
						throw new InputError(
							'unindexed',
							'Archive does not exist; sync sources before reading a reference',
						);
					result = {
						status: 'ok',
						format: 'compact',
						...(args.raw || query!.startsWith('r1.')
							? raw_read(archive, query!, char_offset, chars)
							: focused_read(
									archive,
									query!,
									options.context,
									char_offset,
									chars,
								)),
						offset: 0,
						returned_count: 1,
						has_more: false,
						next_offset: null,
						truncated: false,
					};
				} else {
					let rows: object[] = [];
					let shared: Record<string, unknown> =
						compact && name === 'recall' ? { messages: [] } : {};
					if (name === 'sources' && selected.length) {
						for (const source of selected) {
							let live_status = 'available';
							try {
								await access(
									source.root,
									constants.R_OK | constants.X_OK,
								);
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
						rows = rows.slice(
							options.offset,
							options.offset + options.limit + 1,
						);
					} else if (archive) {
						if (name === 'sources') rows = archive.sources(options);
						else if (name === 'sessions')
							rows = archive.sessions(options);
						else if (name === 'recall') {
							const matches = archive.recall(query!, options);
							if (compact) {
								const response = compact_recall(matches);
								rows = response.results;
								shared = { messages: response.messages };
							} else rows = matches;
						} else {
							const matches = archive.search(query!, options);
							rows = compact ? compact_search(matches) : matches;
						}
					}
					const has_more = rows.length > options.limit;
					rows = rows.slice(0, options.limit);
					const coverage = archive?.coverage(options) ?? {
						indexed_sessions: 0,
						source_statuses: [],
						freshness: 'last_explicit_sync',
					};
					result = {
						...(compact ? { format: 'compact' } : {}),
						...shared,
						coverage,
						status:
							!archive ||
							(name !== 'sources' && !coverage.indexed_sessions)
								? 'unindexed'
								: rows.length
									? 'ok'
									: 'empty',
						results: rows,
						offset: options.offset,
						returned_count: rows.length,
						has_more,
						next_offset: has_more
							? options.offset + rows.length
							: null,
						truncated: has_more,
					};
				}
				if (human_sync !== undefined) {
					console.log(human_sync);
					return;
				}
				const output = bounded_json(
					{ schema_version, ...result },
					max_bytes,
				);
				console.log(
					args.json
						? output
						: JSON.stringify(JSON.parse(output), null, 2),
				);
			} catch (error) {
				progress?.finish();
				process.exitCode = 1;
				if (name === 'sync' && !args.json) {
					console.error(
						`Sync failed: ${error instanceof Error ? error.message : 'Operation failed'}`,
					);
					return;
				}
				console.log(
					bounded_json(
						{
							schema_version,
							status: 'error',
							code: error_code(error),
							message:
								error instanceof Error
									? error.message
									: 'Operation failed',
							results: [],
						},
						max_bytes,
					),
				);
			} finally {
				progress?.finish();
				archive?.close();
			}
		},
	});
}

export const main = defineCommand({
	meta: {
		name: package_metadata.name,
		version: package_metadata.version,
		description:
			'Retrieve historical evidence for coding assistants. Start with: omnirecall guide',
	},
	subCommands: {
		info,
		guide,
		sources: command('sources'),
		sync: command('sync'),
		search: command('search'),
		recall: command('recall'),
		sessions: command('sessions'),
		read: command('read'),
	},
});
