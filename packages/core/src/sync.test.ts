import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { codex_adapter } from '../../adapter-codex/src/index.ts';
import { pi_adapter } from '../../adapter-pi/src/index.ts';
import { Archive, type QueryOptions } from './database.ts';
import { jsonl_adapter, source_config } from './files.ts';
import {
	codex_entry,
	codex_item,
	codex_records,
	jsonl,
	pi_entry,
	pi_records,
	timestamp,
} from './fixtures.ts';
import { sync } from './sync.ts';
import { type Adapter, type Source } from './types.ts';

let root: string;
let archive: Archive;
let inspection: DatabaseSync;
let sources: Source[];
const adapters = [pi_adapter, codex_adapter];
const options: QueryOptions = { limit: 10, offset: 0, context: 2 };
function path_for(agent: string) {
	return join(root, agent, 'session.jsonl');
}
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'omnirecall-test-'));
	for (const agent of ['pi', 'codex']) mkdirSync(join(root, agent));
	sources = [
		source_config('pi', join(root, 'pi')),
		source_config('codex', join(root, 'codex')),
	];
	archive = new Archive(join(root, 'omnirecall.db'));
	inspection = new DatabaseSync(join(root, 'omnirecall.db'));
	writeFileSync(path_for('pi'), jsonl(pi_records()));
	writeFileSync(path_for('codex'), jsonl(codex_records()));
});
afterEach(() => {
	inspection.close();
	archive.close();
	rmSync(root, { recursive: true, force: true });
});

test('cross-agent archive, source-qualified collisions, equal timestamps, context and immutability', async () => {
	const originals = sources.map((source) =>
		readFileSync(path_for(source.agent)),
	);
	const result = await sync(archive, sources, adapters);
	expect(result.status).toBe('ok');
	expect(result.sessions_updated).toBe(2);
	const matches = archive.search('café migrations', options);
	expect(matches).toHaveLength(2);
	expect(new Set(matches.map((match) => match.session_id)).size).toBe(
		2,
	);
	for (const match of matches) {
		const context = archive.context(
			match.archive_id,
			match.native_id,
			2,
		);
		expect(context.before.map((row) => row.content)).toEqual([
			'Prepare the database',
		]);
		expect(context.after.map((row) => row.content)).toEqual([
			'Confirm the final checks',
		]);
		expect(match.title).toContain('migration plan');
	}
	expect(
		archive.search('hidden-secret-thought', options),
	).toHaveLength(1);
	expect(archive.search('private-tool-output', options)).toHaveLength(
		2,
	);
	expect(
		archive.search('migrations', { ...options, agent: 'pi' }),
	).toHaveLength(1);
	expect(
		archive.search('migrations', {
			...options,
			source: sources[1]!.source_id,
		}),
	).toHaveLength(1);
	expect(
		archive.search('migrations', {
			...options,
			project: '/synthetic/project',
		}),
	).toHaveLength(2);
	expect(
		archive.search('migrations', {
			...options,
			project: '/synthetic',
		}),
	).toEqual([]);
	expect(
		archive.search('migrations', {
			...options,
			session: matches[0]!.session_id,
		}),
	).toHaveLength(1);
	expect(
		archive.search('migrations', {
			...options,
			after: '2027-01-01T00:00:00.000Z',
		}),
	).toEqual([]);
	expect(
		(await sync(archive, sources, adapters)).sessions_updated,
	).toBe(0);
	expect(
		inspection.prepare('SELECT * FROM parts').all(),
	).toHaveLength(9);
	for (let i = 0; i < sources.length; i++)
		expect(readFileSync(path_for(sources[i]!.agent))).toEqual(
			originals[i],
		);
});

test('all failed file transactions report an operational failure with no committed progress', async () => {
	inspection.exec(
		"CREATE TRIGGER fail_message BEFORE INSERT ON parts BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
	);
	const result = await sync(archive, sources, adapters);
	expect(result.status).toBe('error');
	expect(result.operational_failures).toBe(2);
	expect(result.issues[0]?.message).toContain('synthetic failure');
	expect(inspection.prepare('SELECT * FROM sessions').all()).toEqual(
		[],
	);
	expect(
		inspection
			.prepare('SELECT byte_offset FROM resources')
			.all()
			.every((row) => row.byte_offset === null),
	).toBe(true);
});

