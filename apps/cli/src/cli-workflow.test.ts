import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
	codex_records,
	jsonl,
	pi_entry,
	pi_records,
} from '../../../packages/core/src/fixtures.ts';
import { run_cli, temp_dir } from './cli-fixture.ts';

test('end-to-end cross-agent recall, bounded JSON, explicit roots and unindexed status', () => {
	const root = temp_dir('omnirecall-cli-');
	const db = join(root, 'index.sqlite');
	const pi_root = join(root, 'pi');
	const codex_root = join(root, 'codex');
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
	const no_roots = run_cli(['sync', '--db', db, '--json']);
	expect(no_roots.status).toBe(0);
	expect(JSON.parse(no_roots.stdout).status).toBe('empty');
	expect(existsSync(db)).toBe(true);
	mkdirSync(pi_root);
	mkdirSync(codex_root);
	writeFileSync(join(pi_root, 'test.jsonl'), jsonl(pi_records()));
	writeFileSync(
		join(codex_root, 'test.jsonl'),
		jsonl(codex_records()),
	);
	const imported = run_cli([
		'sync',
		'--pi-root',
		pi_root,
		'--codex-root',
		codex_root,
		'--db',
		db,
		'--json',
	]);
	expect(imported.status, imported.stdout).toBe(0);
	expect(JSON.parse(imported.stdout).sessions_updated).toBe(2);
	const recalled = run_cli([
		'recall',
		'café migrations',
		'--db',
		db,
		'--json',
	]);
	expect(recalled.status, recalled.stdout).toBe(0);
	const result = JSON.parse(recalled.stdout);
	expect(
		result.results.map((row: { agent: string }) => row.agent).sort(),
	).toEqual(['codex', 'pi']);
	expect(result.schema_version).toBe(3);
	const content = (ref: string) =>
		result.messages.find((m: { ref: string }) => m.ref === ref)
			.content;
	for (const row of result.results) {
		expect(content(row.before[0])).toBe('Prepare the database');
		expect(content(row.after[0])).toBe('Confirm the final checks');
	}
	const original_db = readFileSync(db);
	const filtered = run_cli([
		'sessions',
		'--agent',
		'pi',
		'--db',
		db,
		'--json',
	]);
	expect(filtered.status, filtered.stdout).toBe(0);
	expect(JSON.parse(filtered.stdout).results).toHaveLength(1);
	expect(readFileSync(db)).toEqual(original_db);
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
	expect(Buffer.byteLength(bounded.stdout)).toBeLessThanOrEqual(1024);
	expect(JSON.parse(bounded.stdout).truncated).toBe(true);
	const partial = run_cli([
		'sync',
		'--pi-root',
		join(root, 'missing'),
		'--codex-root',
		codex_root,
		'--db',
		db,
		'--json',
	]);
	expect(partial.status).toBe(2);
	expect(JSON.parse(partial.stdout).issues[0].code).toBe('missing');
	for (const args of [
		['--limit', '0'],
		['--agent', 'invalid'],
		['--after', 'invalid'],
		['--max-bytes', '1'],
	]) {
		const invalid = run_cli([
			'recall',
			'migrations',
			'--db',
			db,
			'--json',
			...args,
		]);
		expect(invalid.status).toBe(1);
		expect(JSON.parse(invalid.stdout).status).toBe('error');
	}
});

