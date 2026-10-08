import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, onTestFinished } from 'vitest';

const entry_path = fileURLToPath(
	new URL('../dist/index.js', import.meta.url),
);
export const package_metadata = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

const isolated_home = mkdtempSync(join(tmpdir(), 'omni-cli-home-'));
afterAll(() =>
	rmSync(isolated_home, { recursive: true, force: true }),
);

/** Run the built CLI with a home directory that holds no histories. */
export function run_cli(args: string[], env: NodeJS.ProcessEnv = {}) {
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

/**
 * A runner bound to one archive. It adds --db and --json, asserts the exit
 * status and returns the parsed output. `outcome` skips the assertion and
 * returns the status beside the output.
 */
export function archive_cli(
	db: string,
	{
		env = {},
		flags = [],
	}: { env?: NodeJS.ProcessEnv; flags?: string[] } = {},
) {
	const outcome = (args: string[]) => {
		const response = run_cli(
			[...args, '--db', db, '--json', ...flags],
			env,
		);
		return {
			status: response.status,
			text: response.stdout,
			data: JSON.parse(response.stdout),
		};
	};
	const run = (args: string[], status = 0) => {
		const result = outcome(args);
		expect(result.status, result.text).toBe(status);
		return result.data;
	};
	return Object.assign(run, { outcome });
}

/** A temporary directory, removed when the current test finishes. */
export function temp_dir(prefix: string) {
	const path = mkdtempSync(join(tmpdir(), prefix));
	onTestFinished(() =>
		rmSync(path, { recursive: true, force: true }),
	);
	return path;
}
