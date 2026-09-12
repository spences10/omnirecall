import { expect, test } from 'vitest';
import { parse_cache } from './sync-cache.ts';
test('invalid persisted checkpoints are ignored', () => {
	for (const value of [
		'invalid',
		'{}',
		JSON.stringify({
			parser_version: 1,
			sessions: [],
			inputs: [
				{
					path: '/test',
					hash: 'hash',
					byte_offset: -1,
					partial: false,
				},
			],
		}),
	])
		expect(parse_cache(value)).toBeUndefined();
});
