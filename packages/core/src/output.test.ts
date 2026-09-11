import { expect, test } from 'vitest';
import { bounded_json } from './output.ts';

test('bounds UTF-8 JSON, reports clipped content and accurate dropped-row pagination', () => {
	const result = {
		schema_version: 1,
		status: 'ok',
		results: Array.from({ length: 10 }, (_, i) => ({
			id: i,
			content: '☕'.repeat(5000),
		})),
		returned_count: 10,
		has_more: false,
		offset: 3,
		next_offset: null,
	};
	const output = bounded_json(result, 16000);
	expect(Buffer.byteLength(output) + 1).toBeLessThanOrEqual(16000);
	const parsed = JSON.parse(output);
	expect(parsed.truncated).toBe(true);
	expect(parsed.results[0].content_truncated).toBe(true);
	expect(parsed.returned_count).toBe(parsed.results.length);
	expect(parsed.next_offset).toBe(3 + parsed.results.length);
	expect(parsed.has_more).toBe(true);
});

test('reports a budget too small for even one match without invalid JSON', () => {
	const output = bounded_json(
		{
			schema_version: 1,
			status: 'ok',
			results: [{ content: 'a'.repeat(5000) }],
		},
		1024,
	);
	expect(Buffer.byteLength(output)).toBeLessThan(1024);
	expect(JSON.parse(output)).toMatchObject({
		output_budget_exceeded: true,
		truncated: true,
		returned_count: 0,
		next_offset: 0,
	});
});
