import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import {
	create_fixture as create_opencode,
	message as opencode_message,
	put_message as put_opencode_message,
} from '../../../packages/adapter-opencode/src/fixtures.ts';
import {
	codex_records,
	codex_reviewer_records,
	jsonl,
	pi_entry,
	pi_records,
} from '../../../packages/core/src/fixtures.ts';

const entry_path = fileURLToPath(
	new URL('../dist/index.js', import.meta.url),
);
const package_metadata = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

const isolated_home = mkdtempSync(join(tmpdir(), 'omni-cli-home-'));
afterAll(() =>
	rmSync(isolated_home, { recursive: true, force: true }),
);

function run_cli(args: string[], env: NodeJS.ProcessEnv = {}) {
	return spawnSync(process.execPath, [entry_path, ...args], {
		encoding: 'utf8',
		timeout: 10_000,
		env: {
			...process.env,
			HOME: isolated_home,
			USERPROFILE: isolated_home,
			CODEX_HOME: join(isolated_home, '.codex'),
			XDG_DATA_HOME: join(isolated_home, '.local', 'share'),
			NO_COLOR: '1',
			...env,
		},
	});
}

test('end-to-end cross-agent recall, bounded JSON, explicit roots and unindexed status', () => {
	const root = mkdtempSync(join(tmpdir(), 'omnirecall-cli-'));
	const db = join(root, 'index.sqlite');
	const pi_root = join(root, 'pi');
	const codex_root = join(root, 'codex');
	try {
		const unindexed = run_cli([
			'search',
			'migrations',
			'--db',
			db,
			'--json',
		]);
		expect(unindexed.status).toBe(0);
		expect(JSON.parse(unindexed.stdout).status).toBe('unindexed');
		expect(existsSync(db)).toBe(false);
		const no_roots = run_cli(['sync', '--db', db, '--json']);
		expect(no_roots.status).toBe(0);
		expect(JSON.parse(no_roots.stdout).status).toBe('empty');
		expect(existsSync(db)).toBe(true);
		mkdirSync(pi_root);
		mkdirSync(codex_root);
		writeFileSync(join(pi_root, 'test.jsonl'), jsonl(pi_records()));
		writeFileSync(
			join(codex_root, 'test.jsonl'),
			jsonl(codex_records()),
		);
		const imported = run_cli([
			'sync',
			'--pi-root',
			pi_root,
			'--codex-root',
			codex_root,
			'--db',
			db,
			'--json',
		]);
		expect(imported.status, imported.stdout).toBe(0);
		expect(JSON.parse(imported.stdout).sessions_updated).toBe(2);
		const recalled = run_cli([
			'recall',
			'café migrations',
			'--db',
			db,
			'--json',
		]);
		expect(recalled.status, recalled.stdout).toBe(0);
		const result = JSON.parse(recalled.stdout);
		expect(
			result.results
				.map((row: { agent: string }) => row.agent)
				.sort(),
		).toEqual(['codex', 'pi']);
		expect(result.schema_version).toBe(3);
		const content = (ref: string) =>
			result.messages.find((m: { ref: string }) => m.ref === ref)
				.content;
		for (const row of result.results) {
			expect(content(row.before[0])).toBe('Prepare the database');
			expect(content(row.after[0])).toBe('Confirm the final checks');
		}
		const original_db = readFileSync(db);
		const filtered = run_cli([
			'sessions',
			'--agent',
			'pi',
			'--db',
			db,
			'--json',
		]);
		expect(filtered.status, filtered.stdout).toBe(0);
		expect(JSON.parse(filtered.stdout).results).toHaveLength(1);
		expect(readFileSync(db)).toEqual(original_db);
		const unknown = run_cli([
			'search',
			'migrations',
			'--source',
			'pi:unknown',
			'--db',
			db,
			'--json',
		]);
		expect(JSON.parse(unknown.stdout).status).toBe('unindexed');
		const empty = run_cli([
			'search',
			'absentword',
			'--db',
			db,
			'--json',
		]);
		expect(JSON.parse(empty.stdout).status).toBe('empty');
		const limited = run_cli([
			'search',
			'migrations',
			'--limit',
			'1',
			'--db',
			db,
			'--json',
		]);
		expect(JSON.parse(limited.stdout)).toMatchObject({
			returned_count: 1,
			has_more: true,
			next_offset: 1,
			truncated: true,
		});
		writeFileSync(
			join(pi_root, 'test.jsonl'),
			jsonl([
				...pi_records(),
				pi_entry(
					'huge',
					'u2',
					'assistant',
					'oversized ' + '☕'.repeat(20000),
				),
			]),
		);
		expect(
			run_cli(['sync', '--pi-root', pi_root, '--db', db, '--json'])
				.status,
		).toBe(0);
		const bounded = run_cli([
			'recall',
			'oversized',
			'--db',
			db,
			'--json',
			'--max-bytes',
			'1024',
		]);
		expect(Buffer.byteLength(bounded.stdout)).toBeLessThanOrEqual(
			1024,
		);
		expect(JSON.parse(bounded.stdout).truncated).toBe(true);
		const partial = run_cli([
			'sync',
			'--pi-root',
			join(root, 'missing'),
			'--codex-root',
			codex_root,
			'--db',
			db,
			'--json',
		]);
		expect(partial.status).toBe(2);
		expect(JSON.parse(partial.stdout).issues[0].code).toBe('missing');
		for (const args of [
			['--limit', '0'],
			['--agent', 'invalid'],
			['--after', 'invalid'],
			['--max-bytes', '1'],
		]) {
			const invalid = run_cli([
				'recall',
				'migrations',
				'--db',
				db,
				'--json',
				...args,
			]);
			expect(invalid.status).toBe(1);
			expect(JSON.parse(invalid.stdout).status).toBe('error');
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('search and recall include whole UTC days but preserve exact timestamp bounds', () => {
	const root = mkdtempSync(join(tmpdir(), 'omnirecall-dates-'));
	const db = join(root, 'archive.db');
	const pi_root = join(root, 'pi');
	try {
		mkdirSync(pi_root);
		const stamps = [
			'2026-09-24T23:59:59.999Z',
			'2026-09-25T00:00:00.000Z',
			'2026-09-25T12:00:00.000Z',
			'2026-09-25T23:59:59.999Z',
			'2026-09-26T00:00:00.000Z',
		];
		writeFileSync(
			join(pi_root, 'dates.jsonl'),
			jsonl([
				pi_records()[0],
				...stamps.map((timestamp, i) => ({
					...pi_entry(
						String(i),
						i ? String(i - 1) : null,
						'user',
						'dateprobe',
					),
					timestamp,
				})),
			]),
		);
		expect(
			run_cli(['sync', '--pi-root', pi_root, '--db', db, '--json'])
				.status,
		).toBe(0);
		for (const command of ['search', 'recall']) {
			for (const [bounds, expected] of [
				[
					['--after', '2026-09-25', '--before', '2026-09-25'],
					stamps.slice(1, 4),
				],
				[['--before', '2026-09-25'], stamps.slice(0, 4)],
				[['--after', '2026-09-25'], stamps.slice(1)],
				[
					[
						'--after',
						'2026-09-25',
						'--before',
						'2026-09-25T00:00:00Z',
					],
					[stamps[1]],
				],
				[
					[
						'--after',
						'2026-09-25T12:00:00Z',
						'--before',
						'2026-09-25T12:00:00Z',
					],
					[stamps[2]],
				],
				[
					[
						'--after',
						'2026-09-25',
						'--before',
						'2026-09-25T14:00:00+02:00',
					],
					stamps.slice(1, 3),
				],
			] as const) {
				const response = run_cli(
					[
						command,
						'dateprobe',
						'--db',
						db,
						'--json',
						'--context',
						'0',
						'--max-bytes',
						'65536',
						...bounds,
					],
					{ TZ: 'Pacific/Honolulu' },
				);
				expect(response.status, response.stdout).toBe(0);
				const data = JSON.parse(response.stdout);
				expect(
					data.results
						.map(
							(row: { ref: string; timestamp?: string }) =>
								row.timestamp ??
								data.messages.find(
									(m: { ref: string }) => m.ref === row.ref,
								).timestamp ??
								data.shared.messages.timestamp,
						)
						.sort(),
				).toEqual(expected);
			}
			for (const bounds of [
				['--after', '2026-09-26', '--before', '2026-09-25'],
				['--after', 'invalid'],
				['--before', 'invalid'],
			]) {
				const response = run_cli([
					command,
					'dateprobe',
					'--db',
					db,
					'--json',
					...bounds,
				]);
				expect(response.status).toBe(1);
				expect(JSON.parse(response.stdout).status).toBe('error');
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('session discovery combines title/date filters with safe short identifiers', () => {
	const root = mkdtempSync(join(tmpdir(), 'omnirecall-discovery-'));
	const db = join(root, 'archive.db');
	const pi_root = join(root, 'pi');
	const codex_root = join(root, 'codex');
	const first_id = '12345678-aaaa-4000-8000-000000000001';
	const run = (args: string[]) => {
		const result = run_cli([
			...args,
			'--db',
			db,
			'--json',
			'--max-bytes',
			'65536',
		]);
		expect(result.status, result.stdout).toBe(0);
		return JSON.parse(result.stdout);
	};
	try {
		mkdirSync(pi_root);
		mkdirSync(codex_root);
		for (const [id, title, timestamp] of [
			[first_id, 'Plan %_Target alpha', '2026-09-25T00:00:00.000Z'],
			[
				'12345678-bbbb-4000-8000-000000000002',
				'Plan %_Target beta',
				'2026-09-25T23:59:59.999Z',
			],
			[
				'different',
				'Plan XXTarget decoy',
				'2026-09-26T00:00:00.000Z',
			],
		]) {
			const records = pi_records(id).map((record, index) => ({
				...record,
				timestamp:
					index === 0 ? timestamp : '2026-09-26T12:00:00.000Z',
				...(index === 1 ? { name: title } : {}),
			}));
			writeFileSync(join(pi_root, `${id}.jsonl`), jsonl(records));
		}
		writeFileSync(
			join(codex_root, 'copy.jsonl'),
			jsonl(codex_records(first_id)),
		);
		expect(
			run(['sync', '--pi-root', pi_root, '--codex-root', codex_root])
				.sessions_updated,
		).toBe(4);
		const filters = [
			'--title',
			'%_target',
			'--after',
			'2026-09-25',
			'--before',
			'2026-09-25',
		];
		const page = run(['sessions', ...filters, '--limit', '1']);
		expect(page).toMatchObject({
			returned_count: 1,
			has_more: true,
			next_offset: 1,
		});
		const next = run([
			'sessions',
			...filters,
			'--limit',
			'1',
			'--offset',
			'1',
		]);
		expect(next).toMatchObject({
			returned_count: 1,
			has_more: false,
			next_offset: null,
		});
		expect(next.results[0].archive_id).not.toBe(
			page.results[0].archive_id,
		);
		const first = next.results[0];
		expect(first.native_id).toBe(first_id);
		expect(first.short_id).toHaveLength(12);
		for (const mode of [
			['search'],
			['search', '--full'],
			['recall'],
			['recall', '--full'],
		]) {
			expect(
				run([...mode, 'migrations', '--title', '%_TARGET']).results,
			).toHaveLength(2);
			expect(
				run([...mode, 'migrations', ...filters]).results,
			).toHaveLength(0);
			expect(
				run([
					...mode,
					'migrations',
					'--title',
					'%_target',
					'--after',
					'2026-09-26',
					'--before',
					'2026-09-26',
				]).results,
			).toHaveLength(2);
		}
		for (const session of [
			first.session_id,
			first.archive_id,
			first.short_id,
			first.native_id,
			first.native_id.slice(0, 12),
		]) {
			for (const args of [
				['sessions'],
				['search', 'migrations'],
				['recall', 'migrations'],
			]) {
				const scoped = run([
					...args,
					'--agent',
					'pi',
					'--session',
					session,
				]);
				expect(scoped.results).toHaveLength(1);
			}
		}
		expect(
			run([
				'sessions',
				'--source',
				first.source_id,
				'--session',
				first.native_id,
			]).results,
		).toHaveLength(1);
		expect(
			run(['sessions', '--session', 'missing-session']).results,
		).toHaveLength(0);
		for (const args of [
			['sessions', '--session', first.native_id],
			[
				'sessions',
				'--session',
				'12345678',
				'--agent',
				'pi',
				'--title',
				'alpha',
			],
			[
				'search',
				'migrations',
				'--session',
				first.native_id,
				'--title',
				'alpha',
			],
			[
				'recall',
				'migrations',
				'--session',
				first.native_id,
				'--before',
				'2000-01-01',
			],
		]) {
			const response = run_cli([...args, '--db', db, '--json']);
			expect(response.status).toBe(1);
			expect(JSON.parse(response.stdout)).toMatchObject({
				code: 'arguments',
				message: expect.stringContaining('Ambiguous session'),
			});
		}
		for (const args of [
			['sessions', '--after', 'invalid'],
			['sessions', '--after', '2026-09-26', '--before', '2026-09-25'],
			['sessions', '--title', ''],
			['sessions', '--session', ''],
			['sources', '--title', 'alpha'],
			['sync', '--title', 'alpha'],
			['read', first.first_record_ref, '--title', 'alpha'],
		]) {
			const response = run_cli([...args, '--db', db, '--json']);
			expect(response.status, response.stdout).toBe(1);
			expect(JSON.parse(response.stdout).code).toBe('arguments');
		}
		rmSync(join(pi_root, `${first_id}.jsonl`));
		run(['sync', '--pi-root', pi_root]);
		expect(
			run(['sessions', '--session', first.short_id]).results[0],
		).toMatchObject({
			short_id: first.short_id,
			path_status: 'missing',
		});
		expect(
			run(['search', 'migrations', '--session', first.short_id])
				.results,
		).toHaveLength(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('compact v3 shares provenance, keeps source paths and offers concise session listings', () => {
	const root = mkdtempSync(join(tmpdir(), 'omnirecall-lean-'));
	const db = join(root, 'archive.db');
	const pi_root = join(root, 'pi');
	const run = (args: string[]) => {
		const response = run_cli([
			...args,
			'--db',
			db,
			'--json',
			'--max-bytes',
			'65536',
		]);
		expect(response.status, response.stdout).toBe(0);
		return {
			text: response.stdout,
			data: JSON.parse(response.stdout),
		};
	};
	const rows = (data: {
		results: Record<string, unknown>[];
		shared?: { results?: Record<string, unknown> };
	}) =>
		data.results.map((row) => ({ ...data.shared?.results, ...row }));
	try {
		mkdirSync(pi_root);
		for (const id of ['one', 'two'])
			writeFileSync(
				join(pi_root, `${id}.jsonl`),
				jsonl(pi_records(id)),
			);
		run(['sync', '--pi-root', pi_root]);
		const searched = run(['search', 'migrations']);
		expect(searched.data.schema_version).toBe(3);
		expect(searched.data.shared.results.agent).toBe('pi');
		expect(
			searched.data.results.every(
				(row: object) => !('source_status' in row),
			),
		).toBe(true);
		expect(
			rows(searched.data)
				.map((row) => String(row.source_path))
				.sort(),
		).toEqual([
			join(pi_root, 'one.jsonl'),
			join(pi_root, 'two.jsonl'),
		]);
		const recalled = run([
			'recall',
			'migrations',
			'--compact',
			'--context',
			'0',
		]);
		expect(recalled.data.schema_version).toBe(3);
		expect(recalled.data.shared.messages).toMatchObject({
			state: 'active',
			active: true,
			representation: 'primary',
		});
		for (const row of recalled.data.results) {
			expect(row).not.toHaveProperty('snippet');
			expect(row).not.toHaveProperty('state');
			const message = recalled.data.messages.find(
				(m: { ref: string }) => m.ref === row.ref,
			);
			expect(message.content).toContain('migrations');
			expect(message.role).toBe('assistant');
		}
		for (const args of [
			['search', 'migrations', '--full'],
			['recall', 'migrations', '--full'],
		]) {
			const detailed = run(args).data;
			expect(detailed.schema_version).toBe(1);
			expect(detailed).not.toHaveProperty('shared');
			expect(detailed.results[0]).toHaveProperty('source_status');
		}
		const sessions = run(['sessions', '--compact']);
		const detailed_sessions = run(['sessions']);
		expect(sessions.data.schema_version).toBe(3);
		expect(detailed_sessions.data.schema_version).toBe(1);
		expect(Buffer.byteLength(sessions.text)).toBeLessThan(
			Buffer.byteLength(detailed_sessions.text) * 0.75,
		);
		for (const row of sessions.data.results) {
			expect(row).not.toHaveProperty('hash');
			expect(row).not.toHaveProperty('session_id');
			expect(
				run(['search', 'migrations', '--session', row.short_id]).data
					.results,
			).toHaveLength(1);
			const raw = run(['read', row.first_record_ref]).data;
			expect(raw.schema_version).toBe(2);
			expect(raw.results[0].content).toContain('"type":"session"');
		}
		const limited = run([
			'sessions',
			'--compact',
			'--limit',
			'1',
		]).data;
		expect(limited).toMatchObject({
			returned_count: 1,
			has_more: true,
			next_offset: 1,
		});
		expect(limited).not.toHaveProperty('shared');
		rmSync(join(pi_root, 'one.jsonl'));
		run(['sync', '--pi-root', pi_root]);
		const mixed = run(['search', 'migrations']).data;
		expect(mixed.shared.results).not.toHaveProperty('path_status');
		expect(
			rows(mixed)
				.map((row) => String(row.path_status))
				.sort(),
		).toEqual(['available', 'missing']);
		const missing = rows(mixed).find(
			(row) => row.path_status === 'missing',
		)!;
		const read = run([
			'read',
			String(missing.ref),
			'--context',
			'0',
		]).data;
		expect(read.schema_version).toBe(2);
		expect(read).not.toHaveProperty('shared');
		expect(read.results[0].source_path).toBe(
			join(pi_root, 'one.jsonl'),
		);
		expect(read.messages[0].content).toContain('migrations');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('compact search, focused reading, and compact recall form a bounded retrieval workflow', () => {
	const root = mkdtempSync(join(tmpdir(), 'omnirecall-compact-'));
	const db = join(root, 'archive.db');
	const pi_root = join(root, 'pi');
	function run(args: string[]) {
		return run_cli([...args, '--db', db, '--json']);
	}
	try {
		mkdirSync(pi_root);
		writeFileSync(
			join(pi_root, 'session.jsonl'),
			jsonl([
				...pi_records(),
				pi_entry(
					'long',
					'u2',
					'assistant',
					'🌱 padding '.repeat(1200) +
						'migrationneedle final decision',
				),
			]),
		);
		expect(run(['sync', '--pi-root', pi_root]).status).toBe(0);
		const compact = run(['search', 'migrationneedle']);
		const full = run(['search', 'migrationneedle', '--full']);
		expect(compact.status, compact.stdout).toBe(0);
		expect(full.status, full.stdout).toBe(0);
		const hit = JSON.parse(compact.stdout).results[0];
		expect(JSON.parse(compact.stdout)).toMatchObject({
			schema_version: 3,
			format: 'compact',
		});
		expect(JSON.parse(full.stdout)).toMatchObject({
			schema_version: 1,
		});
		expect(hit).not.toHaveProperty('content');
		expect(hit.snippet).toContain('migrationneedle');
		expect(Buffer.byteLength(compact.stdout)).toBeLessThan(
			Buffer.byteLength(full.stdout) / 2,
		);
		const original = readFileSync(db);
		const read = run([
			'read',
			hit.ref,
			'--char-offset',
			String(hit.char_offset),
			'--context',
			'0',
		]);
		expect(read.status, read.stdout).toBe(0);
		expect(JSON.parse(read.stdout).messages[0].content).toContain(
			'migrationneedle',
		);
		expect(readFileSync(db)).toEqual(original);
		const first = JSON.parse(
			run(['read', hit.ref, '--context', '0', '--chars', '20'])
				.stdout,
		);
		expect(first.messages[0].next_char_offset).toBe(20);
		const next = JSON.parse(
			run([
				'read',
				hit.ref,
				'--context',
				'0',
				'--chars',
				'20',
				'--char-offset',
				'20',
			]).stdout,
		);
		expect(next.messages[0].char_offset).toBe(20);
		const recall = run(['recall', 'database', '--compact']);
		expect(recall.status, recall.stdout).toBe(0);
		expect(JSON.parse(recall.stdout)).toMatchObject({
			schema_version: 3,
			format: 'compact',
		});
		expect(JSON.parse(recall.stdout).messages.length).toBeGreaterThan(
			0,
		);
		const bounded = run(['read', hit.ref, '--max-bytes', '1024']);
		expect(bounded.status).toBe(0);
		expect(Buffer.byteLength(bounded.stdout)).toBeLessThanOrEqual(
			1024,
		);
		expect(JSON.parse(bounded.stdout)).toMatchObject({
			schema_version: 2,
			output_budget_exceeded: true,
			returned_count: 0,
			next_offset: 0,
		});
		for (const args of [
			['read', 'invalid'],
			['read', hit.ref, '--chars', '0'],
			['read', hit.ref, '--context', '11'],
			['read', hit.ref, '--char-offset', '-1'],
			['read', hit.ref, '--agent', 'pi'],
			['read', hit.ref, '--offset', '1'],
			['search', 'migration', '--full', '--compact'],
			['recall', 'migration', '--full', '--compact'],
			['sessions', '--full'],
			['search', 'migration', '--chars', '10'],
		]) {
			const invalid = run(args);
			expect(invalid.status, invalid.stdout).toBe(1);
			expect(JSON.parse(invalid.stdout).code).toBe('arguments');
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// Node 24.11 emits this runtime warning when node:sqlite is imported.
// Accept that warning only; application diagnostics must still fail these checks.
const clean_stderr =
	/^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n)?$/;

describe('built CLI', () => {
	test.each([{ args: [] }, { args: ['--help'] }])(
		'shows help for $args',
		({ args }) => {
			const result = run_cli(args);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain('omnirecall');
			expect(result.stdout).toContain('info');
			expect(result.stderr).toMatch(clean_stderr);
		},
	);

	test('reports the package version', () => {
		const result = run_cli(['--version']);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(package_metadata.version);
		expect(result.stderr).toMatch(clean_stderr);
	});

	test('returns clean JSON with implemented preview capabilities', () => {
		const result = run_cli(['info', '--json']);
		expect(result.status).toBe(0);
		expect(result.stderr).toMatch(clean_stderr);
		expect(JSON.parse(result.stdout)).toEqual({
			schema_version: 1,
			name: package_metadata.name,
			version: package_metadata.version,
			status: 'preview',
			capabilities: [
				'sources',
				'sync',
				'search',
				'recall',
				'sessions',
				'read',
			],
			agent_instructions:
				'Use <command> --help for options; search --json, then read an exact ref.',
		});
	});

	test('explains preview support in human-readable output', () => {
		const result = run_cli(['info']);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			'Pi, Claude Code, Codex and OpenCode session evidence',
		);
	});

	test('rejects commands that are not implemented', () => {
		const result = run_cli(['analytics']);
		expect(result.status).not.toBe(0);
		expect(result.error).toBeUndefined();
	});
});

test('build ships the SQL schema unchanged beside the executable', () => {
	expect(
		readFileSync(
			new URL('../dist/schema.sql', import.meta.url),
			'utf8',
		),
	).toBe(
		readFileSync(
			new URL(
				'../../../packages/core/src/schema.sql',
				import.meta.url,
			),
			'utf8',
		),
	);
});

test('creates omnirecall.db in the platform data directory', () => {
	const root = mkdtempSync(join(tmpdir(), 'omnirecall-paths-'));
	try {
		const pi_root = join(root, 'sessions');
		mkdirSync(pi_root);
		writeFileSync(
			join(pi_root, 'session.jsonl'),
			jsonl(pi_records()),
		);
		const env = {
			HOME: root,
			USERPROFILE: root,
			XDG_DATA_HOME: join(root, 'xdg-data'),
			LOCALAPPDATA: join(root, 'local-data'),
			OMNIRECALL_DB: undefined,
		};
		const data_dir =
			process.platform === 'darwin'
				? join(root, 'Library', 'Application Support', 'omnirecall')
				: process.platform === 'win32'
					? join(root, 'local-data', 'omnirecall', 'Data')
					: join(root, 'xdg-data', 'omnirecall');
		const result = run_cli(
			['sync', '--pi-root', pi_root, '--json'],
			env,
		);
		expect(result.status, result.stderr + result.stdout).toBe(0);
		expect(existsSync(join(data_dir, 'omnirecall.db'))).toBe(true);
		const recalled = run_cli(['recall', 'migrations', '--json'], env);
		expect(recalled.status, recalled.stderr + recalled.stdout).toBe(
			0,
		);
		expect(JSON.parse(recalled.stdout).returned_count).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('Claude tool search and raw-record continuation work through the built CLI', () => {
	const root = mkdtempSync(join(tmpdir(), 'omni-claude-cli-'));
	try {
		const db = join(root, 'archive.db');
		writeFileSync(
			join(root, 'session.jsonl'),
			jsonl([
				{
					type: 'assistant',
					uuid: 'a',
					sessionId: 's',
					timestamp: '2026-09-01T00:00:00Z',
					message: {
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								id: 'c',
								name: 'Bash',
								input: { command: 'check' },
							},
						],
					},
				},
				{
					type: 'user',
					uuid: 'u',
					sessionId: 's',
					timestamp: '2026-09-01T00:00:01Z',
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'c',
								content: 'tool_unique_failure',
								is_error: true,
							},
						],
					},
				},
			]),
		);
		const imported = run_cli([
			'sync',
			'--claude-root',
			root,
			'--db',
			db,
			'--json',
		]);
		expect(imported.status, imported.stdout + imported.stderr).toBe(
			0,
		);
		for (const [flags, count] of [
			[[], 0],
			[['--kind', 'all'], 1],
		] as const) {
			const result = run_cli([
				'search',
				'tool_unique_failure',
				'--db',
				db,
				'--json',
				...flags,
			]);
			expect(result.status).toBe(0);
			expect(JSON.parse(result.stdout).results).toHaveLength(count);
		}
		const search = run_cli([
			'search',
			'tool_unique_failure',
			'--kind',
			'tool_result',
			'--db',
			db,
			'--json',
		]);
		const hit = JSON.parse(search.stdout).results[0];
		expect(hit.kind).toBe('tool_result');
		const read = run_cli([
			'read',
			hit.ref,
			'--raw',
			'--chars',
			'25',
			'--db',
			db,
			'--json',
		]);
		const first = JSON.parse(read.stdout).results[0];
		expect(first.next_char_offset).toBe(25);
		const next = run_cli([
			'read',
			first.record_ref,
			'--char-offset',
			'25',
			'--chars',
			'25',
			'--db',
			db,
			'--json',
		]);
		expect(JSON.parse(next.stdout).results[0].char_offset).toBe(25);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('OpenCode v2 is discovered through XDG and supports CLI retrieval from live WAL storage', () => {
	const root = mkdtempSync(join(tmpdir(), 'omni-opencode-cli-'));
	const data = join(root, 'xdg');
	const opencode_root = join(data, 'opencode');
	mkdirSync(opencode_root, { recursive: true });
	const writer = create_opencode(join(opencode_root, 'opencode.db'));
	const db = join(root, 'archive.db');
	const env = { XDG_DATA_HOME: data };
	const run = (args: string[]) => {
		const response = run_cli([...args, '--db', db, '--json'], env);
		expect(response.status, response.stdout).toBe(0);
		return JSON.parse(response.stdout);
	};
	try {
		expect(run(['sync', '--agent', 'opencode'])).toMatchObject({
			sources_selected: 1,
			sessions_updated: 1,
		});
		expect(run(['sync', '--agent', 'opencode'])).toMatchObject({
			files_skipped: 1,
			sessions_updated: 0,
		});
		const listed = run([
			'sessions',
			'--agent',
			'opencode',
			'--title',
			'migration',
		]).results[0];
		expect(listed.source_path).toBe(
			join(opencode_root, 'opencode.db'),
		);
		const hit = run([
			'search',
			'opencodeneedle',
			'--session',
			listed.short_id,
		]).results[0];
		expect(hit.agent).toBe('opencode');
		const recalled = run([
			'recall',
			'opencodeneedle',
			'--agent',
			'opencode',
			'--full',
		]).results[0];
		expect(recalled.before[0].content).toBe('Prepare the database');
		expect(recalled.after[0].content).toBe(
			'Confirm the final checks',
		);
		expect(
			run(['read', hit.ref]).messages.some((m: { content: string }) =>
				m.content.includes('opencodeneedle'),
			),
		).toBe(true);
		expect(
			JSON.parse(run(['read', hit.ref, '--raw']).results[0].content)
				.data.content[0].text,
		).toContain('opencodeneedle');
		expect(
			run(['read', listed.first_record_ref]).results[0].native_type,
		).toBe('session_v2');
		expect(run(['search', 'tooloutputneedle']).results).toHaveLength(
			0,
		);
		expect(
			run(['search', 'tooloutputneedle', '--kind', 'tool_result'])
				.results,
		).toHaveLength(1);
		put_opencode_message(
			writer,
			opencode_message(2, 'assistant', {
				content: [
					{ type: 'text', text: 'updatedcodexfree OpenCode answer' },
				],
			}),
		);
		expect(
			run(['sync', '--opencode-root', opencode_root])
				.sessions_updated,
		).toBe(1);
		expect(run(['search', 'opencodeneedle']).results).toHaveLength(0);
		expect(
			run(['read', hit.ref, '--context', '0']).messages[0].content,
		).toContain('updatedcodexfree');
		expect(
			run(['sources', '--opencode-root', opencode_root]).results[0]
				.agent,
		).toBe('opencode');
	} finally {
		writer.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('plain sync discovers available histories, reuses custom sources and respects overrides', () => {
	const home = mkdtempSync(join(tmpdir(), 'omni-auto-'));
	try {
		const env = {
			HOME: home,
			USERPROFILE: home,
			CODEX_HOME: join(home, '.codex'),
		};
		const db = join(home, 'archive.db');
		const pi = join(home, '.pi', 'agent', 'sessions'),
			codex = join(home, '.codex', 'sessions');
		mkdirSync(pi, { recursive: true });
		mkdirSync(codex, { recursive: true });
		writeFileSync(join(pi, 'pi.jsonl'), jsonl(pi_records('auto-pi')));
		writeFileSync(
			join(codex, 'codex.jsonl'),
			jsonl(codex_records('auto-codex')),
		);
		writeFileSync(
			join(home, '.codex', 'history.jsonl'),
			'not a supported session\n',
		);
		let run = run_cli(['sync', '--db', db, '--json'], env);
		expect(run.status, run.stdout + run.stderr).toBe(0);
		expect(JSON.parse(run.stdout)).toMatchObject({
			sources_selected: 2,
			sessions_updated: 2,
		});
		const custom = join(home, 'custom');
		mkdirSync(custom);
		writeFileSync(
			join(custom, 'pi.jsonl'),
			jsonl(pi_records('custom-pi')),
		);
		run = run_cli(
			['sync', '--pi-root', custom, '--db', db, '--json'],
			env,
		);
		expect(JSON.parse(run.stdout)).toMatchObject({
			sources_selected: 1,
			sessions_updated: 1,
		});
		run = run_cli(['sync', '--db', db, '--json'], env);
		expect(JSON.parse(run.stdout)).toMatchObject({
			sources_selected: 3,
			sessions_updated: 0,
		});
		run = run_cli(
			['sync', '--agent', 'codex', '--db', db, '--json'],
			env,
		);
		expect(JSON.parse(run.stdout).sources_selected).toBe(1);
		rmSync(custom, { recursive: true });
		run = run_cli(['sync', '--db', db, '--json'], env);
		expect(run.status).toBe(2);
		expect(JSON.parse(run.stdout).issues[0].code).toBe('missing');
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test('captured sync shows a concise summary and JSON mode stays structured', () => {
	const root = mkdtempSync(join(tmpdir(), 'omni-progress-'));
	try {
		const sessions = join(root, 'sessions');
		mkdirSync(sessions);
		writeFileSync(
			join(sessions, 'session.jsonl'),
			jsonl(pi_records()),
		);
		const args = [
			'sync',
			'--pi-root',
			sessions,
			'--db',
			join(root, 'archive.db'),
		];
		const human = run_cli(args);
		expect(human.status).toBe(0);
		expect(human.stderr).not.toContain('Starting sync');
		expect(human.stdout).toContain('Sync complete.');
		expect(human.stdout).toMatch(/Files processed\s+1/);
		expect(human.stdout).not.toContain('schema_version');
		const machine = run_cli([...args, '--json']);
		expect(machine.status).toBe(0);
		expect(machine.stderr).not.toContain('Starting sync');
		expect(machine.stderr).not.toContain('Checking pi');
		expect(JSON.parse(machine.stdout).files_indexed).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('human sync groups every issue while verbose and JSON retain bounded details', () => {
	const root = mkdtempSync(join(tmpdir(), 'omni-summary-'));
	try {
		const sessions = join(root, 'sessions');
		mkdirSync(sessions);
		for (let i = 0; i < 105; i++)
			writeFileSync(join(sessions, `bad-${i}.jsonl`), 'invalid\n');
		const args = [
			'sync',
			'--pi-root',
			sessions,
			'--db',
			join(root, 'archive.db'),
		];
		const human = run_cli(args);
		expect(human.status).toBe(2);
		expect(human.stdout).toContain('Sync completed with issues.');
		expect(human.stdout).toContain('pi: 105 invalid data');
		expect(human.stdout).not.toContain(sessions);
		expect(human.stdout).not.toContain('Invalid complete');
		expect(human.stdout).toContain('--verbose');
		const verbose = run_cli([...args, '--verbose']);
		expect(verbose.status).toBe(2);
		expect(verbose.stdout).toContain(sessions);
		expect(verbose.stdout).toContain('Showing 100 of 105 issues.');
		const machine = run_cli([...args, '--json']);
		expect(machine.status).toBe(2);
		const result = JSON.parse(machine.stdout);
		expect(result.issue_counts).toEqual([
			{ agent: 'pi', code: 'invalid', count: 105 },
		]);
		expect(result.issues).toHaveLength(100);
		expect(result.issues_truncated).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('empty and failed human syncs give plain explanations', () => {
	const root = mkdtempSync(join(tmpdir(), 'omni-empty-summary-'));
	try {
		const empty = run_cli(['sync', '--db', join(root, 'archive.db')]);
		expect(empty.status).toBe(0);
		expect(empty.stdout).toContain('Nothing to sync.');
		const failed = run_cli(['sync', '--agent', 'unknown']);
		expect(failed.status).toBe(1);
		expect(failed.stderr).toContain('Sync failed:');
		expect(failed.stdout).toBe('');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('build ships migration resources unchanged', () => {
	const source = new URL(
		'../../../packages/core/src/migrations/',
		import.meta.url,
	);
	for (const name of readdirSync(source))
		expect(
			readFileSync(
				new URL(`../dist/migrations/${name}`, import.meta.url),
			),
		).toEqual(readFileSync(new URL(name, source)));
});

test('command help exposes only relevant options without a separate guide', () => {
	const sync = run_cli(['sync', '--help']);
	expect(sync.stdout).toContain('--pi-root');
	expect(sync.stdout).not.toContain('--kind');
	expect(sync.stdout).not.toContain('--char-offset');
	const search = run_cli(['search', '--help']);
	expect(search.stdout).toContain('message (default)');
	expect(search.stdout).not.toContain('--pi-root');
	expect(search.stdout).toContain('--title');
	const sessions = run_cli(['sessions', '--help']);
	for (const flag of ['--title', '--after', '--before'])
		expect(sessions.stdout).toContain(flag);
	expect(sessions.stdout).toContain('short_id');
	expect(sync.stdout).not.toContain('--title');
	const read = run_cli(['read', '--help']);
	expect(read.stdout).toContain('--char-offset');
	expect(read.stdout).not.toContain('--agent');
	expect(run_cli(['--help']).stdout).not.toContain('guide');
});

test('default search and recall exclude Codex reviewer context while explicit reads retain it', () => {
	const root = mkdtempSync(join(tmpdir(), 'omni-reviewer-'));
	const db = join(root, 'archive.db');
	const run = (args: string[]) => {
		const response = run_cli([
			...args,
			'--db',
			db,
			'--json',
			'--max-bytes',
			'65536',
		]);
		expect(response.status, response.stdout).toBe(0);
		return JSON.parse(response.stdout);
	};
	try {
		writeFileSync(
			join(root, 'main.jsonl'),
			jsonl(codex_records('main')),
		);
		for (const id of ['reviewer-one', 'reviewer-two'])
			writeFileSync(
				join(root, `${id}.jsonl`),
				jsonl(codex_reviewer_records(id)),
			);
		expect(run(['sync', '--codex-root', root]).sessions_updated).toBe(
			3,
		);
		for (const mode of [
			['search'],
			['search', '--full'],
			['recall'],
			['recall', '--full'],
		]) {
			const response = run([...mode, 'migrations']);
			expect(response.results).toHaveLength(1);
			const result = response.results[0];
			const message = response.messages?.find(
				(row: { ref: string }) => row.ref === result.ref,
			);
			expect(message?.role ?? result.role).toBe('assistant');
		}
		expect(run(['search', 'AGENTS']).results).toHaveLength(0);
		const copies = run([
			'search',
			'migrations',
			'--kind',
			'review_context',
		]).results;
		expect(copies).toHaveLength(2);
		expect(
			copies.every((row: { role: string }) => row.role === 'context'),
		).toBe(true);
		expect(
			run(['search', 'migrations', '--kind', 'all']).results,
		).toHaveLength(3);
		expect(
			run(['read', copies[0].ref]).messages.some(
				(m: { content: string }) =>
					m.content.includes('copied transcript'),
			),
		).toBe(true);
		expect(
			run(['read', copies[0].ref, '--raw']).results[0].content,
		).toContain('UserMessage');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('FTS5 syntax works through search and recall with actionable malformed-query errors', () => {
	const root = mkdtempSync(join(tmpdir(), 'omni-fts-'));
	try {
		const db = join(root, 'archive.db');
		writeFileSync(
			join(root, 'session.jsonl'),
			jsonl([
				...pi_records(),
				pi_entry(
					'packages',
					'u2',
					'user',
					'my-pi node.js @scope/pkg packages/core/index.ts deps',
				),
			]),
		);
		expect(
			run_cli(['sync', '--pi-root', root, '--db', db, '--json'])
				.status,
		).toBe(0);
		for (const mode of [
			['search'],
			['search', '--full'],
			['recall'],
			['recall', '--full'],
		]) {
			const result = run_cli([
				...mode,
				'"café migrations" OR nonexistent',
				'--db',
				db,
				'--json',
			]);
			expect(result.status, result.stdout).toBe(0);
			expect(JSON.parse(result.stdout).results).toHaveLength(1);
			for (const term of [
				'my-pi',
				'node.js',
				'@scope/pkg',
				'packages/core/index.ts',
			]) {
				const punctuated = run_cli([
					...mode,
					`${term} AND deps`,
					'--db',
					db,
					'--json',
				]);
				expect(punctuated.status, punctuated.stdout).toBe(0);
				expect(JSON.parse(punctuated.stdout).results).toHaveLength(1);
			}
			const invalid = run_cli([
				...mode,
				'migration OR',
				'--db',
				db,
				'--json',
			]);
			expect(invalid.status).toBe(1);
			expect(JSON.parse(invalid.stdout)).toMatchObject({
				status: 'error',
				code: 'arguments',
				message: expect.stringContaining('Invalid FTS5 query'),
			});
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
