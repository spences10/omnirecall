import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import {
	codex_records,
	jsonl,
	pi_entry,
	pi_records,
} from '../../../packages/core/src/fixtures.ts';
import {
	archive_cli,
	run_cli,
	suite_dir,
	type Outcome,
} from './cli-fixture.ts';

// Each suite is one scenario: its tests run in order against a shared archive.

describe('cross-agent archive from explicit roots', () => {
	const root = suite_dir('omnirecall-cli-');
	const db = join(root, 'index.sqlite');
	const run = archive_cli(db);
	const pi_root = join(root, 'pi');
	const codex_root = join(root, 'codex');

	test('search before any sync reports unindexed and creates nothing', () => {
		const unindexed = run_cli([
			'search',
			'migrations',
			'--db',
			db,
			'--json',
		]);
		expect(unindexed.status).toBe(0);
		expect(JSON.parse(unindexed.stdout).status).toBe('unindexed');
		expect(existsSync(db)).toBe(false);
	});

	test('sync without roots creates an empty archive', () => {
		const no_roots = run(['sync']);
		expect(no_roots.status).toBe('empty');
		expect(existsSync(db)).toBe(true);
	});

	test('recall returns both agents with their surrounding messages', () => {
		mkdirSync(pi_root);
		mkdirSync(codex_root);
		writeFileSync(join(pi_root, 'test.jsonl'), jsonl(pi_records()));
		writeFileSync(
			join(codex_root, 'test.jsonl'),
			jsonl(codex_records()),
		);
		const imported = run([
			'sync',
			'--pi-root',
			pi_root,
			'--codex-root',
			codex_root,
		]);
		expect(imported.sessions_updated).toBe(2);
		const result = run(['recall', 'café migrations']);
		expect(
			result.results
				.map((row: { agent: string }) => row.agent)
				.sort(),
		).toEqual(['codex', 'pi']);
		expect(result.schema_version).toBe(3);
		const content = (ref: string) =>
			result.messages.find((m: { ref: string }) => m.ref === ref)
				.content;
		for (const row of result.results) {
			expect(content(row.before[0])).toBe('Prepare the database');
			expect(content(row.after[0])).toBe('Confirm the final checks');
		}
	});

	test('retrieval does not modify the archive', () => {
		const original_db = readFileSync(db);
		const filtered = run(['sessions', '--agent', 'pi']);
		expect(filtered.results).toHaveLength(1);
		expect(readFileSync(db)).toEqual(original_db);
	});

	test('search distinguishes unindexed sources, empty results and further pages', () => {
		const unknown = run_cli([
			'search',
			'migrations',
			'--source',
			'pi:unknown',
			'--db',
			db,
			'--json',
		]);
		expect(JSON.parse(unknown.stdout).status).toBe('unindexed');
		const empty = run_cli([
			'search',
			'absentword',
			'--db',
			db,
			'--json',
		]);
		expect(JSON.parse(empty.stdout).status).toBe('empty');
		const limited = run_cli([
			'search',
			'migrations',
			'--limit',
			'1',
			'--db',
			db,
			'--json',
		]);
		expect(JSON.parse(limited.stdout)).toMatchObject({
			returned_count: 1,
			has_more: true,
			next_offset: 1,
			truncated: true,
		});
	});

	test('oversized output stays within --max-bytes', () => {
		writeFileSync(
			join(pi_root, 'test.jsonl'),
			jsonl([
				...pi_records(),
				pi_entry(
					'huge',
					'u2',
					'assistant',
					'oversized ' + '☕'.repeat(20000),
				),
			]),
		);
		expect(
			run_cli(['sync', '--pi-root', pi_root, '--db', db, '--json'])
				.status,
		).toBe(0);
		const bounded = run_cli([
			'recall',
			'oversized',
			'--db',
			db,
			'--json',
			'--max-bytes',
			'1024',
		]);
		expect(Buffer.byteLength(bounded.stdout)).toBeLessThanOrEqual(
			1024,
		);
		expect(JSON.parse(bounded.stdout).truncated).toBe(true);
	});

	test('a missing root makes the sync partial', () => {
		const partial = run(
			[
				'sync',
				'--pi-root',
				join(root, 'missing'),
				'--codex-root',
				codex_root,
			],
			2,
		);
		expect(partial.issues[0].code).toBe('missing');
	});

	test.each([
		['--limit', '0'],
		['--agent', 'invalid'],
		['--after', 'invalid'],
		['--max-bytes', '1'],
	])('recall rejects %s %s', (...args) => {
		const invalid = run(['recall', 'migrations', ...args], 1);
		expect(invalid.status).toBe('error');
	});
});

