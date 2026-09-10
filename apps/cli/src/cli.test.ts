import { spawnSync as spawn_sync } from 'node:child_process';
import { readFileSync as read_file_sync } from 'node:fs';
import { fileURLToPath as file_url_to_path } from 'node:url';
import { describe, expect, test } from 'vitest';

const entry_path = file_url_to_path(
	new URL('../dist/index.js', import.meta.url),
);
const package_metadata = JSON.parse(
	read_file_sync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

function run_cli(args: string[]) {
	return spawn_sync(process.execPath, [entry_path, ...args], {
		encoding: 'utf8',
		timeout: 10_000,
		env: { ...process.env, NO_COLOR: '1' },
	});
}

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

	test('returns clean JSON without claiming recall support', () => {
		const result = run_cli(['info', '--json']);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		expect(JSON.parse(result.stdout)).toEqual({
			schema_version: 1,
			name: package_metadata.name,
			version: package_metadata.version,
			status: 'scaffold',
			capabilities: [],
		});
	});

	test('explains scaffold status in human-readable output', () => {
		const result = run_cli(['info']);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('not implemented yet');
	});

	test('rejects commands that are not implemented', () => {
		const result = run_cli(['recall', 'auth']);
		expect(result.status).not.toBe(0);
		expect(result.error).toBeUndefined();
	});
});
