import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { package_metadata, run_cli } from './cli-fixture.ts';

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
				'outline',
				'evidence',
				'read',
			],
			agent_instructions:
				'Use <command> --help for options. Unsure which session: search --by-session. Skim one: outline <short_id>. Then recall for context, evidence <ref> for what was run, read <ref> for full text.',
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
	const outline = run_cli(['outline', '--help']);
	expect(outline.stdout).toContain('--limit');
	expect(outline.stdout).not.toContain('--kind');
	expect(run_cli(['--help']).stdout).not.toContain('guide');
});
