import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
	codex_records,
	codex_reviewer_records,
	jsonl,
	pi_entry,
	pi_records,
} from '../../../packages/core/src/fixtures.ts';
import { archive_cli, run_cli, temp_dir } from './cli-fixture.ts';

test('search and recall include whole UTC days but preserve exact timestamp bounds', () => {
	const root = temp_dir('omnirecall-dates-');
	const db = join(root, 'archive.db');
	const run = archive_cli(db);
	const pi_root = join(root, 'pi');
	mkdirSync(pi_root);
	const stamps = [
		'2026-09-24T23:59:59.999Z',
		'2026-09-25T00:00:00.000Z',
		'2026-09-25T12:00:00.000Z',
		'2026-09-25T23:59:59.999Z',
		'2026-09-26T00:00:00.000Z',
	];
	writeFileSync(
		join(pi_root, 'dates.jsonl'),
		jsonl([
			pi_records()[0],
			...stamps.map((timestamp, i) => ({
				...pi_entry(
					String(i),
					i ? String(i - 1) : null,
					'user',
					'dateprobe',
				),
				timestamp,
			})),
		]),
	);
	expect(
		run_cli(['sync', '--pi-root', pi_root, '--db', db, '--json'])
			.status,
	).toBe(0);
	for (const command of ['search', 'recall']) {
		for (const [bounds, expected] of [
			[
				['--after', '2026-09-25', '--before', '2026-09-25'],
				stamps.slice(1, 4),
			],
			[['--before', '2026-09-25'], stamps.slice(0, 4)],
			[['--after', '2026-09-25'], stamps.slice(1)],
			[
				['--after', '2026-09-25', '--before', '2026-09-25T00:00:00Z'],
				[stamps[1]],
			],
			[
				[
					'--after',
					'2026-09-25T12:00:00Z',
					'--before',
					'2026-09-25T12:00:00Z',
				],
				[stamps[2]],
			],
			[
				[
					'--after',
					'2026-09-25',
					'--before',
					'2026-09-25T14:00:00+02:00',
				],
				stamps.slice(1, 3),
			],
		] as const) {
			const response = run_cli(
				[
					command,
					'dateprobe',
					'--db',
					db,
					'--json',
					'--context',
					'0',
					'--max-bytes',
					'65536',
					...bounds,
				],
				{ TZ: 'Pacific/Honolulu' },
			);
			expect(response.status, response.stdout).toBe(0);
			const data = JSON.parse(response.stdout);
			expect(
				data.results
					.map(
						(row: { ref: string; timestamp?: string }) =>
							row.timestamp ??
							data.messages.find(
								(m: { ref: string }) => m.ref === row.ref,
							).timestamp ??
							data.shared.messages.timestamp,
					)
					.sort(),
			).toEqual(expected);
		}
		for (const bounds of [
			['--after', '2026-09-26', '--before', '2026-09-25'],
			['--after', 'invalid'],
			['--before', 'invalid'],
		]) {
			const response = run([command, 'dateprobe', ...bounds], 1);
			expect(response.status).toBe('error');
		}
	}
});

