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

test.each([
	{ source: { subagent: { other: 'guardian' } } },
	{ source: { subagent: { other: 'approval_reviewer' } } },
	{ source: { internal: 'guardian' } },
	{ thread_source: 'guardian_review' },
])(
	'classifies reviewer user records using explicit metadata: %j',
	(metadata) => {
		const rows = codex_records('reviewer');
		Object.assign(rows[0]!.payload, metadata, {
			parent_thread_id: 'parent',
		});
		rows.push(
			codex_item(
				'u1',
				'UserMessage',
				'Corrected embedded transcript',
			),
		);
		const result = parse(rows);
		expect(result.parent_session).toBe('parent');
		for (const part of [
			...result.messages,
			...(result.parts ?? []),
		]) {
			if (part.kind === 'review_context')
				expect(part.role).toBe('context');
			expect(part.role).not.toBe('user');
		}
		expect(
			result.messages.filter((m) => m.kind === 'review_context'),
		).toHaveLength(2);
		expect(result.parts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'review_context',
					representation: 'superseded',
					role: 'context',
				}),
			]),
		);
		expect(
			result.messages.find((m) => m.role === 'assistant')?.kind,
		).toBe('message');
		expect(result.links).toContainEqual({
			record_key: '0',
			kind: 'child_session',
			namespace: 'session',
			target: 'parent',
		});
		expect(result.records?.at(-1)?.raw_json).toBe(
			JSON.stringify(rows.at(-1)),
		);
	},
);

test.each([
	{},
	{ source: 'cli', thread_name: 'guardian approval_reviewer' },
	{ source: { subagent: 'review' } },
	{ source: { subagent: { other: 'custom_reviewer' } } },
	{
		source: {
			subagent: {
				thread_spawn: {
					parent_thread_id: 'parent',
					agent_role: 'guardian',
				},
			},
		},
	},
])(
	'does not infer reviewer provenance from body text or unrelated metadata: %j',
	(metadata) => {
		const rows = codex_records();
		Object.assign(rows[0]!.payload, metadata);
		rows.push(
			codex_item(
				'quoted',
				'UserMessage',
				'# AGENTS.md instructions\n<INSTRUCTIONS>guardian approval_reviewer embedded transcript</INSTRUCTIONS>',
			),
		);
		expect(
			parse(rows).messages.find((m) => m.native_id === 'quoted'),
		).toMatchObject({ kind: 'message', role: 'user' });
	},
);

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

test('omits known user attachments and references and preserves unknown content', () => {
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
		expect(with_content([block]).records?.at(-1)?.raw_json).toContain(
			JSON.stringify(block),
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

test('missing block discriminators are invalid and unknown assistant block types are preserved', () => {
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
	).not.toThrow();
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

test('unknown realtime variants are preserved', () => {
	expect(() =>
		parse([
			codex_records()[0]!,
			codex_entry('realtime_item', { type: 'future_realtime' }),
		]),
	).not.toThrow();
});

test.each(['future', 'response_item', 'event_msg'])(
	'preserves unfamiliar %s records with unknown message state',
	(type) => {
		const record = codex_entry(type, { type: 'future' });
		const result = parse([...codex_records(), record]);
		expect(result.records?.at(-1)?.raw_json).toBe(
			JSON.stringify(record),
		);
		expect(result.messages.every((m) => m.state === 'unknown')).toBe(
			true,
		);
	},
);
