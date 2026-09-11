import { afterEach, beforeEach, expect, test } from 'vitest';
import { parse_pi } from '../../adapter-pi/src/index.ts';
import { Archive } from './database.ts';
import { digest, source_config } from './files.ts';
import { pi_entry, pi_records, timestamp } from './fixtures.ts';
import { bounded_json } from './output.ts';
import {
	compact_recall,
	compact_search,
	focused_read,
	message_ref,
	parse_ref,
} from './retrieval.ts';
import type { Transcript } from './types.ts';

let archive: Archive;
const source = source_config('pi', '/synthetic/pi');
const options = { limit: 10, offset: 0, context: 1 };
function store(contents: string[], revision = 'initial') {
	const transcript: Transcript = {
		native_id: 'session',
		project: '/synthetic/project',
		title: 'Migration decision',
		parent_session: null,
		timestamp,
		unindexed_records: 0,
		messages: contents.map((content, index) => ({
			native_id: `message-${index}`,
			parent_id: index ? `message-${index - 1}` : null,
			role: index % 2 ? 'assistant' : 'user',
			content,
			timestamp,
			source_order: index,
			active: true,
			turn_id: null,
		})),
	};
	return archive.store(
		source,
		'/synthetic/pi/session.jsonl',
		transcript,
		{
			hash: digest(revision),
			byte_offset: 1,
			partial: false,
		},
	);
}
beforeEach(() => {
	archive = new Archive(':memory:');
	archive.register(source, 'available');
});
afterEach(() => archive.close());

test('compact search keeps a late match with substantially less output and a stable reference', () => {
	store(['padding '.repeat(1500) + 'migration decision']);
	const full = archive.search('migration', options);
	const compact = compact_search(full);
	expect(compact[0]?.snippet).toContain('migration');
	expect(compact[0]!.char_offset).toBeGreaterThan(4000);
	expect(
		focused_read(
			archive,
			compact[0]!.ref,
			0,
			compact[0]!.char_offset,
			1200,
		).messages[0]?.content,
	).toContain('migration');
	expect(compact[0]).not.toHaveProperty('content');
	expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(
		Buffer.byteLength(JSON.stringify(full)) / 2,
	);
	expect(parse_ref(compact[0]!.ref)).toEqual({
		revision_id: full[0]!.revision_id,
		native_id: full[0]!.native_id,
	});
});

test('exact reads preserve revision identity after updates and report missing references', () => {
	store(['original migration']);
	const ref = compact_search(archive.search('migration', options))[0]!
		.ref;
	store(['replacement migration'], 'replacement');
	const read = focused_read(archive, ref, 0, 0, 1200);
	expect(read.messages[0]?.content).toBe('original migration');
	expect(read.results[0]?.current_revision).toBe(false);
	archive.register(source, 'missing');
	expect(
		focused_read(archive, ref, 0, 0, 1200).results[0]?.source_status,
	).toBe('missing');
	expect(() =>
		focused_read(
			archive,
			message_ref({
				revision_id: '0'.repeat(64),
				native_id: 'absent',
			}),
			0,
			0,
			1200,
		),
	).toThrow('not found');
});

test('long Unicode messages can be reconstructed exactly from bounded character pages', () => {
	const content = '🌱 café migration\n'.repeat(500);
	store([content]);
	const ref = compact_search(archive.search('migration', options))[0]!
		.ref;
	let offset = 0;
	let reconstructed = '';
	for (let page = 0; page < 100; page++) {
		const read = focused_read(archive, ref, 0, offset, 1200);
		const message = read.messages[0]!;
		expect(Array.from(message.content).length).toBeLessThanOrEqual(
			1200,
		);
		reconstructed += message.content;
		if (message.next_char_offset === null) break;
		expect(message.next_char_offset).toBeGreaterThan(offset);
		offset = message.next_char_offset;
	}
	expect(reconstructed).toBe(content);
	expect(() =>
		focused_read(
			archive,
			ref,
			0,
			Array.from(content).length + 1,
			1200,
		),
	).toThrow('exceeds');
});

