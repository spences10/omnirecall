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
	expect(JSON.stringify(result.messages)).not.toMatch(
		/hidden-secret|private-tool|Duplicate|duplicate-only/,
	);
});

test('omits known user attachments and references but rejects unknown content', () => {
	function with_content(content: unknown[]) {
		return parse([
			...codex_records(),
			codex_entry('event_msg', {
				type: 'item_completed',
				turn_id: 'turn-1',
				item: { id: 'mixed', type: 'UserMessage', content },
			}),
		]);
	}
	const result = with_content([
		{ type: 'image', image_url: 'synthetic' },
		{ type: 'local_image', path: '/synthetic/image.png' },
		{ type: 'audio', audio_url: 'synthetic' },
		{ type: 'local_audio', path: '/synthetic/audio.wav' },
		{ type: 'skill', name: 'synthetic', path: '/synthetic/SKILL.md' },
		{ type: 'mention', name: 'synthetic', path: 'app://synthetic' },
		{ type: 'text', text: 'Visible question' },
	]);
	expect(result.messages.at(-1)?.content).toBe('Visible question');
	for (const block of [
		{ type: 'future', text: 'lost' },
		{ type: 'thinking', thinking: 'hidden' },
	])
		expect(() => with_content([block])).toThrow(
			'Unknown dialogue content block type',
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

test('reports the byte and field for a malformed completed item', () => {
	expect(() =>
		parse([
			...codex_records(),
			codex_entry('event_msg', {
				type: 'item_completed',
				turn_id: 'turn-1',
				item: { type: 'UserMessage', id: 17, content: 'hello' },
			}),
		]),
	).toThrow(/Codex completed item record at byte .*invalid field id/);
});

test.each(['Text', 'text'])(
	'indexes assistant %s blocks and retains the original block type',
	(type) => {
		const record = codex_entry('event_msg', {
			type: 'item_completed',
			turn_id: 'turn-1',
			item: {
				id: 'actual-shape',
				type: 'AgentMessage',
				content: [
					{ type, text: 'A completed answer', extra: 'preserved' },
				],
			},
		});
		const result = parse([...codex_records(), record]);
		expect(result.messages.at(-1)?.content).toBe(
			'A completed answer',
		);
		expect(JSON.parse(result.records!.at(-1)!.raw_json)).toEqual(
			record,
		);
	},
);

test.each(['AgentMessage', 'UserMessage'])(
	'Valibot diagnoses malformed known text in %s',
	(type) => {
		expect(() =>
			parse([
				...codex_records(),
				codex_entry('event_msg', {
					type: 'item_completed',
					turn_id: 'turn-1',
					item: {
						id: 'invalid',
						type,
						content: [
							{
								type: type === 'AgentMessage' ? 'Text' : 'text',
								text: 42,
							},
						],
					},
				}),
			]),
		).toThrow(
			/Codex completed item record at byte .*invalid field content.0.text/,
		);
	},
);

test('missing block discriminators are invalid and unknown assistant block types are unsupported', () => {
	expect(() =>
		parse([
			...codex_records(),
			codex_entry('event_msg', {
				type: 'item_completed',
				turn_id: 'turn-1',
				item: {
					id: 'missing',
					type: 'AgentMessage',
					content: [{ text: 'untyped' }],
				},
			}),
		]),
	).toThrow(/invalid field content.0.type/);
	expect(() =>
		parse([
			...codex_records(),
			codex_entry('event_msg', {
				type: 'item_completed',
				turn_id: 'turn-1',
				item: {
					id: 'future',
					type: 'AgentMessage',
					content: [{ type: 'image' }],
				},
			}),
		]),
	).toThrow('Unknown dialogue content block type');
});

// Sanitized shapes observed in Codex paginated histories: no coding turn is required.
const realtime = [
	codex_entry('realtime_item', {
		id: 'start',
		realtime_session_id: 'rt-1',
		type: 'realtime_session_started',
	}),
	codex_entry('realtime_item', {
		id: 'segment',
		realtime_session_id: 'rt-1',
		type: 'transcript_segment',
		role: 'user',
		text: 'Spoken café question',
	}),
	codex_entry('realtime_item', {
		id: 'close',
		realtime_session_id: 'rt-1',
		type: 'realtime_session_closed',
		outcome: 'completed',
	}),
];
test('preserves realtime lifecycle records and indexes transcript evidence without inventing turn membership', () => {
	const result = parse([codex_records()[0]!, ...realtime]);
	expect(result.messages).toEqual([]);
	expect(result.parts).toHaveLength(1);
	expect(result.parts![0]).toMatchObject({
		kind: 'message',
		role: 'user',
		content: 'Spoken café question',
		turn_id: null,
		parent_id: null,
		state: 'unknown',
		json_pointer: '/payload/text',
	});
	expect(
		result.records!.slice(1).map((r) => JSON.parse(r.raw_json)),
	).toEqual(realtime);
});

test.each([
	{
		id: 'bad',
		realtime_session_id: 'rt-1',
		type: 'transcript_segment',
		role: 'user',
		text: 42,
	},
	{
		id: 'bad',
		realtime_session_id: 'rt-1',
		type: 'transcript_segment',
		role: 'user',
	},
	{
		id: 'bad',
		realtime_session_id: 'rt-1',
		type: 'realtime_session_closed',
		outcome: 42,
	},
])(
	'rejects malformed known realtime records with a schema diagnostic',
	(payload) => {
		expect(() =>
			parse([
				codex_records()[0]!,
				codex_entry('realtime_item', payload),
			]),
		).toThrow(
			/Codex realtime item record at byte .*invalid field (text|outcome)/,
		);
	},
);

test('unknown realtime variants remain explicitly unsupported', () => {
	expect(() =>
		parse([
			codex_records()[0]!,
			codex_entry('realtime_item', { type: 'future_realtime' }),
		]),
	).toThrow('Unknown realtime item type');
});
