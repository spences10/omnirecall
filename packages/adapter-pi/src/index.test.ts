import { expect, test } from 'vitest';
import {
	pi_entry,
	pi_records,
	timestamp,
} from '../../core/src/fixtures.ts';
import { parse_pi } from './index.ts';
function parse(records: unknown[]) {
	return parse_pi(
		records.map((value, byte_offset) => ({
			value: value as Record<string, unknown>,
			byte_offset,
		})),
	);
}

test('extracts named v3 dialogue and skips reasoning/tools/compaction materialization', () => {
	const result = parse([
		...pi_records(),
		{
			type: 'compaction',
			id: 'compact',
			parentId: 'u2',
			timestamp,
			summary: 'summary-only',
			retainedTail: [{ role: 'user', content: 'duplicate-only' }],
		},
	]);
	expect(result.title).toBe('Pi migration plan');
	expect(result.parent_session).toBe('/synthetic/parent.jsonl');
	expect(result.messages.map((message) => message.native_id)).toEqual(
		['u1', 'a1', 'u2'],
	);
	expect(result.messages[2]?.parent_id).toBe('a1');
	expect(JSON.stringify(result.messages)).not.toContain(
		'hidden-secret-thought',
	);
	expect(JSON.stringify(result.messages)).not.toContain(
		'summary-only',
	);
});

test.each([
	[pi_entry('bad', 'absent', 'user', 'text')],
	[pi_entry('u1', 'u2', 'user', 'duplicate')],
	[{ type: 'future', id: 'future', parentId: 'u2', timestamp }],
	[pi_entry('bad', 'u2', 'unknown-role', 'text')],
])('rejects ambiguous trees/unknown semantics (%j)', (extra) => {
	expect(() => parse([...pi_records(), extra])).toThrow();
});

test('omits known non-dialogue blocks and rejects unknown or missing block types', () => {
	const result = parse([
		...pi_records(),
		pi_entry('mixed', 'u2', 'assistant', [
			{ type: 'thinking', thinking: 'hidden' },
			{ type: 'toolCall', id: 'call', name: 'read', arguments: {} },
			{ type: 'text', text: 'Visible answer' },
		]),
		pi_entry('image', 'mixed', 'user', [
			{ type: 'image', data: 'synthetic', mimeType: 'image/png' },
			{ type: 'text', text: 'Visible question' },
		]),
	]);
	expect(
		result.messages.slice(-2).map((message) => message.content),
	).toEqual(['Visible answer', 'Visible question']);
	for (const block of [
		{ type: 'future', text: 'lost' },
		{ text: 'lost' },
		{ type: 'local_image', path: '/synthetic' },
	])
		expect(() =>
			parse([
				...pi_records(),
				pi_entry('unknown', 'u2', 'user', [block]),
			]),
		).toThrow('Unknown dialogue content block type');
});

test('uses last serialized leaf, not timestamp order, and excludes sibling branches', () => {
	const result = parse([
		...pi_records(),
		pi_entry('branch', 'u1', 'assistant', 'alternate'),
	]);
	expect(
		result.messages
			.filter((message) => message.active)
			.map((message) => message.native_id),
	).toEqual(['u1', 'branch']);
});
