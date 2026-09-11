import { expect, test } from 'vitest';
import {
	codex_entry,
	codex_item,
	codex_records,
} from '../../core/src/fixtures.ts';
import { parse_codex } from './index.ts';
function parse(records: unknown[]) {
	return parse_codex(
		records.map((value, byte_offset) => ({
			value: value as Record<string, unknown>,
			byte_offset,
		})),
	);
}

test('indexes only completed dialogue, not response mirrors/reasoning/compacted replacement history', () => {
	const result = parse([
		...codex_records(),
		codex_entry('compacted', {
			replacement_history: [
				{ role: 'assistant', content: 'duplicate-only' },
			],
		}),
	]);
	expect(result.messages.map((message) => message.native_id)).toEqual(
		['u1', 'a1', 'u2'],
	);
	expect(JSON.stringify(result)).not.toMatch(
		/hidden-secret|private-tool|Duplicate|duplicate-only/,
	);
});

test('zero-turn rollback does not roll back everything', () => {
	const result = parse([
		...codex_records(),
		codex_entry('event_msg', {
			type: 'thread_rolled_back',
			num_turns: 0,
		}),
	]);
	expect(result.messages.every((message) => message.active)).toBe(
		true,
	);
});

test.each(['legacy', undefined, 'future'])(
	'rejects unsupported history mode %s',
	(history_mode) => {
		expect(() =>
			parse([
				codex_entry('session_meta', {
					id: 'test',
					cwd: '/synthetic',
					history_mode,
				}),
			]),
		).toThrow('paginated');
	},
);

test.each([
	codex_entry('event_msg', {
		type: 'thread_rolled_back',
		num_turns: 2,
	}),
	codex_entry('event_msg', {
		type: 'thread_rolled_back',
		num_turns: -1,
	}),
	codex_entry('future', {}),
	codex_entry('event_msg', { type: 'future' }),
	codex_item('a1', 'UserMessage', 'role correction is ambiguous'),
])('rejects unsupported updates (%j)', (record) => {
	expect(() => parse([...codex_records(), record])).toThrow();
});

test('rejects reversed ordinal ordering', () => {
	expect(() =>
		parse([
			...codex_records(),
			{ ...codex_entry('world_state', {}), ordinal: 4 },
			{ ...codex_entry('world_state', {}), ordinal: 3 },
		]),
	).toThrow('ordinals');
});
