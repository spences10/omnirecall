import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { Archive } from './database.ts';

test('refuses a foreign database without changing it', () => {
	const root = mkdtempSync(join(tmpdir(), 'omnirecall-ownership-'));
	try {
		const path = join(root, 'foreign.sqlite');
		const foreign = new DatabaseSync(path);
		foreign.exec('CREATE TABLE keep_me(value TEXT);');
		foreign.close();
		const original = readFileSync(path);
		expect(() => new Archive(path)).toThrow(
			'Not an Omni Recall archive',
		);
		expect(readFileSync(path)).toEqual(original);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
