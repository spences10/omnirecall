import { expect, test } from 'vitest';
import { parse_claude } from './index.ts';

const entry = {
	type: 'user',
	uuid: 'message-1',
	sessionId: 'session-1',
	timestamp: '2026-09-01T00:00:00Z',
	message: { content: [{ type: 'text', text: 'Keep this text' }] },
};
function parse(value: Record<string, unknown>) {
	return parse_claude([
		{ value, byte_offset: 42, raw_json: JSON.stringify(value) },
	]);
}

test.each([
	{ ...entry, uuid: undefined },
	{ ...entry, uuid: '' },
	{ ...entry, message: { content: [{ type: 'text', text: 123 }] } },
	{ ...entry, message: { content: null } },
])(
	'rejects malformed dialogue instead of silently omitting it',
	(value) => {
		expect(() => parse(value)).toThrow(
			/Claude record at byte 42: invalid field/,
		);
	},
);

function conversation(records: Record<string, unknown>[]) {
	return parse_claude(
		records.map((value, byte_offset) => ({ value, byte_offset })),
	);
}
function message(
	uuid: string,
	parentUuid: string | null,
	content = '',
) {
	return { ...entry, uuid, parentUuid, message: { content } };
}

test('resolves text ancestry across non-text records without joining sibling branches', () => {
	const result = conversation([
		message('root', null, 'Root'),
		message('tool', 'root'),
		{ type: 'progress', uuid: 'progress', parentUuid: 'tool' },
		message('left', 'progress', 'Left branch'),
		message('right', 'tool', 'Right branch'),
		message('leaf', 'left', 'Continue left'),
	]);
	expect(
		result.messages.map((m) => [m.native_id, m.parent_id]),
	).toEqual([
		['root', null],
		['left', 'root'],
		['right', 'root'],
		['leaf', 'left'],
	]);
	expect(result.messages.every((m) => m.state === 'unknown')).toBe(
		true,
	);
	expect(result.links).toContainEqual({
		record_key: '3',
		kind: 'parent',
		namespace: 'record',
		target: 'progress',
	});
});

test.each([
	[message('gap', 'missing')],
	[message('gap', 'loop'), message('loop', 'gap')],
	[message('gap', 'target')],
	[
		{ type: 'progress', uuid: 'gap', parentUuid: 'root' },
		{ type: 'progress', uuid: 'gap', parentUuid: 'missing' },
	],
])(
	'stops at missing, cyclic or ambiguous non-text ancestry: %j',
	(...gap) => {
		const result = conversation([
			message('root', null, 'Unrelated earlier text'),
			...gap,
			message('target', 'gap', 'Target'),
		]);
		expect(result.messages.at(-1)?.parent_id).toBeNull();
	},
);

test('preserves unknown fields and non-text blocks as raw evidence', () => {
	const value = {
		...entry,
		future: { private: 'retained' },
		message: {
			content: [
				...entry.message.content,
				{ type: 'future_media', data: 'opaque' },
			],
		},
	};
	const result = parse(value);
	expect(result.messages[0]?.content).toBe('Keep this text');
	expect(result.records?.[0]?.raw_json).toBe(JSON.stringify(value));
});
