import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, onTestFinished } from 'vitest';

/** A temporary directory, removed when the current test finishes. */
export function temp_dir(prefix: string) {
	const path = mkdtempSync(join(tmpdir(), prefix));
	onTestFinished(() =>
		rmSync(path, { recursive: true, force: true }),
	);
	return path;
}

/** A temporary directory shared by a suite; call it in the describe body. */
export function suite_dir(prefix: string) {
	const path = mkdtempSync(join(tmpdir(), prefix));
	afterAll(() => rmSync(path, { recursive: true, force: true }));
	return path;
}
