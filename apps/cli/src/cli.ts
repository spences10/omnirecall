import { defineCommand } from 'citty';
import { constants, existsSync, readFileSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
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
} from '../../../packages/core/src/retrieval.ts';
import { error_code, sync } from '../../../packages/core/src/sync.ts';
import {
	InputError,
	type Source,
} from '../../../packages/core/src/types.ts';
import { database_path } from './paths.ts';

const package_metadata = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };
const capabilities = [
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
		};
		console.log(
			args.json
				? JSON.stringify(result)
				: `${result.name} v${result.version}\nPreview: Pi v3 and Codex paginated dialogue; durable local archive.`,
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

function command(name: string) {
	return defineCommand({
		meta: {
			name,
			description: `${name} archived Pi/Codex conversations (explicit roots for sync)`,
		},
		args: {
			json: { type: 'boolean', description: 'Machine-readable JSON' },
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
					'Read: Unicode character offset within the selected message',
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
					'Plain-text query, or exact message ref for read',
			},
			db: {
				type: 'string',
				description: 'Omni Recall database path',
			},
			'pi-root': {
				type: 'string',
				description: 'Explicit Pi session tree root',
			},
			'codex-root': {
				type: 'string',
				description: 'Explicit Codex JSONL tree root',
			},
			agent: {
				type: 'string',
				description: 'Transcript source: pi or codex',
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
				description: 'Exact source-qualified session ID',
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
					'Include superseded revisions and abandoned branches/turns',
			},
			limit: {
				type: 'string',
				description:
					'Maximum results, 1–100 (compact default 5; detailed 10)',
			},
			offset: {
				type: 'string',
				description: 'Result offset, 0–1000000',
			},
			context: {
				type: 'string',
				description:
					'Recall/read messages per side, 0–10 (compact default 1; detailed 2)',
			},
			'max-bytes': {
				type: 'string',
				description:
					'JSON budget, 1024–1048576 (compact default 8192; detailed 65536)',
			},
		},
		async run({ args }) {
			let archive: Archive | undefined;
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
					agent !== 'codex'
				)
					throw new InputError(
						'arguments',
						'--agent must be pi or codex',
					);
				const options: QueryOptions = {
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
				const selected = sources.filter(
					(source) =>
						(!agent || source.agent === agent) &&
						(!options.source || source.source_id === options.source),
				);
				if (name === 'sync' && !selected.length)
					throw new InputError(
						'arguments',
						'sync requires an explicit --pi-root or --codex-root matching the source filters',
					);
				if (
					name === 'sync' &&
					(options.project ||
						options.session ||
						options.include_history)
				)
					throw new InputError(
						'arguments',
						'sync operates on whole explicit roots, not project/session/history filters',
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
				const db_path = database_path(args.db);
				if (name === 'sync' || existsSync(db_path))
					archive = new Archive(db_path, name !== 'sync');
				let result: Record<string, unknown>;
				if (name === 'sync') {
					result = await sync(archive!, selected, [
						pi_adapter,
						codex_adapter,
					]);
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
						...focused_read(
							archive,
							query!,
							options.context,
							char_offset,
							chars,
						),
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
				process.exitCode = 1;
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
			'Recall coding-agent conversations from a durable local archive',
	},
	subCommands: {
		info,
		sources: command('sources'),
		sync: command('sync'),
		search: command('search'),
		recall: command('recall'),
		sessions: command('sessions'),
		read: command('read'),
	},
});