describe('compact v3 output', () => {
	const root = suite_dir('omnirecall-lean-');
	const db = join(root, 'archive.db');
	const pi_root = join(root, 'pi');
	const run = (args: string[]) => {
		const response = run_cli([
			...args,
			'--db',
			db,
			'--json',
			'--max-bytes',
			'65536',
		]);
		expect(response.status, response.stdout).toBe(0);
		return {
			text: response.stdout,
			data: JSON.parse(response.stdout),
		};
	};
	const rows = (data: {
		results: Record<string, unknown>[];
		shared?: { results?: Record<string, unknown> };
	}) =>
		data.results.map((row) => ({ ...data.shared?.results, ...row }));

	beforeAll(() => {
		mkdirSync(pi_root);
		for (const id of ['one', 'two'])
			writeFileSync(
				join(pi_root, `${id}.jsonl`),
				jsonl(pi_records(id)),
			);
		run(['sync', '--pi-root', pi_root]);
	});

	test('search shares common provenance and keeps each source path', () => {
		const searched = run(['search', 'migrations']);
		expect(searched.data.schema_version).toBe(3);
		expect(searched.data.shared.results.agent).toBe('pi');
		expect(
			searched.data.results.every(
				(row: object) => !('source_status' in row),
			),
		).toBe(true);
		expect(
			rows(searched.data)
				.map((row) => String(row.source_path))
				.sort(),
		).toEqual([
			join(pi_root, 'one.jsonl'),
			join(pi_root, 'two.jsonl'),
		]);
	});

	test('recall shares message state and drops snippets its content covers', () => {
		const recalled = run([
			'recall',
			'migrations',
			'--compact',
			'--context',
			'0',
		]);
		expect(recalled.data.schema_version).toBe(3);
		expect(recalled.data.shared.messages).toMatchObject({
			state: 'active',
			active: true,
			representation: 'primary',
		});
		for (const row of recalled.data.results) {
			expect(row).not.toHaveProperty('snippet');
			expect(row).not.toHaveProperty('state');
			const message = recalled.data.messages.find(
				(m: { ref: string }) => m.ref === row.ref,
			);
			expect(message.content).toContain('migrations');
			expect(message.role).toBe('assistant');
		}
	});

	test.each(['search', 'recall'])(
		'%s --full returns detailed schema v1 rows',
		(command) => {
			const detailed = run([command, 'migrations', '--full']).data;
			expect(detailed.schema_version).toBe(1);
			expect(detailed).not.toHaveProperty('shared');
			expect(detailed.results[0]).toHaveProperty('source_status');
		},
	);

	test('session listings are concise and lead to scoped search and raw reads', () => {
		const sessions = run(['sessions']);
		const detailed_sessions = run(['sessions', '--full']);
		expect(sessions.data.schema_version).toBe(3);
		expect(detailed_sessions.data.schema_version).toBe(1);
		expect(Buffer.byteLength(sessions.text)).toBeLessThan(
			Buffer.byteLength(detailed_sessions.text) * 0.75,
		);
		for (const row of sessions.data.results) {
			expect(row).not.toHaveProperty('hash');
			expect(row).not.toHaveProperty('session_id');
			expect(
				run(['search', 'migrations', '--session', row.short_id]).data
					.results,
			).toHaveLength(1);
			const raw = run(['read', row.first_record_ref]).data;
			expect(raw.schema_version).toBe(3);
			expect(raw.results[0]).not.toHaveProperty('archive_id');
			expect(raw.results[0].content).toContain('"type":"session"');
		}
		const limited = run([
			'sessions',
			'--compact',
			'--limit',
			'1',
		]).data;
		expect(limited).toMatchObject({
			returned_count: 1,
			has_more: true,
			next_offset: 1,
		});
		expect(limited).not.toHaveProperty('shared');
	});

	test('a removed source file is marked missing and stays readable', () => {
		rmSync(join(pi_root, 'one.jsonl'));
		run(['sync', '--pi-root', pi_root]);
		const mixed = run(['search', 'migrations']).data;
		expect(mixed.shared.results).not.toHaveProperty('path_status');
		expect(
			rows(mixed)
				.map((row) => String(row.path_status))
				.sort(),
		).toEqual(['available', 'missing']);
		const missing = rows(mixed).find(
			(row) => row.path_status === 'missing',
		)!;
		const slim = run(['read', String(missing.ref)]).data;
		expect(slim.schema_version).toBe(3);
		expect(slim.messages).toHaveLength(1);
		expect(slim.messages[0].content).toContain('migrations');
		expect(Object.keys(slim.results[0]).sort()).toEqual([
			'after',
			'agent',
			'before',
			'branch_boundary',
			'next_ref',
			'previous_ref',
			'project',
			'record_ref',
			'ref',
			'short_id',
			'title',
		]);
		const read = run(['read', String(missing.ref), '--full']).data;
		expect(read.schema_version).toBe(2);
		expect(read).not.toHaveProperty('shared');
		expect(read.messages).toHaveLength(3);
		expect(read.results[0].source_path).toBe(
			join(pi_root, 'one.jsonl'),
		);
		expect(read.results[0].path_status).toBe('missing');
		expect(Buffer.byteLength(JSON.stringify(slim))).toBeLessThan(
			Buffer.byteLength(JSON.stringify(read)) / 2,
		);
	});
});