test('SQL-level excerpts stay bounded and a late match remains visible in its snippet', async () => {
	writeFileSync(
		path_for('pi'),
		jsonl([
			...pi_records(),
			pi_entry(
				'large',
				'u2',
				'assistant',
				'padding '.repeat(3000) + 'latekeyword',
			),
		]),
	);
	await sync(archive, sources, adapters);
	const match = archive.search('latekeyword', options)[0]!;
	expect(match.content.length).toBe(4000);
	expect(match.content_truncated).toBe(1);
	expect(match.snippet).toContain('latekeyword');
	expect(() => archive.search('" OR 1=1 --', options)).toThrow(
		'Invalid FTS5 query',
	);
	expect(archive.search('latekeyword', options)).toHaveLength(1);
});

test('Codex sidecar titles create an immutable metadata revision', async () => {
	await sync(archive, sources, adapters);
	const index = join(root, 'codex', 'session_index.jsonl');
	writeFileSync(
		index,
		jsonl([
			{
				id: 'collision',
				thread_name: 'Latest title',
				updated_at: '2026-09-02T00:00:00Z',
			},
			{
				id: 'collision',
				thread_name: 'Older title',
				updated_at: '2026-09-01T00:00:00Z',
			},
		]),
	);
	const original = readFileSync(index);
	const result = await sync(archive, sources, adapters);
	expect(result.status).toBe('ok');
	expect(result.sessions_updated).toBe(1);
	expect(
		archive.search('migrations', { ...options, agent: 'codex' })[0]
			?.title,
	).toBe('Latest title');
	expect(readFileSync(index)).toEqual(original);
	rmSync(index);
	await sync(archive, sources, adapters);
	expect(
		archive.search('migrations', { ...options, agent: 'codex' })[0]
			?.title,
	).toBe('Codex migration plan');
});

test('a change between discovery and ingestion is reported without selecting it', async () => {
	await sync(archive, sources, adapters);
	const changing: import('./types.ts').JsonlAdapter = {
		...pi_adapter,
		parse: (records) => {
			const transcript = pi_adapter.parse(records);
			appendFileSync(
				path_for('pi'),
				jsonl([pi_entry('race', 'u2', 'assistant', 'racing update')]),
			);
			return transcript;
		},
	};
	const result = await sync(archive, [sources[0]!], [changing]);
	expect(result.issues[0]?.code).toBe('changed');
	expect(archive.search('racing', options)).toEqual([]);
	expect(archive.search('migrations', options)).toHaveLength(2);
});

test('same native ID in separate roots stays separate', async () => {
	const other = join(root, 'other');
	mkdirSync(other);
	writeFileSync(join(other, 'copy.jsonl'), jsonl(pi_records()));
	await sync(
		archive,
		[...sources, source_config('pi', other)],
		adapters,
	);
	expect(archive.search('migrations', options)).toHaveLength(3);
});

test('complete UTF-8 checkpoints survive partial writes and invalid complete lines', async () => {
	await sync(archive, sources, adapters);
	const record = Buffer.from(
		jsonl([
			pi_entry('a2', 'u2', 'assistant', 'Résumé café response'),
		]),
	);
	const split = record.indexOf(Buffer.from('é')) + 1;
	appendFileSync(path_for('pi'), record.subarray(0, split));
	const result = await sync(archive, sources, adapters);
	expect(result.partial_files).toBe(1);
	expect(result.sessions_updated).toBe(0);
	expect(archive.search('Résumé', options)).toEqual([]);
	appendFileSync(path_for('pi'), record.subarray(split));
	expect(
		(await sync(archive, sources, adapters)).sessions_updated,
	).toBe(1);
	expect(archive.search('Résumé', options)).toHaveLength(1);
	const checkpoint = inspection
		.prepare('SELECT byte_offset FROM resources WHERE path=?')
		.get(path_for('pi'));
	appendFileSync(path_for('pi'), 'broken-json\n');
	expect(
		(await sync(archive, sources, adapters)).issues[0]?.code,
	).toBe('invalid');
	expect(
		inspection
			.prepare('SELECT byte_offset FROM resources WHERE path=?')
			.get(path_for('pi')),
	).toEqual(checkpoint);
	expect(archive.search('Résumé', options)).toHaveLength(1);
});

