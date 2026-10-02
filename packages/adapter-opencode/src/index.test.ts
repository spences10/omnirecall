import {
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { Archive } from '../../core/src/database.ts';
import { source_config } from '../../core/src/files.ts';
import {
	focused_read,
	message_ref,
	raw_read,
} from '../../core/src/retrieval.ts';
import { sync } from '../../core/src/sync.ts';
import {
	create_fixture,
	created,
	message,
	messages,
	put_message,
	put_session,
	session,
	session_id,
} from './fixtures.ts';
import { opencode_adapter, parse_opencode } from './index.ts';
const options = { limit: 100, offset: 0, context: 2 };

test('v2 dialogue, tools, reasoning and original row envelopes preserve projection order', () => {
	const rows = messages();
	const parsed = parse_opencode({
		session: session(),
		messages: rows,
	});
	expect(parsed.messages.map((m) => m.content)).toEqual([
		'Prepare the database',
		'Use opencodeneedle migrations safely',
		'Confirm the final checks',
	]);
	expect(parsed.messages[1]!.parent_id).toBe(rows[0]!.id);
	expect(parsed.parts!.map((m) => m.kind)).toEqual([
		'reasoning',
		'tool_call',
		'tool_result',
	]);
	expect(parsed.parts![2]!.parent_id).toBe(
		parsed.parts![1]!.native_id,
	);
	expect(parsed.records).toHaveLength(6);
	for (const [i, row] of rows.entries()) {
		const preserved = parsed.records![i + 1]!;
		expect(JSON.parse(preserved.raw_json)).toEqual({
			...row,
			data: JSON.parse(row.data),
		});
		expect(preserved.raw_json).toContain(row.data);
	}
});

test.each([
	message(5, 'user', { text: 42 }),
	message(5, 'assistant', { content: [{ type: 'text', text: 42 }] }),
	message(5, 'assistant', {
		content: [
			{
				type: 'tool',
				id: 'c',
				name: 'read',
				state: { status: 'completed', input: 'bad', content: [] },
			},
		],
	}),
	{
		...message(5, 'user', { text: 'valid' }),
		data: '{ malformed private payload',
	},
	{ ...message(5, 'user', { text: 'valid' }), session_id: 'wrong' },
	{ ...message(5, 'user', { text: 'valid' }), time_created: -1 },
])(
	'rejects malformed known rows without logging private payloads',
	(row) => {
		expect(() =>
			parse_opencode({
				session: session(),
				messages: [...messages(), row],
			}),
		).toThrow();
		try {
			parse_opencode({
				session: session(),
				messages: [...messages(), row],
			});
		} catch (error) {
			expect(String(error)).not.toContain('private payload');
		}
	},
);

test('unknown records and blocks remain raw with unknown state; context is not user dialogue', () => {
	const rows = [
		...messages(),
		message(5, 'future_event', { opaque: 'retained' }),
		message(6, 'assistant', {
			content: [{ type: 'future_part', data: 'retained' }],
		}),
		message(7, 'synthetic', { text: 'injected context' }),
	];
	const parsed = parse_opencode({
		session: session(),
		messages: rows,
	});
	expect(parsed.records).toHaveLength(rows.length + 1);
	expect(parsed.messages.every((m) => m.state === 'unknown')).toBe(
		true,
	);
	expect(
		parsed.parts!.find((m) => m.content === 'injected context'),
	).toMatchObject({ kind: 'context', role: 'system' });
	expect(parsed.records!.at(-2)!.raw_json).toContain('future_part');
});

test('fork/subagent provenance and revert uncertainty are explicit', () => {
	const parsed = parse_opencode({
		session: {
			...session(),
			parent_id: 'ses_parent',
			fork_session_id: 'ses_fork',
			fork_boundary: JSON.stringify({
				type: 'through',
				messageID: 'msg_boundary',
			}),
			revert: JSON.stringify({ messageID: messages()[2]!.id }),
		},
		messages: messages(),
	});
	expect(parsed.parent_session).toBe('ses_parent');
	expect(parsed.links).toEqual(
		expect.arrayContaining([
			{
				record_key: 'session',
				kind: 'child_session',
				namespace: 'session',
				target: 'ses_parent',
			},
			{
				record_key: 'session',
				kind: 'forked_from',
				namespace: 'session',
				target: 'ses_fork',
			},
		]),
	);
	expect(parsed.messages.every((m) => m.state === 'unknown')).toBe(
		true,
	);
});

test('streaming tool updates and error results retain distinct call/result evidence', () => {
	const parsed = parse_opencode({
		session: session(),
		messages: [
			message(0, 'assistant', {
				time: { created },
				content: [
					{
						type: 'tool',
						id: 'pending',
						name: 'bash',
						state: { status: 'streaming', input: '{"command":' },
					},
					{
						type: 'tool',
						id: 'failed',
						name: 'read',
						state: {
							status: 'error',
							input: { path: 'missing' },
							error: { type: 'error', message: 'not found' },
						},
					},
				],
			}),
		],
	});
	expect(parsed.parts).toHaveLength(3);
	expect(parsed.parts![0]).toMatchObject({
		kind: 'tool_call',
		state: 'in_progress',
	});
	expect(parsed.parts![2]).toMatchObject({
		kind: 'tool_result',
		parent_id: parsed.parts![1]!.native_id,
	});
	expect(parsed.parts![2]!.content).toContain('not found');
});

test('live WAL snapshots catch growth, same-sequence updates, deletion and malformed rows without modifying sources', async () => {
	const root = mkdtempSync(join(tmpdir(), 'omni-opencode-'));
	const path = join(root, 'opencode.db');
	let writer: DatabaseSync | undefined = create_fixture(path);
	const archive = new Archive(':memory:');
	const source = source_config('opencode', root);
	try {
		put_session(writer, 'ses_other');
		const main_bytes = readFileSync(path);
		const wal_bytes = readFileSync(path + '-wal');
		expect(
			await sync(archive, [source], [opencode_adapter]),
		).toMatchObject({ status: 'ok', sessions_updated: 2 });
		expect(readFileSync(path)).toEqual(main_bytes);
		expect(readFileSync(path + '-wal')).toEqual(wal_bytes);
		expect(
			await sync(archive, [source], [opencode_adapter]),
		).toMatchObject({
			status: 'ok',
			sessions_updated: 0,
			files_skipped: 2,
		});
		const scoped = {
			...options,
			session: session_id,
			kind: 'message',
		};
		const hit = archive.recall('opencodeneedle', scoped)[0]!;
		const ref = message_ref(hit);
		expect(hit.before.map((m) => m.content)).toEqual([
			'Prepare the database',
		]);
		expect(hit.after.map((m) => m.content)).toEqual([
			'Confirm the final checks',
		]);
		expect(
			JSON.parse(raw_read(archive, ref, 0, 2000).results[0]!.content)
				.data.content[0].text,
		).toContain('opencodeneedle');
		const tool = archive.search('tooloutputneedle', {
			...options,
			session: session_id,
			kind: 'tool_result',
		})[0]!;
		expect(
			focused_read(archive, message_ref(tool), 1, 0, 1000)
				.messages[0]!.kind,
		).toBe('tool_call');

		// Same ID, seq and timestamps: only committed content changes, inside WAL.
		put_message(
			writer,
			message(2, 'assistant', {
				content: [
					{ type: 'text', text: 'correctedneedle current answer' },
				],
			}),
		);
		expect(readFileSync(path)).toEqual(main_bytes);
		expect(
			await sync(archive, [source], [opencode_adapter]),
		).toMatchObject({
			status: 'ok',
			sessions_updated: 1,
			files_skipped: 1,
		});
		expect(archive.search('opencodeneedle', scoped)).toEqual([]);
		expect(
			focused_read(archive, ref, 0, 0, 1000).messages[0]!.content,
		).toBe('correctedneedle current answer');
		put_message(writer, message(5, 'user', { text: 'growthneedle' }));
		expect(
			(await sync(archive, [source], [opencode_adapter]))
				.sessions_updated,
		).toBe(1);
		expect(archive.search('growthneedle', scoped)).toHaveLength(1);
		writer
			.prepare(
				'DELETE FROM session_message WHERE session_id=? AND seq=5',
			)
			.run(session_id);
		await sync(archive, [source], [opencode_adapter]);
		expect(archive.search('growthneedle', scoped)).toEqual([]);
		put_message(writer, {
			...message(2, 'assistant', {}),
			data: '{private malformed payload',
		});
		const failed = await sync(archive, [source], [opencode_adapter]);
		expect(failed.status).toBe('partial');
		expect(JSON.stringify(failed.issues)).not.toContain(
			'private malformed payload',
		);
		expect(
			focused_read(archive, ref, 0, 0, 1000).messages[0]!.content,
		).toBe('correctedneedle current answer');
		writer.close();
		writer = undefined;
		rmSync(path);
		expect(
			(await sync(archive, [source], [opencode_adapter])).status,
		).toBe('partial');
		expect(archive.search('correctedneedle', scoped)).toHaveLength(1);
		expect(
			focused_read(archive, ref, 0, 0, 1000).results[0]!
				.source_status,
		).toBe('missing');
	} finally {
		writer?.close();
		archive.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('uncommitted writes stay invisible and a concurrent committed change retains the last good import', async () => {
	const root = mkdtempSync(
		join(tmpdir(), 'omni-opencode-concurrent-'),
	);
	const writer = create_fixture(join(root, 'opencode.db'));
	const archive = new Archive(':memory:');
	const source = source_config('opencode', root);
	try {
		await sync(archive, [source], [opencode_adapter]);
		const unit = (await opencode_adapter.discover(root))[0]!;
		const before = await opencode_adapter.fingerprint!(unit);
		writer.exec('BEGIN');
		put_message(
			writer,
			message(2, 'assistant', {
				content: [{ type: 'text', text: 'uncommittedneedle' }],
			}),
		);
		expect(await opencode_adapter.fingerprint!(unit)).toBe(before);
		expect(
			(await opencode_adapter.read(unit)).sessions[0]!.messages[1]!
				.content,
		).toContain('opencodeneedle');
		writer.exec('ROLLBACK');
		put_message(
			writer,
			message(2, 'assistant', {
				time: { created },
				content: [{ type: 'text', text: 'streamingneedle' }],
			}),
		);
		expect(
			(await sync(archive, [source], [opencode_adapter])).status,
		).toBe('ok');
		expect(archive.search('streamingneedle', options)[0]!.state).toBe(
			'in_progress',
		);
		put_message(
			writer,
			message(2, 'assistant', {
				content: [{ type: 'text', text: 'completionneedle' }],
			}),
		);
		const concurrent = {
			...opencode_adapter,
			async read(input: Parameters<typeof opencode_adapter.read>[0]) {
				const captured = await opencode_adapter.read(input);
				put_message(
					writer,
					message(2, 'assistant', {
						content: [{ type: 'text', text: 'concurrentneedle' }],
					}),
				);
				return captured;
			},
		};
		expect(
			(await sync(archive, [source], [concurrent])).issues[0]!.code,
		).toBe('changed');
		expect(archive.search('streamingneedle', options)).toHaveLength(
			1,
		);
		expect(
			archive.search('completionneedle OR concurrentneedle', options),
		).toEqual([]);
		expect(
			(await sync(archive, [source], [opencode_adapter])).status,
		).toBe('ok');
		expect(
			archive.search('concurrentneedle', options)[0]!.state,
		).toBe('active');
	} finally {
		writer.close();
		archive.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a session emptied in place removes searchable parts but retains session metadata', async () => {
	const root = mkdtempSync(join(tmpdir(), 'omni-opencode-empty-'));
	const writer = create_fixture(join(root, 'opencode.db'));
	const archive = new Archive(':memory:');
	const source = source_config('opencode', root);
	try {
		await sync(archive, [source], [opencode_adapter]);
		writer.exec('DELETE FROM session_message');
		expect(
			(await sync(archive, [source], [opencode_adapter]))
				.sessions_updated,
		).toBe(1);
		expect(archive.search('opencodeneedle', options)).toEqual([]);
		expect(archive.sessions(options)).toHaveLength(1);
	} finally {
		writer.close();
		archive.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('legacy layouts and symlink databases are explicitly unsupported', async () => {
	const root = mkdtempSync(join(tmpdir(), 'omni-opencode-legacy-'));
	const path = join(root, 'opencode.db');
	try {
		const legacy = new DatabaseSync(path);
		legacy.exec(
			'CREATE TABLE session(id TEXT); CREATE TABLE message(id TEXT)',
		);
		legacy.close();
		await expect(opencode_adapter.discover(root)).rejects.toThrow(
			'legacy layouts are unsupported',
		);
		rmSync(path);
		const target = join(root, 'target.db');
		create_fixture(target).close();
		symlinkSync(target, path);
		await expect(opencode_adapter.discover(root)).rejects.toThrow(
			'not a symlink',
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
