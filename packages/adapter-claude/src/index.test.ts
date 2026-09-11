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