test.each(['pi', 'codex'])(
	'%s unknown events remain archived',
	async (agent) => {
		await sync(archive, sources, adapters);
		const entry =
			agent === 'pi'
				? { type: 'future', id: 'future', parentId: 'u2', timestamp }
				: codex_entry('future', {});
		appendFileSync(path_for(agent), jsonl([entry]));
		expect(await sync(archive, sources, adapters)).toMatchObject({
			status: 'ok',
			failures: 0,
			sessions_updated: 1,
		});
		expect(
			inspection
				.prepare(
					"SELECT raw_json FROM records WHERE native_type='future'",
				)
				.all(),
		).toHaveLength(1);
		expect(archive.search('migrations', options)).toHaveLength(2);
	},
);

test('file transaction rolls back FTS, session writes and checkpoint', async () => {
	await sync(archive, sources, adapters);
	const before = inspection.prepare('SELECT * FROM sessions').all();
	const checkpoint = inspection
		.prepare(
			'SELECT archive_id,byte_offset FROM resources WHERE path=?',
		)
		.get(path_for('pi'));
	appendFileSync(
		path_for('pi'),
		jsonl([pi_entry('a2', 'u2', 'assistant', 'transaction keyword')]),
	);
	inspection.exec(
		"CREATE TRIGGER fail_message BEFORE INSERT ON parts BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;",
	);
	expect((await sync(archive, sources, adapters)).failures).toBe(1);
	expect(inspection.prepare('SELECT * FROM sessions').all()).toEqual(
		before,
	);
	expect(
		inspection
			.prepare(
				'SELECT archive_id,byte_offset FROM resources WHERE path=?',
			)
			.get(path_for('pi')),
	).toEqual(checkpoint);
	expect(archive.search('transaction', options)).toEqual([]);
	inspection.exec('DROP TRIGGER fail_message');
	expect(
		(await sync(archive, sources, adapters)).sessions_updated,
	).toBe(1);
});

test('missing files and unavailable roots retain searchable sessions', async () => {
	await sync(archive, sources, adapters);
	rmSync(path_for('pi'));
	await sync(archive, sources, adapters);
	expect(
		archive.search('migrations', { ...options, agent: 'pi' })[0]
			?.path_status,
	).toBe('missing');
	renameSync(join(root, 'codex'), join(root, 'offline'));
	expect(
		(await sync(archive, sources, adapters)).issues[0]?.code,
	).toBe('missing');
	expect(
		archive.search('migrations', { ...options, agent: 'codex' })[0]
			?.source_status,
	).toBe('missing');
});

test('blocked discovery retains known paths and reports access failure', async () => {
	await sync(archive, sources, adapters);
	const blocked: Adapter = {
		...pi_adapter,
		discover: async () => {
			throw Object.assign(new Error('denied'), { code: 'EACCES' });
		},
	};
	const result = await sync(archive, [sources[0]!], [blocked]);
	expect(result.issues[0]?.code).toBe('blocked');
	expect(
		archive.search('migrations', { ...options, agent: 'pi' })[0]
			?.source_status,
	).toBe('blocked');
	expect(
		inspection
			.prepare('SELECT status FROM resources WHERE path=?')
			.get(path_for('pi'))?.status,
	).toBe('available');
});

test('unsupported and legacy inputs are explicit, not empty successful imports', async () => {
	writeFileSync(
		path_for('codex'),
		jsonl([
			codex_entry('session_meta', {
				id: 'legacy',
				history_mode: 'legacy',
			}),
		]),
	);
	writeFileSync(
		path_for('pi'),
		jsonl([{ type: 'session', version: 1 }]),
	);
	const result = await sync(archive, sources, adapters);
	expect(result.status).toBe('partial');
	expect(result.issues.map((issue) => issue.code)).toEqual([
		'unsupported',
		'legacy',
	]);
	expect(archive.sessions(options)).toEqual([]);
});

