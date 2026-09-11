import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from 'vitest';
import { pi_adapter } from '../../adapter-pi/src/index.ts';
import { pi_records } from './fixtures.ts';
import { ImportStage } from './sync-cache.ts';

test('staging preserves evidence and provenance and cleans consumed and unconsumed files', async () => {
	const stage = new ImportStage();
	const batch = {
		sessions: [
			pi_adapter.parse(
				pi_records().map((value, byte_offset) => ({
					value,
					byte_offset,
				})),
			),
		],
		inputs: [
			{
				path: '/source',
				hash: 'hash',
				byte_offset: 10,
				partial: false,
			},
		],
	};
	const path = await stage.put(batch);
	try {
		expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(await stage.take(path)).toEqual(batch);
		await expect(stat(path)).rejects.toMatchObject({
			code: 'ENOENT',
		});
		await stage.put(batch);
	} finally {
		await stage.close();
	}
	await expect(stat(dirname(path))).rejects.toMatchObject({
		code: 'ENOENT',
	});
});
