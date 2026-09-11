import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
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

function run_cli(args: string[]) {
	return spawnSync(process.execPath, [entry_path, ...args], {
		encoding: 'utf8',
		timeout: 10_000,
		env: { ...process.env, NO_COLOR: '1' },
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
		expect(no_roots.status).toBe(1);
		expect(JSON.parse(no_roots.stdout).code).toBe('arguments');
		expect(existsSync(db)).toBe(false);
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
		expect(JSON.parse(imported.stdout).revisions_added).toBe(2);
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
			['--agent', 'claude'],
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

describe('built CLI', () => {
	test.each([{ args: [] }, { args: ['--help'] }])(
		'shows help for $args',
		({ args }) => {
			const result = run_cli(args);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain('omnirecall');
			expect(result.stdout).toContain('info');
			expect(result.stderr).toBe('');
		},
	);

	test('reports the package version', () => {
		const result = run_cli(['--version']);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(package_metadata.version);
		expect(result.stderr).toBe('');
	});

	test('returns clean JSON with implemented preview capabilities', () => {
		const result = run_cli(['info', '--json']);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
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
			],
		});
	});

	test('explains preview support in human-readable output', () => {
		const result = run_cli(['info']);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Pi v3 and Codex paginated');
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