test('Pi branch context follows parents, never chronological siblings', async () => {
	await sync(archive, sources, adapters);
	appendFileSync(
		path_for('pi'),
		jsonl([
			pi_entry(
				'branch',
				'u1',
				'assistant',
				'Alternative migration strategy',
			),
		]),
	);
	await sync(archive, sources, adapters);
	expect(
		archive.search('migrations', { ...options, agent: 'pi' }),
	).toEqual([]);
	const match = archive.search('Alternative', options)[0]!;
	expect(
		archive
			.context(match.archive_id, 'branch', 10)
			.before.map((row) => row.native_id),
	).toEqual(['u1']);
	const historical = archive.search('migrations', {
		...options,
		agent: 'pi',
		include_history: true,
	});
	expect(historical.length).toBeGreaterThan(0);
	for (const row of historical)
		expect(
			archive
				.context(row.archive_id, 'a1', 10)
				.after.map((entry) => entry.native_id),
		).not.toContain('branch');
});

test('Codex rollback and item correction update stored messages without linearizing abandoned turns', async () => {
	await sync(archive, sources, adapters);
	appendFileSync(
		path_for('codex'),
		jsonl([
			codex_entry('event_msg', {
				type: 'thread_rolled_back',
				num_turns: 1,
			}),
			codex_entry('event_msg', {
				type: 'task_started',
				turn_id: 'turn-2',
			}),
			codex_item(
				'new-user',
				'UserMessage',
				'Replacement approach',
				'turn-2',
			),
			codex_item(
				'new-answer',
				'AgentMessage',
				'A corrected answer',
				'turn-2',
			),
		]),
	);
	await sync(archive, sources, adapters);
	expect(
		archive.search('migrations', { ...options, agent: 'codex' }),
	).toEqual([]);
	const match = archive.search('corrected', options)[0]!;
	expect(
		archive
			.context(match.archive_id, 'new-answer', 10)
			.before.map((row) => row.native_id),
	).toEqual(['new-user']);
	appendFileSync(
		path_for('codex'),
		jsonl([
			codex_item(
				'new-answer',
				'AgentMessage',
				'A revised answer',
				'turn-2',
			),
		]),
	);
	await sync(archive, sources, adapters);
	expect(archive.search('corrected', options)).toEqual([]);
	expect(
		archive.search('corrected', {
			...options,
			include_history: true,
		}),
	).toHaveLength(1);
	expect(archive.search('revised', options)).toHaveLength(1);
});

test('rewrites replace stored content; separate files remain separate sessions', async () => {
	await sync(archive, sources, adapters);
	writeFileSync(
		path_for('pi'),
		jsonl(pi_records()).replace('safely', 'surely'),
	);
	expect(
		(await sync(archive, sources, adapters)).sessions_updated,
	).toBe(1);
	expect(
		archive.search('safely', { ...options, agent: 'pi' }),
	).toEqual([]);
	expect(
		archive.search('safely', {
			...options,
			agent: 'pi',
			include_history: true,
		}),
	).toHaveLength(0);
	writeFileSync(
		join(root, 'pi', 'duplicate.jsonl'),
		jsonl(pi_records()),
	);
	const result = await sync(archive, sources, adapters);
	expect(
		result.issues.filter((issue) => issue.code === 'conflict'),
	).toHaveLength(0);
	expect(archive.search('surely', options)).toHaveLength(1);
	rmSync(join(root, 'pi', 'duplicate.jsonl'));
	writeFileSync(path_for('pi'), jsonl(pi_records().slice(0, 1)));
	await sync(archive, sources, adapters);
	expect(archive.search('surely', options)).toHaveLength(0);
	expect(
		archive.search('surely', { ...options, include_history: true }),
	).toHaveLength(0);
});

test('invalid adapter output preserves the selected revision and checkpoint', async () => {
	await sync(archive, sources, adapters);
	const checkpoint = inspection
		.prepare(
			'SELECT archive_id, byte_offset FROM resources WHERE path=?',
		)
		.get(path_for('pi'));
	const malformed: Adapter = {
		...pi_adapter,
		async read(unit) {
			const batch = await pi_adapter.read(unit);
			batch.sessions[0]!.messages[0]!.source_order = -1;
			return batch;
		},
	};
	const result = await sync(archive, [sources[0]!], [malformed]);
	expect(result).toMatchObject({
		status: 'partial',
		failures: 1,
		operational_failures: 0,
		sessions_updated: 0,
	});
	expect(result.issues[0]).toMatchObject({
		code: 'invalid',
		message:
			'Adapter pi output: invalid field sessions.0.messages.0.source_order',
	});
	expect(
		inspection
			.prepare(
				'SELECT archive_id, byte_offset FROM resources WHERE path=?',
			)
			.get(path_for('pi')),
	).toEqual(checkpoint);
	expect(archive.search('migrations', options)).toHaveLength(2);
});

