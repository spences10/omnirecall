import {
	mkdtempSync,
	writeFileSync,
	rmSync,
	mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { pi_adapter, parse_pi } from '../../adapter-pi/src/index.ts';
import { claude_adapter } from '../../adapter-claude/src/index.ts';
import { codex_adapter } from '../../adapter-codex/src/index.ts';
import { Archive } from './database.ts';
import { source_config } from './files.ts';
import {
	pi_records,
	pi_entry,
	timestamp,
	jsonl,
	codex_records,
	codex_entry,
	codex_item,
} from './fixtures.ts';
import { sync } from './sync.ts';
import { message_ref, raw_read, focused_read } from './retrieval.ts';
import type { Adapter } from './types.ts';
const options = { limit: 100, offset: 0, context: 1 };

async function fixture(
	run: (root: string, archive: Archive, db: string) => Promise<void>,
) {
	const root = mkdtempSync(join(tmpdir(), 'omni-evidence-')),
		db = join(root, 'archive.db');
	const archive = new Archive(db);
	try {
		await run(root, archive, db);
	} finally {
		archive.close();
		rmSync(root, { recursive: true, force: true });
	}
}

test('Pi tools, thinking and complete original envelopes survive source removal with bounded reads', async () =>
	fixture(async (root, archive) => {
		const file = join(root, 'session.jsonl');
		const records = [
			...pi_records(),
			pi_entry('calls', 'u2', 'assistant', [
				{
					type: 'toolCall',
					id: 'c1',
					name: 'bash',
					arguments: { command: 'run_unique_command' },
				},
				{
					type: 'toolCall',
					id: 'c2',
					name: 'read',
					arguments: { path: 'another-file' },
				},
			]),
			{
				...pi_entry('result', 'calls', 'toolResult', [
					{ type: 'text', text: 'unique_failure café' },
				]),
				message: {
					role: 'toolResult',
					toolCallId: 'c1',
					isError: true,
					details: { extra: 'retained detail' },
					content: [{ type: 'text', text: 'unique_failure café' }],
				},
			},
		];
		writeFileSync(file, jsonl(records));
		const source = source_config('pi', root);
		expect((await sync(archive, [source], [pi_adapter])).status).toBe(
			'ok',
		);
		const hit = archive.search('unique_failure', options)[0]!;
		expect(hit.kind).toBe('tool_result');
		expect(
			archive.search('unique_failure', {
				...options,
				kind: 'message',
			}),
		).toEqual([]);
		expect(
			archive.search('hidden-secret-thought', {
				...options,
				kind: 'reasoning',
			}),
		).toHaveLength(1);
		expect(
			focused_read(archive, message_ref(hit), 1, 0, 100).messages[0]!
				.content,
		).toContain('run_unique_command');
		const ref = message_ref(hit);
		rmSync(file);
		expect((await sync(archive, [source], [pi_adapter])).status).toBe(
			'ok',
		);
		const raw = raw_read(archive, ref, 0, 2000).results[0]!;
		expect(JSON.parse(raw.content).message.details.extra).toBe(
			'retained detail',
		);
		let content = '',
			offset = 0;
		do {
			const row = raw_read(archive, ref, offset, 17).results[0]!;
			content += row.content;
			offset = row.next_char_offset ?? -1;
		} while (offset !== -1);
		expect(content).toBe(raw.content);
		expect(raw.previous_ref).toBeTruthy();
		expect(
			raw_read(archive, raw.previous_ref!, 0, 2000).results[0]!
				.content,
		).toContain('run_unique_command');
		expect(
			raw_read(
				archive,
				archive.sessions(options)[0]!.first_record_ref!,
				0,
				2000,
			).results[0]!.native_type,
		).toBe('session');
	}));

test('Claude preserves mixed tool blocks, attachment envelopes and separate subagent conversations', async () =>
	fixture(async (root, archive) => {
		const rows = [
			{
				type: 'attachment',
				sessionId: 's',
				attachment: { text: 'opaque_metadata' },
			},
			{
				type: 'assistant',
				sessionId: 's',
				uuid: 'a',
				timestamp,
				cwd: '/project',
				message: {
					role: 'assistant',
					content: [
						{ type: 'text', text: 'Investigating' },
						{
							type: 'tool_use',
							id: 'call',
							name: 'Bash',
							input: { command: 'check_database' },
						},
					],
				},
			},
			{
				type: 'user',
				sessionId: 's',
				uuid: 'b',
				parentUuid: 'a',
				timestamp,
				message: {
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'call',
							is_error: true,
							content: [{ type: 'text', text: 'database_failure' }],
						},
					],
				},
			},
		];
		writeFileSync(join(root, 'main.jsonl'), jsonl(rows));
		const sub = join(root, 's', 'subagents');
		mkdirSync(sub, { recursive: true });
		writeFileSync(join(sub, 'agent-review.jsonl'), jsonl(rows));
		expect(
			(
				await sync(
					archive,
					[source_config('claude', root)],
					[claude_adapter],
				)
			).status,
		).toBe('ok');
		expect(archive.sessions(options)).toHaveLength(2);
		const hits = archive.search('database_failure', options);
		expect(hits).toHaveLength(2);
		expect(hits[0]!.state).toBe('unknown');
		const window = focused_read(
			archive,
			message_ref(hits[0]!),
			1,
			0,
			1000,
		);
		expect(window.messages[0]!.content).toContain('check_database');
		const raw = raw_read(
			archive,
			archive.sessions(options)[0]!.first_record_ref!,
			0,
			2000,
		).results[0]!;
		expect(raw.content).toContain('opaque_metadata');
	}));

