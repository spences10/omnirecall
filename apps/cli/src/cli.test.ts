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
	codex_records,
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
		for (const row of result.results) {
			expect(row.before[0].content).toBe('Prepare the database');
			expect(row.after[0].content).toBe('Confirm the final checks');
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
			schema_version: 2,
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
			schema_version: 2,
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
			'Pi, Claude Code and Codex session evidence',
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
	const read = run_cli(['read', '--help']);
	expect(read.stdout).toContain('--char-offset');
	expect(read.stdout).not.toContain('--agent');
	expect(run_cli(['--help']).stdout).not.toContain('guide');
});

test('FTS5 syntax works through search and recall with actionable malformed-query errors', () => {
	const root = mkdtempSync(join(tmpdir(), 'omni-fts-'));
	try {
		const db = join(root, 'archive.db');
		writeFileSync(join(root, 'session.jsonl'), jsonl(pi_records()));
		expect(
			run_cli(['sync', '--pi-root', root, '--db', db, '--json'])
				.status,
		).toBe(0);
		for (const mode of [
			['search'],
			['search', '--full'],
			['recall'],
			['recall', '--compact'],
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