test('progress reports imports and failures in one pass', async () => {
	writeFileSync(join(root, 'pi', 'broken.jsonl'), 'broken\n');
	const events: import('./sync.ts').SyncProgress[] = [];
	const result = await sync(archive, [sources[0]!], adapters, (e) =>
		events.push(e),
	);
	expect(events[0]?.phase).toBe('discovering');
	expect(events.at(-1)).toMatchObject({
		phase: 'source_done',
		completed: 2,
		total: 2,
		files_indexed: 1,
		failures: 1,
	});
	expect(result.failures).toBe(1);
});

test('parses once initially, persists the cache across reopen, and skips unchanged inputs', async () => {
	let parses = 0;
	const counted = jsonl_adapter('pi', (records) => {
		parses++;
		return pi_adapter.parse(records);
	});
	const first = await sync(archive, [sources[0]!], [counted]);
	expect(first).toMatchObject({
		sessions_updated: 1,
		files_skipped: 0,
	});
	expect(parses).toBe(1);
	archive.close();
	archive = new Archive(join(root, 'omnirecall.db'));
	const second = await sync(archive, [sources[0]!], [counted]);
	expect(second).toMatchObject({
		sessions_updated: 0,
		files_indexed: 1,
		files_skipped: 1,
	});
	expect(parses).toBe(1);
	expect(archive.search('migrations', options)).toHaveLength(1);
});

test('same-size rewrite with restored mtime invalidates the cache through ctime', async () => {
	await sync(archive, sources, adapters);
	const path = path_for('pi');
	const before = statSync(path);
	writeFileSync(
		path,
		readFileSync(path, 'utf8').replace('safely', 'surely'),
	);
	utimesSync(path, before.atime, before.mtime);
	const result = await sync(archive, sources, adapters);
	expect(result).toMatchObject({
		sessions_updated: 1,
		files_skipped: 1,
	});
	expect(archive.search('surely', options)).toHaveLength(1);
	expect(
		archive.search('safely', { ...options, agent: 'pi' }),
	).toEqual([]);
});

test('copies have stable independent identities across edits and disappearance', async () => {
	await sync(archive, sources, adapters);
	const copy = join(root, 'pi', 'copy.jsonl');
	writeFileSync(
		copy,
		jsonl(pi_records()).replace('safely', 'surely'),
	);
	await sync(archive, [sources[0]!], adapters);
	const ids = archive
		.sessions({ ...options, agent: 'pi' })
		.map((s) => s.session_id)
		.sort();
	writeFileSync(
		path_for('pi'),
		jsonl(pi_records()).replace('safely', 'updated'),
	);
	await sync(archive, [sources[0]!], adapters);
	expect(
		archive
			.sessions({ ...options, agent: 'pi' })
			.map((s) => s.session_id)
			.sort(),
	).toEqual(ids);
	expect(
		archive.search('safely', { ...options, agent: 'pi' }),
	).toEqual([]);
	expect(archive.search('updated', options)).toHaveLength(1);
	expect(archive.search('surely', options)).toHaveLength(1);
	rmSync(copy);
	expect(
		(await sync(archive, [sources[0]!], adapters)).files_skipped,
	).toBe(1);
	expect(archive.search('surely', options)).toHaveLength(1);
});

test('parser version changes and corrupt acceleration data force a fresh parse', async () => {
	let parses = 0;
	const counted = jsonl_adapter('pi', (records) => {
		parses++;
		return pi_adapter.parse(records);
	});
	await sync(archive, [sources[0]!], [counted]);
	counted.parser_version++;
	expect(
		(await sync(archive, [sources[0]!], [counted])).sessions_updated,
	).toBe(1);
	expect(parses).toBe(2);
	inspection.exec("UPDATE sync_cache SET data='broken'");
	expect(
		(await sync(archive, [sources[0]!], [counted])).files_skipped,
	).toBe(0);
	expect(parses).toBe(3);
});