test('Codex corrections point to the corrected envelope and rolled-back tool-only turns stay historical', async () =>
	fixture(async (root, archive) => {
		const rows = [
			...codex_records(),
			codex_item('a1', 'AgentMessage', 'corrected_identity'),
			codex_entry('event_msg', {
				type: 'task_started',
				turn_id: 'tool-turn',
			}),
			codex_entry('response_item', {
				type: 'function_call',
				call_id: 'call',
				name: 'exec',
				arguments: 'abandoned_tool',
			}),
			codex_entry('event_msg', {
				type: 'thread_rolled_back',
				num_turns: 1,
			}),
		];
		writeFileSync(join(root, 'session.jsonl'), jsonl(rows));
		expect(
			(
				await sync(
					archive,
					[source_config('codex', root)],
					[codex_adapter],
				)
			).status,
		).toBe('ok');
		const hit = archive.search('corrected_identity', options)[0]!;
		expect(
			raw_read(archive, message_ref(hit), 0, 2000).results[0]!
				.content,
		).toContain('corrected_identity');
		expect(archive.search('abandoned_tool', options)).toHaveLength(0);
		expect(
			archive.search('abandoned_tool', {
				...options,
				include_history: true,
			}),
		).toHaveLength(1);
	}));

test('core accepts multi-session, multi-input units without knowing JSONL and records all provenance', async () =>
	fixture(async (root, archive, db) => {
		const adapter: Adapter = {
			agent: 'synthetic',
			parser_version: 1,
			discover: async () => [
				{ key: 'unit', locators: ['database:a', 'database:b'] },
			],
			read: async () => ({
				inputs: ['database:a', 'database:b'].map((path) => ({
					path,
					hash: 'stable',
					byte_offset: 0,
					partial: false,
				})),
				sessions: ['one', 'two'].map((id) =>
					parse_pi(
						pi_records(id).map((value, byte_offset) => ({
							value,
							byte_offset,
						})),
					),
				),
			}),
		};
		const read = adapter.read.bind(adapter);
		adapter.read = async (unit) => {
			const batch = await read(unit);
			for (const session of batch.sessions)
				for (const record of session.records ?? [])
					record.input_path =
						batch.inputs[record.source_order % 2]!.path;
			return batch;
		};
		const source = source_config('synthetic', root);
		expect(
			(await sync(archive, [source], [adapter])).sessions_updated,
		).toBe(2);
		expect(
			(await sync(archive, [source], [adapter])).sessions_updated,
		).toBe(0);
		expect(archive.search('migrations', options)).toHaveLength(2);
		const inspect = new DatabaseSync(db);
		try {
			expect(
				inspect
					.prepare('SELECT count(*) AS n FROM session_inputs')
					.get()!.n,
			).toBe(4);
			expect(
				inspect.prepare('PRAGMA foreign_key_check').all(),
			).toEqual([]);
			inspect.exec(
				"INSERT INTO parts_fts(parts_fts,rank) VALUES('integrity-check',1)",
			);
			const part = inspect
				.prepare('SELECT rowid FROM parts LIMIT 1')
				.get()!;
			inspect
				.prepare('UPDATE parts SET content=? WHERE rowid=?')
				.run('fts_replacement', part.rowid!);
			expect(archive.search('fts_replacement', options)).toHaveLength(
				1,
			);
			inspect
				.prepare('DELETE FROM parts WHERE rowid=?')
				.run(part.rowid!);
			expect(archive.search('fts_replacement', options)).toHaveLength(
				0,
			);
		} finally {
			inspect.close();
		}
	}));

test('a failed multi-session unit rolls back all sessions and resource checkpoints', async () =>
	fixture(async (root, archive, db) => {
		const source = source_config('synthetic', root);
		const adapter: Adapter = {
			agent: 'synthetic',
			parser_version: 1,
			discover: async () => [
				{ key: 'unit', locators: ['source-db'] },
			],
			read: async () => ({
				inputs: [
					{
						path: 'source-db',
						hash: 'one',
						byte_offset: 100,
						partial: false,
					},
				],
				sessions: ['one', 'two'].map((id) =>
					parse_pi(
						pi_records(id).map((value, byte_offset) => ({
							value,
							byte_offset,
						})),
					),
				),
			}),
		};
		const inspect = new DatabaseSync(db);
		try {
			inspect.exec(
				"CREATE TRIGGER fail_second BEFORE INSERT ON sessions WHEN new.native_id='two' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
			);
			const result = await sync(archive, [source], [adapter]);
			expect(result.sessions_updated).toBe(0);
			expect(archive.sessions(options)).toEqual([]);
			expect(
				inspect.prepare('SELECT byte_offset FROM resources').get()!
					.byte_offset,
			).toBeNull();
			expect(
				inspect.prepare('SELECT count(*) AS n FROM records').get()!.n,
			).toBe(0);
		} finally {
			inspect.close();
		}
	}));

test('Codex realtime transcript evidence can be searched and read with exact provenance', async () =>
	fixture(async (root, archive) => {
		const segment = codex_entry('realtime_item', {
			id: 'segment',
			realtime_session_id: 'rt-1',
			type: 'transcript_segment',
			role: 'assistant',
			text: 'realtime_unique café reply',
		});
		writeFileSync(
			join(root, 'session.jsonl'),
			jsonl([codex_records()[0]!, segment]),
		);
		expect(
			await sync(
				archive,
				[source_config('codex', root)],
				[codex_adapter],
			),
		).toMatchObject({ sessions_updated: 1, failures: 0 });
		const hit = archive.search('realtime_unique', options)[0]!;
		expect(hit).toMatchObject({
			content: 'realtime_unique café reply',
			state: 'unknown',
			json_pointer: '/payload/text',
		});
		const raw = raw_read(archive, message_ref(hit), 0, 2000);
		expect(JSON.parse(raw.results[0]!.content)).toEqual(segment);
	}));