test('focused windows provide adjacent references without returning the entire session', () => {
	store(['start', 'before', 'migration', 'after', 'end']);
	const ref = compact_search(archive.search('migration', options))[0]!
		.ref;
	const read = focused_read(archive, ref, 1, 0, 1200);
	expect(read.messages.map((message) => message.content)).toEqual([
		'before',
		'migration',
		'after',
	]);
	expect(
		focused_read(archive, read.results[0]!.previous_ref!, 0, 0, 1200)
			.messages[0]?.content,
	).toBe('start');
	expect(
		focused_read(archive, read.results[0]!.next_ref!, 0, 0, 1200)
			.messages[0]?.content,
	).toBe('end');
});

test('compact recall deduplicates overlapping context and prunes unreferenced messages under budget', () => {
	store([
		'migration one',
		'migration two',
		'migration three',
		'migration four',
	]);
	const compact = compact_recall(
		archive.recall('migration', options),
	);
	expect(compact.results).toHaveLength(4);
	expect(compact.messages).toHaveLength(4);
	const envelope = {
		schema_version: 2,
		status: 'ok',
		...compact,
		offset: 0,
		returned_count: 4,
		has_more: false,
		next_offset: null,
	};
	const parsed = JSON.parse(bounded_json(envelope, 2200));
	expect(parsed.results.length).toBeGreaterThan(0);
	expect(parsed.results.length).toBeLessThan(4);
	const refs = new Set(
		parsed.results.flatMap(
			(row: { ref: string; before: string[]; after: string[] }) => [
				row.ref,
				...row.before,
				...row.after,
			],
		),
	);
	expect(
		new Set(
			parsed.messages.map((message: { ref: string }) => message.ref),
		),
	).toEqual(refs);
	expect(parsed.next_offset).toBe(parsed.results.length);
	expect(
		Buffer.byteLength(bounded_json(envelope, 2200)) + 1,
	).toBeLessThanOrEqual(2200);
	const empty = JSON.parse(bounded_json(envelope, 1024));
	expect(empty).toMatchObject({
		results: [],
		messages: [],
		next_offset: 0,
		output_budget_exceeded: true,
	});
});

test('references distinguish sessions and round-trip Unicode and punctuation in native IDs', () => {
	const identity = {
		revision_id: 'a'.repeat(64),
		native_id: '🌱 / a:b.%',
	};
	expect(parse_ref(message_ref(identity))).toEqual(identity);
	for (const ref of [
		'',
		'guess',
		`m1.${'a'.repeat(64)}._w`,
		message_ref(identity) + '=',
	])
		expect(() => parse_ref(ref)).toThrow('Invalid message reference');
	const one = store(['migration']);
	const two = store(['migration'], 'second');
	expect(
		message_ref({
			revision_id: one.revision_id,
			native_id: 'message-0',
		}),
	).not.toBe(
		message_ref({
			revision_id: two.revision_id,
			native_id: 'message-0',
		}),
	);
});

test('focused history stops at ambiguous child branches and never joins the active sibling', () => {
	const transcript = parse_pi(
		[
			...pi_records(),
			pi_entry('old-sibling', 'a1', 'user', 'abandoned alternative'),
			pi_entry(
				'active-sibling',
				'u1',
				'assistant',
				'current alternative',
			),
		].map((value, byte_offset) => ({ value, byte_offset })),
	);
	archive.store(source, '/synthetic/pi/branches.jsonl', transcript, {
		hash: digest('branches'),
		byte_offset: 1,
		partial: false,
	});
	const hit = compact_search(
		archive.search('migrations', {
			...options,
			include_history: true,
		}),
	)[0]!;
	const read = focused_read(archive, hit.ref, 2, 0, 1200);
	expect(read.results[0]).toMatchObject({
		active: false,
		branch_boundary: true,
		after: [],
		next_ref: null,
	});
	expect(
		read.messages.map((message) => message.content),
	).not.toContain('current alternative');
});