describe('compact retrieval workflow', () => {
	const root = suite_dir('omnirecall-compact-');
	const db = join(root, 'archive.db');
	const pi_root = join(root, 'pi');
	const run = archive_cli(db).outcome;
	let compact: Outcome;
	let full: Outcome;
	let hit: { ref: string; char_offset: number; snippet: string };

	beforeAll(() => {
		mkdirSync(pi_root);
		writeFileSync(
			join(pi_root, 'session.jsonl'),
			jsonl([
				...pi_records(),
				pi_entry(
					'long',
					'u2',
					'assistant',
					'🌱 padding '.repeat(1200) +
						'migrationneedle final decision',
				),
			]),
		);
		expect(run(['sync', '--pi-root', pi_root]).status).toBe(0);
		compact = run(['search', 'migrationneedle']);
		full = run(['search', 'migrationneedle', '--full']);
		expect(compact.status, compact.text).toBe(0);
		expect(full.status, full.text).toBe(0);
		hit = compact.data.results[0];
	});

	const read_hit = () =>
		run([
			'read',
			hit.ref,
			'--char-offset',
			String(hit.char_offset),
			'--context',
			'0',
		]);

	test('compact search returns a snippet in far less output than --full', () => {
		expect(compact.data).toMatchObject({
			schema_version: 3,
			format: 'compact',
		});
		expect(full.data).toMatchObject({
			schema_version: 1,
		});
		expect(hit).not.toHaveProperty('content');
		expect(hit.snippet).toContain('migrationneedle');
		expect(Buffer.byteLength(compact.text)).toBeLessThan(
			Buffer.byteLength(full.text) / 2,
		);
	});

	test('read at the hit offset returns the match without modifying the archive', () => {
		const original = readFileSync(db);
		const read = read_hit();
		expect(read.status, read.text).toBe(0);
		expect(read.data.messages[0].content).toContain(
			'migrationneedle',
		);
		expect(readFileSync(db)).toEqual(original);
	});

	test('compact output carries short refs; canonical refs keep working', () => {
		expect(hit.ref).toMatch(/^m2\.[a-f0-9]{12}\.[A-Za-z0-9_-]{11}$/);
		const detailed = full.data.results[0];
		const canonical = `m1.${detailed.archive_id}.${Buffer.from(detailed.native_id).toString('base64url')}`;
		const focused = read_hit().data.results[0];
		expect(
			run(['read', canonical, '--context', '0']).data.results[0].ref,
		).toBe(hit.ref);
		expect(focused.record_ref).toMatch(/^r2\.[a-f0-9]{12}\./);
		const raw = run(['read', focused.record_ref]);
		expect(raw.status, raw.text).toBe(0);
		expect(raw.data.results[0].content).toContain('"id":"long"');
		const listed = run(['sessions', '--compact']).data.results[0];
		expect(listed.first_record_ref).toMatch(/^r2\./);
		expect(run(['read', listed.first_record_ref]).status).toBe(0);
	});

	test('refs that match nothing are reported as not found', () => {
		for (const missing of [
			hit.ref.replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A')),
			`m2.${'0'.repeat(12)}.${hit.ref.split('.')[2]}`,
		]) {
			const absent = run(['read', missing]);
			expect(absent.status, absent.text).toBe(1);
			expect(absent.data.code).toBe('not_found');
		}
	});

	test('long content is read in pages by character offset', () => {
		const first = run([
			'read',
			hit.ref,
			'--context',
			'0',
			'--chars',
			'20',
		]).data;
		expect(first.messages[0].next_char_offset).toBe(20);
		const next = run([
			'read',
			hit.ref,
			'--context',
			'0',
			'--chars',
			'20',
			'--char-offset',
			'20',
		]).data;
		expect(next.messages[0].char_offset).toBe(20);
	});

	test('compact recall returns its messages once', () => {
		const recall = run(['recall', 'database', '--compact']);
		expect(recall.status, recall.text).toBe(0);
		expect(recall.data).toMatchObject({
			schema_version: 3,
			format: 'compact',
		});
		expect(recall.data.messages.length).toBeGreaterThan(0);
	});

	test('a read over the byte budget says so instead of truncating silently', () => {
		const bounded = run(['read', hit.ref, '--max-bytes', '1024']);
		expect(bounded.status).toBe(0);
		expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(1024);
		expect(bounded.data).toMatchObject({
			schema_version: 3,
			output_budget_exceeded: true,
			returned_count: 0,
			next_offset: 0,
		});
	});

	test('rejects flags that do not apply to the command', () => {
		for (const args of [
			['read', 'invalid'],
			['read', hit.ref, '--chars', '0'],
			['read', hit.ref, '--context', '11'],
			['read', hit.ref, '--char-offset', '-1'],
			['read', hit.ref, '--agent', 'pi'],
			['read', hit.ref, '--offset', '1'],
			['search', 'migration', '--full', '--compact'],
			['recall', 'migration', '--full', '--compact'],
			['sessions', '--full', '--compact'],
			['outline', 'anything', '--full'],
			['search', 'migration', '--chars', '10'],
		]) {
			const invalid = run(args);
			expect(invalid.status, invalid.text).toBe(1);
			expect(invalid.data.code).toBe('arguments');
		}
	});
});