test('compact v3 shares provenance, keeps source paths and offers concise session listings', () => {
	const root = temp_dir('omnirecall-lean-');
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
	mkdirSync(pi_root);
	for (const id of ['one', 'two'])
		writeFileSync(
			join(pi_root, `${id}.jsonl`),
			jsonl(pi_records(id)),
		);
	run(['sync', '--pi-root', pi_root]);
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
	).toEqual([join(pi_root, 'one.jsonl'), join(pi_root, 'two.jsonl')]);
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
	for (const args of [
		['search', 'migrations', '--full'],
		['recall', 'migrations', '--full'],
	]) {
		const detailed = run(args).data;
		expect(detailed.schema_version).toBe(1);
		expect(detailed).not.toHaveProperty('shared');
		expect(detailed.results[0]).toHaveProperty('source_status');
	}
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
	const limited = run(['sessions', '--compact', '--limit', '1']).data;
	expect(limited).toMatchObject({
		returned_count: 1,
		has_more: true,
		next_offset: 1,
	});
	expect(limited).not.toHaveProperty('shared');
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

test('compact search, focused reading, and compact recall form a bounded retrieval workflow', () => {
	const root = temp_dir('omnirecall-compact-');
	const db = join(root, 'archive.db');
	const pi_root = join(root, 'pi');
	function run(args: string[]) {
		return run_cli([...args, '--db', db, '--json']);
	}
	mkdirSync(pi_root);
	writeFileSync(
		join(pi_root, 'session.jsonl'),
		jsonl([
			...pi_records(),
			pi_entry(
				'long',
				'u2',
				'assistant',
				'🌱 padding '.repeat(1200) + 'migrationneedle final decision',
			),
		]),
	);
	expect(run(['sync', '--pi-root', pi_root]).status).toBe(0);
	const compact = run(['search', 'migrationneedle']);
	const full = run(['search', 'migrationneedle', '--full']);
	expect(compact.status, compact.stdout).toBe(0);
	expect(full.status, full.stdout).toBe(0);
	const hit = JSON.parse(compact.stdout).results[0];
	expect(JSON.parse(compact.stdout)).toMatchObject({
		schema_version: 3,
		format: 'compact',
	});
	expect(JSON.parse(full.stdout)).toMatchObject({
		schema_version: 1,
	});
	expect(hit).not.toHaveProperty('content');
	expect(hit.snippet).toContain('migrationneedle');
	expect(Buffer.byteLength(compact.stdout)).toBeLessThan(
		Buffer.byteLength(full.stdout) / 2,
	);
	const original = readFileSync(db);
	const read = run([
		'read',
		hit.ref,
		'--char-offset',
		String(hit.char_offset),
		'--context',
		'0',
	]);
	expect(read.status, read.stdout).toBe(0);
	expect(JSON.parse(read.stdout).messages[0].content).toContain(
		'migrationneedle',
	);
	expect(readFileSync(db)).toEqual(original);
	// Compact output carries short refs; canonical refs keep working.
	expect(hit.ref).toMatch(/^m2\.[a-f0-9]{12}\.[A-Za-z0-9_-]{11}$/);
	const detailed = JSON.parse(full.stdout).results[0];
	const canonical = `m1.${detailed.archive_id}.${Buffer.from(detailed.native_id).toString('base64url')}`;
	const focused = JSON.parse(read.stdout).results[0];
	expect(
		JSON.parse(run(['read', canonical, '--context', '0']).stdout)
			.results[0].ref,
	).toBe(hit.ref);
	expect(focused.record_ref).toMatch(/^r2\.[a-f0-9]{12}\./);
	const raw = run(['read', focused.record_ref]);
	expect(raw.status, raw.stdout).toBe(0);
	expect(JSON.parse(raw.stdout).results[0].content).toContain(
		'"id":"long"',
	);
	const listed = JSON.parse(run(['sessions', '--compact']).stdout)
		.results[0];
	expect(listed.first_record_ref).toMatch(/^r2\./);
	expect(run(['read', listed.first_record_ref]).status).toBe(0);
	for (const missing of [
		hit.ref.replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A')),
		`m2.${'0'.repeat(12)}.${hit.ref.split('.')[2]}`,
	]) {
		const absent = run(['read', missing]);
		expect(absent.status, absent.stdout).toBe(1);
		expect(JSON.parse(absent.stdout).code).toBe('not_found');
	}
	const first = JSON.parse(
		run(['read', hit.ref, '--context', '0', '--chars', '20']).stdout,
	);
	expect(first.messages[0].next_char_offset).toBe(20);
	const next = JSON.parse(
		run([
			'read',
			hit.ref,
			'--context',
			'0',
			'--chars',
			'20',
			'--char-offset',
			'20',
		]).stdout,
	);
	expect(next.messages[0].char_offset).toBe(20);
	const recall = run(['recall', 'database', '--compact']);
	expect(recall.status, recall.stdout).toBe(0);
	expect(JSON.parse(recall.stdout)).toMatchObject({
		schema_version: 3,
		format: 'compact',
	});
	expect(JSON.parse(recall.stdout).messages.length).toBeGreaterThan(
		0,
	);
	const bounded = run(['read', hit.ref, '--max-bytes', '1024']);
	expect(bounded.status).toBe(0);
	expect(Buffer.byteLength(bounded.stdout)).toBeLessThanOrEqual(1024);
	expect(JSON.parse(bounded.stdout)).toMatchObject({
		schema_version: 3,
		output_budget_exceeded: true,
		returned_count: 0,
		next_offset: 0,
	});
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
		expect(invalid.status, invalid.stdout).toBe(1);
		expect(JSON.parse(invalid.stdout).code).toBe('arguments');
	}
});
