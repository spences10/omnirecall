import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { codex_adapter } from '../../adapter-codex/src/index.ts';
import { pi_adapter } from '../../adapter-pi/src/index.ts';
import { Archive, type QueryOptions } from './database.ts';
import { source_config } from './files.ts';
import {
	codex_entry,
	codex_item,
	codex_records,
	jsonl,
	pi_entry,
	pi_records,
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
	expect(result.revisions_added).toBe(2);
	const matches = archive.search('café migrations', options);
	expect(matches).toHaveLength(2);
	expect(new Set(matches.map((match) => match.session_id)).size).toBe(
		2,
	);
	for (const match of matches) {
		const context = archive.context(
			match.revision_id,
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
		(await sync(archive, sources, adapters)).revisions_added,
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
	expect(() => archive.search('" OR 1=1 --', options)).not.toThrow();
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
	expect(result.revisions_added).toBe(1);
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
	expect(result.revisions_added).toBe(0);
	expect(archive.search('Résumé', options)).toEqual([]);
	appendFileSync(path_for('pi'), record.subarray(split));
	expect(
		(await sync(archive, sources, adapters)).revisions_added,
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
	'%s unknown content rejects the update and preserves archived dialogue and checkpoint',
	async (agent) => {
		await sync(archive, sources, adapters);
		const checkpoint = inspection
			.prepare(
				'SELECT revision_id, byte_offset FROM resources WHERE path=?',
			)
			.get(path_for(agent));
		const content = [
			{ type: 'text', text: 'uncommitted keyword' },
			{
				type: 'future_dialogue',
				text: 'evidence must not disappear',
			},
		];
		const entry =
			agent === 'pi'
				? pi_entry('future', 'u2', 'assistant', content)
				: codex_entry('event_msg', {
						type: 'item_completed',
						turn_id: 'turn-1',
						item: { id: 'future', type: 'AgentMessage', content },
					});
		appendFileSync(path_for(agent), jsonl([entry]));
		const result = await sync(archive, sources, adapters);
		expect(result).toMatchObject({
			status: 'partial',
			failures: 1,
			files_indexed: 1,
			revisions_added: 0,
		});
		expect(result.issues[0]).toMatchObject({
			path: path_for(agent),
			code: 'unsupported',
		});
		expect(archive.search('uncommitted', options)).toEqual([]);
		expect(archive.search('migrations', options)).toHaveLength(2);
		expect(
			inspection
				.prepare(
					'SELECT revision_id, byte_offset FROM resources WHERE path=?',
				)
				.get(path_for(agent)),
		).toEqual(checkpoint);
	},
);

test('file transaction rolls back FTS, revision selection and checkpoint', async () => {
	await sync(archive, sources, adapters);
	const before = inspection.prepare('SELECT * FROM revisions').all();
	const checkpoint = inspection
		.prepare(
			'SELECT revision_id,byte_offset FROM resources WHERE path=?',
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
	expect(inspection.prepare('SELECT * FROM revisions').all()).toEqual(
		before,
	);
	expect(
		inspection
			.prepare(
				'SELECT revision_id,byte_offset FROM resources WHERE path=?',
			)
			.get(path_for('pi')),
	).toEqual(checkpoint);
	expect(archive.search('transaction', options)).toEqual([]);
	inspection.exec('DROP TRIGGER fail_message');
	expect(
		(await sync(archive, sources, adapters)).revisions_added,
	).toBe(1);
});

test('movement, replacement, deletion and unavailable roots never delete archived history', async () => {
	await sync(archive, sources, adapters);
	const moved = join(root, 'pi', 'archived.jsonl');
	renameSync(path_for('pi'), moved);
	expect(
		(await sync(archive, sources, adapters)).revisions_added,
	).toBe(0);
	expect(
		archive.search('migrations', { ...options, agent: 'pi' })[0]
			?.source_path,
	).toBe(moved);
	writeFileSync(moved, jsonl(pi_records('replacement')));
	await sync(archive, sources, adapters);
	expect(
		archive.search('migrations', { ...options, agent: 'pi' }),
	).toHaveLength(2);
	rmSync(moved);
	await sync(archive, sources, adapters);
	expect(
		archive.search('migrations', { ...options, agent: 'pi' }),
	).toHaveLength(2);
	renameSync(join(root, 'codex'), join(root, 'offline'));
	const result = await sync(archive, sources, adapters);
	expect(result.issues[0]?.code).toBe('missing');
	expect(
		archive.search('migrations', { ...options, agent: 'codex' })[0]
			?.source_status,
	).toBe('missing');
	expect(
		inspection
			.prepare('SELECT status FROM resources WHERE path=?')
			.get(path_for('codex'))?.status,
	).toBe('available');
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
			.context(match.revision_id, 'branch', 10)
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
				.context(row.revision_id, 'a1', 10)
				.after.map((entry) => entry.native_id),
		).not.toContain('branch');
});

test('Codex rollback and item correction preserve old revisions without linearizing abandoned turns', async () => {
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
			.context(match.revision_id, 'new-answer', 10)
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
	).toHaveLength(2);
	expect(archive.search('revised', options)).toHaveLength(1);
});

test('same-size rewrites and truncation create revisions; divergent duplicate files are rejected', async () => {
	await sync(archive, sources, adapters);
	writeFileSync(
		path_for('pi'),
		jsonl(pi_records()).replace('safely', 'surely'),
	);
	expect(
		(await sync(archive, sources, adapters)).revisions_added,
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
	).toHaveLength(1);
	writeFileSync(
		join(root, 'pi', 'duplicate.jsonl'),
		jsonl(pi_records()),
	);
	const result = await sync(archive, sources, adapters);
	expect(
		result.issues.filter((issue) => issue.code === 'conflict'),
	).toHaveLength(2);
	expect(archive.search('surely', options)).toHaveLength(1);
	rmSync(join(root, 'pi', 'duplicate.jsonl'));
	writeFileSync(path_for('pi'), jsonl(pi_records().slice(0, 1)));
	await sync(archive, sources, adapters);
	expect(archive.search('surely', options)).toHaveLength(0);
	expect(
		archive.search('surely', { ...options, include_history: true }),
	).toHaveLength(1);
});