test.each([false, true])(
	'a source changed before reading is imported (cached=%s)',
	async (cached) => {
		if (cached) await sync(archive, [sources[0]!], adapters);
		const result = await sync(
			archive,
			[sources[0]!],
			adapters,
			(event) => {
				if (event.phase === 'importing' && event.completed === 0)
					appendFileSync(
						path_for('pi'),
						jsonl([
							pi_entry('race', 'u2', 'assistant', 'uncommitted-race'),
						]),
					);
			},
		);
		expect(result.issues).toEqual([]);
		expect(result.sessions_updated).toBe(1);
		expect(result.files_skipped).toBe(0);
		expect(archive.search('uncommitted', options)).toHaveLength(1);
	},
);

test('unfinished tails remain partial when cached and are imported when completed', async () => {
	const line = jsonl([
		pi_entry('later', 'u2', 'assistant', 'completed-tail'),
	]);
	appendFileSync(path_for('pi'), line.slice(0, -1));
	await sync(archive, [sources[0]!], adapters);
	expect(await sync(archive, [sources[0]!], adapters)).toMatchObject({
		status: 'partial',
		partial_files: 1,
		files_skipped: 1,
	});
	appendFileSync(path_for('pi'), '\n');
	expect(await sync(archive, [sources[0]!], adapters)).toMatchObject({
		status: 'ok',
		sessions_updated: 1,
		files_skipped: 0,
	});
	expect(archive.search('completed', options)).toHaveLength(1);
});

test('incomplete development baselines are rejected without adding cache tables', async () => {
	await sync(archive, sources, adapters);
	archive.close();
	inspection.exec('DROP TABLE sync_cache');
	const original = readFileSync(join(root, 'omnirecall.db'));
	expect(() => new Archive(join(root, 'omnirecall.db'))).toThrow(
		'release baseline',
	);
	expect(readFileSync(join(root, 'omnirecall.db'))).toEqual(original);
	// Restore the fixture so afterEach can close an open Archive.
	inspection.exec(
		'CREATE TABLE sync_cache (source_id TEXT, unit_key TEXT, signature TEXT, data TEXT, PRIMARY KEY(source_id,unit_key))',
	);
	archive = new Archive(join(root, 'omnirecall.db'));
});

test('append stores only new raw records and leaves unchanged searchable rows untouched', async () => {
	await sync(archive, [sources[0]!], adapters);
	const before = inspection
		.prepare(
			'SELECT rowid,archive_id,record_key,raw_json FROM records ORDER BY source_order',
		)
		.all();
	const first = archive.search('migrations', {
		...options,
		agent: 'pi',
	})[0]!;
	inspection.exec(`
 CREATE TRIGGER no_raw_delete BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT,'existing record deleted'); END;
 CREATE TRIGGER no_raw_update BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT,'existing record updated'); END;
 CREATE TRIGGER no_unchanged_part_update BEFORE UPDATE ON parts WHEN old.native_id='a1' BEGIN SELECT RAISE(ABORT,'unchanged part updated'); END;
 `);
	appendFileSync(
		path_for('pi'),
		jsonl([
			pi_entry('new', 'u2', 'assistant', 'fresh incremental answer'),
		]),
	);
	expect(await sync(archive, [sources[0]!], adapters)).toMatchObject({
		failures: 0,
		sessions_updated: 1,
	});
	const after = inspection
		.prepare(
			'SELECT rowid,archive_id,record_key,raw_json FROM records ORDER BY source_order',
		)
		.all();
	expect(after.slice(0, before.length)).toEqual(before);
	expect(after).toHaveLength(before.length + 1);
	expect(
		archive.search('migrations', { ...options, agent: 'pi' })[0]
			?.rowid,
	).toBe(first.rowid);
	expect(archive.search('incremental', options)).toHaveLength(1);
	expect(
		inspection
			.prepare(
				"SELECT name FROM sqlite_schema WHERE name='revisions'",
			)
			.get(),
	).toBeUndefined();
	expect(await sync(archive, [sources[0]!], adapters)).toMatchObject({
		files_skipped: 1,
		sessions_updated: 0,
	});
});
