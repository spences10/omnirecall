import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { boundary_error } from './boundaries.ts';

test.each([
	['packages/core/src/index.ts', '../../adapter-pi/src/index.ts'],
	['packages/core/src/index.ts', '@omnirecall/adapter-pi'],
	[
		'packages/adapter-shared/src/index.ts',
		'../../adapter-pi/src/index.ts',
	],
	[
		'packages/adapter-pi/src/index.ts',
		'../../adapter-codex/src/index.ts',
	],
	[
		'packages/core/src/index.test.ts',
		'../../../apps/cli/src/index.ts',
	],
])('rejects %s importing %s', (file, source) => {
	expect(boundary_error(file, source)).toBeTruthy();
});

test.each([
	['packages/core/src/index.ts', './types.ts'],
	['packages/core/src/index.ts', 'node:sqlite'],
	[
		'packages/core/src/index.test.ts',
		'../../adapter-pi/src/index.ts',
	],
	['packages/adapter-pi/src/index.ts', '../../core/src/types.ts'],
	[
		'packages/adapter-pi/src/index.ts',
		'../../adapter-shared/src/schemas.ts',
	],
	[
		'apps/cli/src/index.ts',
		'../../../packages/adapter-pi/src/index.ts',
	],
])('allows %s importing %s', (file, source) => {
	expect(boundary_error(file, source)).toBeNull();
});

test('Oxlint rejects imports, re-exports and dynamic imports', () => {
	const root = resolve(import.meta.dirname, '..');
	const scratch = mkdtempSync(
		join(root, 'packages/core/boundary-test-'),
	);
	try {
		const file = join(scratch, 'probe.ts');
		writeFileSync(
			file,
			[
				"import '@omnirecall/adapter-pi';",
				"export * from '@omnirecall/adapter-pi';",
				"export { parse_pi } from '@omnirecall/adapter-pi';",
				"void import('@omnirecall/adapter-pi');",
			].join('\n'),
		);
		const result = spawnSync(
			join(root, 'node_modules/.bin/vp'),
			['lint', file],
			{ encoding: 'utf8', timeout: 10_000 },
		);
		expect(result.status, result.stderr).toBe(1);
		expect(
			(result.stdout + result.stderr).match(/Core must not import/g),
			result.stdout + result.stderr,
		).toHaveLength(4);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