test('search --by-session lists each matching session once with hit counts and a readable best hit', () => {
	const root = temp_dir('omnirecall-grouped-');
	const db = join(root, 'archive.db');
	const pi_root = join(root, 'pi');
	const run = archive_cli(db).outcome;
	mkdirSync(pi_root);
	writeFileSync(
		join(pi_root, 'busy.jsonl'),
		jsonl([
			...pi_records('busy', '/synthetic/busy'),
			pi_entry('b1', 'u2', 'assistant', 'groupneedle first'),
			pi_entry('b2', 'b1', 'user', 'groupneedle second'),
			pi_entry('b3', 'b2', 'assistant', 'groupneedle third'),
		]),
	);
	writeFileSync(
		join(pi_root, 'quiet.jsonl'),
		jsonl([
			...pi_records('quiet', '/synthetic/quiet'),
			pi_entry('q1', 'u2', 'assistant', 'groupneedle only'),
		]),
	);
	expect(run(['sync', '--pi-root', pi_root]).status).toBe(0);
	expect(run(['search', 'groupneedle']).data.results).toHaveLength(4);
	const grouped = run(['search', 'groupneedle', '--by-session']);
	expect(grouped.status).toBe(0);
	expect(grouped.data).toMatchObject({
		schema_version: 3,
		format: 'compact',
		returned_count: 2,
		has_more: false,
	});
	const rows = grouped.data.results.map(
		(row: Record<string, unknown>) => ({
			...grouped.data.shared?.results,
			...row,
		}),
	);
	expect(
		rows
			.map((row: { project: string; hits: number }) => [
				row.project,
				row.hits,
			])
			.sort(),
	).toEqual([
		['/synthetic/busy', 3],
		['/synthetic/quiet', 1],
	]);
	for (const row of rows) {
		expect(row.title).toBe('Pi migration plan');
		expect(row.snippet).toContain('groupneedle');
		expect(row).not.toHaveProperty('source_path');
		expect(run(['read', row.ref]).data.messages).toContainEqual(
			expect.objectContaining({
				content: expect.stringContaining('groupneedle'),
			}),
		);
		expect(
			run(['search', 'groupneedle', '--session', row.short_id]).data
				.results,
		).toHaveLength(row.hits);
	}
	const page = run([
		'search',
		'groupneedle',
		'--by-session',
		'--limit',
		'1',
	]).data;
	expect(page).toMatchObject({
		returned_count: 1,
		has_more: true,
		next_offset: 1,
	});
	const next = run([
		'search',
		'groupneedle',
		'--by-session',
		'--limit',
		'1',
		'--offset',
		'1',
	]).data;
	expect(next.results[0].short_id).not.toBe(page.results[0].short_id);
	expect(
		run(['search', 'groupneedle', '--by-session', '--kind', 'all'])
			.data.results,
	).toHaveLength(2);
	expect(
		run(['search', 'absentneedle', '--by-session']).data.status,
	).toBe('empty');
	for (const args of [
		['search', 'groupneedle', '--by-session', '--full'],
		['recall', 'groupneedle', '--by-session'],
		['sessions', '--by-session'],
	]) {
		const invalid = run(args);
		expect(invalid.status).toBe(1);
		expect(invalid.data.code).toBe('arguments');
	}
});

test('default search and recall exclude Codex reviewer context while explicit reads retain it', () => {
	const root = temp_dir('omni-reviewer-');
	const db = join(root, 'archive.db');
	const run = archive_cli(db, { flags: ['--max-bytes', '65536'] });
	writeFileSync(
		join(root, 'main.jsonl'),
		jsonl(codex_records('main')),
	);
	for (const id of ['reviewer-one', 'reviewer-two'])
		writeFileSync(
			join(root, `${id}.jsonl`),
			jsonl(codex_reviewer_records(id)),
		);
	expect(run(['sync', '--codex-root', root]).sessions_updated).toBe(
		3,
	);
	for (const mode of [
		['search'],
		['search', '--full'],
		['recall'],
		['recall', '--full'],
	]) {
		const response = run([...mode, 'migrations']);
		expect(response.results).toHaveLength(1);
		const result = response.results[0];
		const message = response.messages?.find(
			(row: { ref: string }) => row.ref === result.ref,
		);
		expect(message?.role ?? result.role).toBe('assistant');
	}
	expect(run(['search', 'AGENTS']).results).toHaveLength(0);
	const copies = run([
		'search',
		'migrations',
		'--kind',
		'review_context',
	]).results;
	expect(copies).toHaveLength(2);
	expect(
		copies.every((row: { role: string }) => row.role === 'context'),
	).toBe(true);
	expect(
		run(['search', 'migrations', '--kind', 'all']).results,
	).toHaveLength(3);
	expect(
		run(['read', copies[0].ref]).messages.some(
			(m: { content: string }) =>
				m.content.includes('copied transcript'),
		),
	).toBe(true);
	expect(
		run(['read', copies[0].ref, '--raw']).results[0].content,
	).toContain('UserMessage');
});

test('FTS5 syntax works through search and recall with actionable malformed-query errors', () => {
	const root = temp_dir('omni-fts-');
	const db = join(root, 'archive.db');
	const run = archive_cli(db);
	writeFileSync(
		join(root, 'session.jsonl'),
		jsonl([
			...pi_records(),
			pi_entry(
				'packages',
				'u2',
				'user',
				'my-pi node.js @scope/pkg packages/core/index.ts deps',
			),
		]),
	);
	expect(
		run_cli(['sync', '--pi-root', root, '--db', db, '--json']).status,
	).toBe(0);
	for (const mode of [
		['search'],
		['search', '--full'],
		['recall'],
		['recall', '--full'],
	]) {
		const result = run([...mode, '"café migrations" OR nonexistent']);
		expect(result.results).toHaveLength(1);
		for (const term of [
			'my-pi',
			'node.js',
			'@scope/pkg',
			'packages/core/index.ts',
		]) {
			const punctuated = run([...mode, `${term} AND deps`]);
			expect(punctuated.results).toHaveLength(1);
		}
		const invalid = run([...mode, 'migration OR'], 1);
		expect(invalid).toMatchObject({
			status: 'error',
			code: 'arguments',
			message: expect.stringContaining('Invalid FTS5 query'),
		});
	}
});
