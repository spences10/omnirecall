import { expect, test } from 'vitest';
import { bounded_json } from './output.ts';

test('v3 hoists only identical metadata and round-trips mixed provenance and states', () => {
	const rows = [
		{
			ref: 'one',
			agent: 'pi',
			source_path: '/one.jsonl',
			source_status: 'available',
			source_checked_at: '2026-10-02T00:00:00Z',
			path_status: 'available',
			state: 'active',
			active: true,
			representation: 'primary',
			snippet: 'one',
		},
		{
			ref: 'two',
			agent: 'pi',
			source_path: '/two.jsonl',
			source_status: 'missing',
			source_checked_at: '2026-10-01T00:00:00Z',
			path_status: 'missing',
			state: 'unknown',
			active: true,
			representation: 'superseded',
			snippet: 'two',
		},
	];
	const messages = [
		{
			ref: 'one',
			state: 'active',
			active: true,
			representation: 'primary',
			content: 'one',
			content_truncated: false,
		},
		{
			ref: 'two',
			state: 'unknown',
			active: true,
			representation: 'superseded',
			content: 'two',
			content_truncated: false,
		},
	];
	const value = { schema_version: 3, results: rows, messages };
	const original = JSON.stringify(value);
	const parsed = JSON.parse(bounded_json(value, 65536));
	expect(parsed.shared).toEqual({
		results: { agent: 'pi', active: true },
		messages: { active: true },
	});
	expect(
		parsed.results.map((row: Record<string, unknown>) => ({
			...parsed.shared.results,
			...row,
		})),
	).toEqual(rows);
	expect(
		parsed.messages.map((row: Record<string, unknown>) => ({
			...parsed.shared.messages,
			...row,
		})),
	).toEqual(messages);
	expect(JSON.stringify(value)).toBe(original);
	for (const schema_version of [1, 2]) {
		const detailed = JSON.parse(
			bounded_json({ ...value, schema_version }, 65536),
		);
		expect(detailed).not.toHaveProperty('shared');
		expect(detailed.results).toEqual(rows);
	}
});

test('v3 does not invent shared values for absent fields and preserves null/false metadata', () => {
	const output = JSON.parse(
		bounded_json(
			{
				schema_version: 3,
				results: [
					{
						ref: 'one',
						title: null,
						active: false,
						source_status: 'missing',
					},
					{ ref: 'two', title: null, active: false },
				],
			},
			65536,
		),
	);
	expect(output.shared.results).toEqual({
		title: null,
		active: false,
	});
	expect(output.results).toEqual([
		{ ref: 'one', source_status: 'missing' },
		{ ref: 'two' },
	]);
});

test('v3 recalculates shared metadata and prunes messages after dropping results', () => {
	const first = {
		ref: 'one',
		source_path: '/one.jsonl',
		source_status: 'available',
		before: [],
		after: [],
	};
	const second = {
		ref: 'two',
		source_path: '/two.jsonl',
		source_status: 'missing',
		before: [],
		after: [],
	};
	const value = {
		schema_version: 3,
		results: [first, second],
		messages: [
			{
				ref: 'one',
				content: 'kept',
				state: 'active',
				active: true,
				representation: 'primary',
			},
			{
				ref: 'two',
				content: '☕'.repeat(1000),
				state: 'unknown',
				active: true,
				representation: 'primary',
			},
		],
		offset: 7,
		returned_count: 2,
		has_more: false,
		next_offset: null,
	};
	const output = bounded_json(value, 1024);
	const parsed = JSON.parse(output);
	expect(Buffer.byteLength(output) + 1).toBeLessThanOrEqual(1024);
	expect(parsed).toMatchObject({
		results: [first],
		returned_count: 1,
		has_more: true,
		next_offset: 8,
		truncated: true,
	});
	expect(parsed.messages).toHaveLength(1);
	expect(parsed.messages[0]).toMatchObject({
		ref: 'one',
		state: 'active',
		active: true,
	});
	expect(output).not.toContain('missing');
	expect(output).not.toContain('unknown');
	expect(parsed).not.toHaveProperty('shared');
});

test('v3 long Unicode paths are kept whole or excluded with explicit pagination', () => {
	const source_path = '/' + '🌱'.repeat(2000) + '.jsonl';
	const value = {
		schema_version: 3,
		results: [{ ref: 'one', source_path }],
		offset: 4,
		returned_count: 1,
		has_more: false,
		next_offset: null,
	};
	expect(
		JSON.parse(bounded_json(value, 16000)).results[0].source_path,
	).toBe(source_path);
	const output = bounded_json(value, 1024);
	expect(Buffer.byteLength(output) + 1).toBeLessThanOrEqual(1024);
	expect(JSON.parse(output)).toMatchObject({
		results: [],
		output_budget_exceeded: true,
		returned_count: 0,
		next_offset: 4,
	});
});

test('marks dropped sync issues while preserving failure counts', () => {
	const result = {
		schema_version: 1,
		status: 'partial',
		failures: 10,
		files_indexed: 3,
		issues: Array.from({ length: 10 }, () => ({
			code: 'unsupported',
			message: '☕'.repeat(200),
		})),
		issues_truncated: false,
	};
	const output = bounded_json(result, 1024);
	const parsed = JSON.parse(output);
	expect(Buffer.byteLength(output) + 1).toBeLessThanOrEqual(1024);
	expect(parsed).toMatchObject({
		status: 'partial',
		failures: 10,
		files_indexed: 3,
		issues_truncated: true,
		truncated: true,
	});
	expect(parsed.issues.length).toBeLessThan(10);
	expect(parsed).not.toHaveProperty('next_offset');
	expect(result.issues).toHaveLength(10);
	expect(result.issues_truncated).toBe(false);
	expect(JSON.parse(bounded_json(result, 16000))).toMatchObject({
		issues_truncated: false,
		truncated: false,
	});
});

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
