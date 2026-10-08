import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import {
	codex_records,
	jsonl,
	pi_entry,
	pi_records,
} from '../../../packages/core/src/fixtures.ts';
import { archive_cli, run_cli, suite_dir } from './cli-fixture.ts';

// Each suite is one scenario: its tests run in order against a shared archive.

type Row = { kind: string; text: string; text_truncated: boolean };
const summary = (row: Row) => [
	row.kind,
	row.text,
	row.text_truncated,
];

describe('session discovery', () => {
	const root = suite_dir('omnirecall-discovery-');
	const db = join(root, 'archive.db');
	const pi_root = join(root, 'pi');
	const codex_root = join(root, 'codex');
	const first_id = '12345678-aaaa-4000-8000-000000000001';
	const run = archive_cli(db, { flags: ['--max-bytes', '65536'] });
	const filters = [
		'--title',
		'%_target',
		'--after',
		'2026-09-25',
		'--before',
		'2026-09-25',
	];
	// The session whose native ID is `first_id`, as `sessions --full` lists it.
	let first: Record<string, string>;

	beforeAll(() => {
		mkdirSync(pi_root);
		mkdirSync(codex_root);
		for (const [id, title, timestamp] of [
			[first_id, 'Plan %_Target alpha', '2026-09-25T00:00:00.000Z'],
			[
				'12345678-bbbb-4000-8000-000000000002',
				'Plan %_Target beta',
				'2026-09-25T23:59:59.999Z',
			],
			[
				'different',
				'Plan XXTarget decoy',
				'2026-09-26T00:00:00.000Z',
			],
		]) {
			const records = pi_records(id).map((record, index) => ({
				...record,
				timestamp:
					index === 0 ? timestamp : '2026-09-26T12:00:00.000Z',
				...(index === 1 ? { name: title } : {}),
			}));
			writeFileSync(join(pi_root, `${id}.jsonl`), jsonl(records));
		}
		writeFileSync(
			join(codex_root, 'copy.jsonl'),
			jsonl(codex_records(first_id)),
		);
		expect(
			run(['sync', '--pi-root', pi_root, '--codex-root', codex_root])
				.sessions_updated,
		).toBe(4);
	});

	test('literal title and whole-day date filters page through sessions', () => {
		const page = run([
			'sessions',
			'--full',
			...filters,
			'--limit',
			'1',
		]);
		expect(page).toMatchObject({
			returned_count: 1,
			has_more: true,
			next_offset: 1,
		});
		const next = run([
			'sessions',
			'--full',
			...filters,
			'--limit',
			'1',
			'--offset',
			'1',
		]);
		expect(next).toMatchObject({
			returned_count: 1,
			has_more: false,
			next_offset: null,
		});
		expect(next.results[0].archive_id).not.toBe(
			page.results[0].archive_id,
		);
		first = next.results[0];
		expect(first.native_id).toBe(first_id);
		expect(first.short_id).toHaveLength(12);
	});

	test.each([
		[['search']],
		[['search', '--full']],
		[['recall']],
		[['recall', '--full']],
	])(
		'%j applies title filters to sessions and date filters to messages',
		(mode) => {
			expect(
				run([...mode, 'migrations', '--title', '%_TARGET']).results,
			).toHaveLength(2);
			expect(
				run([...mode, 'migrations', ...filters]).results,
			).toHaveLength(0);
			expect(
				run([
					...mode,
					'migrations',
					'--title',
					'%_target',
					'--after',
					'2026-09-26',
					'--before',
					'2026-09-26',
				]).results,
			).toHaveLength(2);
		},
	);

	test('--session accepts session, archive, short and native identifiers', () => {
		for (const session of [
			first.session_id,
			first.archive_id,
			first.short_id,
			first.native_id,
			first.native_id.slice(0, 12),
		]) {
			for (const args of [
				['sessions'],
				['search', 'migrations'],
				['recall', 'migrations'],
			]) {
				const scoped = run([
					...args,
					'--agent',
					'pi',
					'--session',
					session,
				]);
				expect(scoped.results).toHaveLength(1);
			}
		}
		expect(
			run([
				'sessions',
				'--source',
				first.source_id,
				'--session',
				first.native_id,
			]).results,
		).toHaveLength(1);
		expect(
			run(['sessions', '--session', 'missing-session']).results,
		).toHaveLength(0);
	});

	test('an identifier shared by two sessions is rejected as ambiguous', () => {
		for (const args of [
			['sessions', '--session', first.native_id],
			[
				'sessions',
				'--session',
				'12345678',
				'--agent',
				'pi',
				'--title',
				'alpha',
			],
			[
				'search',
				'migrations',
				'--session',
				first.native_id,
				'--title',
				'alpha',
			],
			[
				'recall',
				'migrations',
				'--session',
				first.native_id,
				'--before',
				'2000-01-01',
			],
		]) {
			const response = run_cli([...args, '--db', db, '--json']);
			expect(response.status).toBe(1);
			expect(JSON.parse(response.stdout)).toMatchObject({
				code: 'arguments',
				message: expect.stringContaining('Ambiguous session'),
			});
		}
	});

	test('rejects invalid or inapplicable filters', () => {
		for (const args of [
			['sessions', '--after', 'invalid'],
			['sessions', '--after', '2026-09-26', '--before', '2026-09-25'],
			['sessions', '--title', ''],
			['sessions', '--session', ''],
			['sources', '--title', 'alpha'],
			['sync', '--title', 'alpha'],
			['read', first.first_record_ref, '--title', 'alpha'],
		]) {
			const response = run_cli([...args, '--db', db, '--json']);
			expect(response.status, response.stdout).toBe(1);
			expect(JSON.parse(response.stdout).code).toBe('arguments');
		}
	});

	test('a session whose source file was removed keeps its short_id and stays searchable', () => {
		rmSync(join(pi_root, `${first_id}.jsonl`));
		run(['sync', '--pi-root', pi_root]);
		expect(
			run(['sessions', '--session', first.short_id]).results[0],
		).toMatchObject({
			short_id: first.short_id,
			path_status: 'missing',
		});
		expect(
			run(['search', 'migrations', '--session', first.short_id])
				.results,
		).toHaveLength(1);
	});
});

describe('outline', () => {
	const root = suite_dir('omnirecall-outline-');
	const db = join(root, 'archive.db');
	const pi_root = join(root, 'pi');
	const run = archive_cli(db).outcome;

	test('reports unindexed before any sync', () => {
		expect(run(['outline', 'anything']).data.code).toBe('unindexed');
	});

	describe('of a synced session', () => {
		let short_id: string;

		beforeAll(() => {
			mkdirSync(pi_root);
			writeFileSync(
				join(pi_root, 'session.jsonl'),
				jsonl([
					...pi_records('outlined', '/synthetic/outline'),
					pi_entry('a2', 'u2', 'assistant', 'All checks passed'),
					pi_entry(
						'u3',
						'a2',
						'user',
						'\n  Ship it now  \nwith the changelog\n' +
							'x'.repeat(500),
					),
					{
						type: 'compaction',
						id: 'c1',
						parentId: 'u3',
						timestamp: '2026-09-01T10:00:00.000Z',
						summary: 'Database prepared and shipped',
						firstKeptEntryId: 'u3',
					},
					pi_entry('u4', 'c1', 'user', 'y'.repeat(300)),
				]),
			);
			writeFileSync(
				join(pi_root, 'other.jsonl'),
				jsonl(pi_records('elsewhere', '/synthetic/other')),
			);
			expect(run(['sync', '--pi-root', pi_root]).status).toBe(0);
			short_id = run([
				'sessions',
				'--project',
				'/synthetic/outline',
				'--compact',
			]).data.results[0].short_id;
		});

		test('lists user prompts and summaries as one line each', () => {
			const outline = run(['outline', short_id]);
			expect(outline.status).toBe(0);
			expect(outline.data).toMatchObject({
				schema_version: 3,
				format: 'compact',
				status: 'ok',
				returned_count: 5,
				has_more: false,
				session: {
					short_id,
					title: 'Pi migration plan',
					project: '/synthetic/outline',
					parts: { message: 6, summary: 1 },
				},
			});
			expect(outline.data.results.map(summary)).toEqual([
				['message', 'Prepare the database', false],
				['message', 'Confirm the final checks', false],
				['message', 'Ship it now', true],
				['summary', 'Database prepared and shipped', false],
				['message', 'y'.repeat(160), true],
			]);
		});

		test('a truncated row has a ref that reads the full message', () => {
			const shipped = run(['outline', short_id]).data.results[2];
			expect(shipped.ref).toMatch(/^m2\./);
			expect(
				run(['read', shipped.ref, '--context', '0']).data.messages[0]
					.content,
			).toContain('with the changelog');
		});

		test('pages with --limit and --offset', () => {
			const page = run(['outline', short_id, '--limit', '2']).data;
			expect(page).toMatchObject({
				returned_count: 2,
				has_more: true,
				next_offset: 2,
			});
			expect(
				run(['outline', short_id, '--limit', '2', '--offset', '2'])
					.data.results[0].text,
			).toBe('Ship it now');
		});

		test('an unknown session is not found', () => {
			expect(run(['outline', 'missing-session']).data.code).toBe(
				'not_found',
			);
		});

		test('rejects a missing identifier and inapplicable flags', () => {
			for (const args of [
				['outline'],
				['outline', short_id, '--kind', 'all'],
				['outline', short_id, '--after', '2026-01-01'],
				['outline', short_id, '--full'],
			]) {
				const invalid = run(args);
				expect(invalid.status).toBe(1);
				expect(invalid.data.code).toBe('arguments');
			}
		});
	});
});

describe('evidence', () => {
	const root = suite_dir('omnirecall-evidence-');
	const db = join(root, 'archive.db');
	const pi_root = join(root, 'pi');
	const run = archive_cli(db).outcome;
	let prompts: { ref: string; text: string }[];
	let hit: { ref: string };

	beforeAll(() => {
		mkdirSync(pi_root);
		writeFileSync(
			join(pi_root, 'session.jsonl'),
			jsonl([
				...pi_records('turns', '/synthetic/turns'),
				pi_entry('a2', 'u2', 'assistant', [
					{ type: 'text', text: 'Running turnneedle checks' },
					{
						type: 'toolCall',
						id: 'call-1',
						name: 'bash',
						arguments: { command: 'pnpm   test\n--run' },
					},
				]),
				pi_entry('r2', 'a2', 'toolResult', [
					{
						type: 'text',
						text: 'second-turn-output ' + 'z'.repeat(300),
					},
				]),
				pi_entry('u3', 'r2', 'user', 'Thanks, anything else?'),
				pi_entry('a3', 'u3', 'assistant', 'Nothing further'),
			]),
		);
		expect(run(['sync', '--pi-root', pi_root]).status).toBe(0);
		const short_id = run(['sessions', '--compact']).data.results[0]
			.short_id;
		prompts = run(['outline', short_id]).data.results;
		hit = run(['search', 'turnneedle']).data.results[0];
	});

	test('the session has three turns', () => {
		expect(prompts.map((row) => row.text)).toEqual([
			'Prepare the database',
			'Confirm the final checks',
			'Thanks, anything else?',
		]);
	});

	test('a prompt and a reply in the same turn share its evidence', () => {
		for (const ref of [prompts[1]!.ref, hit.ref]) {
			const evidence = run(['evidence', ref]);
			expect(evidence.status).toBe(0);
			expect(evidence.data).toMatchObject({
				schema_version: 3,
				format: 'compact',
				status: 'ok',
				turn: {
					prompt_ref: prompts[1]!.ref,
					next_prompt_ref: prompts[2]!.ref,
				},
				returned_count: 2,
				has_more: false,
			});
			expect(evidence.data.results.map(summary)).toEqual([
				['tool_call', 'bash {"command":"pnpm test\\n--run"}', false],
				[
					'tool_result',
					('second-turn-output ' + 'z'.repeat(300)).slice(0, 160),
					true,
				],
			]);
		}
	});

	test("an earlier turn lists only that turn's tool activity", () => {
		const first = run(['evidence', prompts[0]!.ref]).data;
		expect(first.turn).toEqual({
			prompt_ref: prompts[0]!.ref,
			next_prompt_ref: prompts[1]!.ref,
		});
		expect(
			first.results.map((row: { text: string }) => row.text),
		).toEqual(['private-tool-output']);
	});

	test('a truncated row has a ref that reads the full output', () => {
		const output = run(['evidence', hit.ref]).data.results[1];
		expect(
			run(['read', output.ref, '--context', '0']).data.messages[0]
				.content,
		).toContain('second-turn-output');
	});

	test('a turn without tool activity is empty, and the last turn has no next prompt', () => {
		expect(run(['evidence', prompts[2]!.ref]).data).toMatchObject({
			status: 'empty',
			turn: { prompt_ref: prompts[2]!.ref, next_prompt_ref: null },
			results: [],
		});
	});

	test('pages with --limit', () => {
		expect(
			run(['evidence', hit.ref, '--limit', '1']).data,
		).toMatchObject({
			returned_count: 1,
			has_more: true,
			next_offset: 1,
		});
	});

	test('an unknown ref is not found', () => {
		expect(
			run(['evidence', `m2.${'0'.repeat(12)}.AAAAAAAAAAA`]).data.code,
		).toBe('not_found');
	});

	test('rejects a missing or malformed ref and inapplicable flags', () => {
		for (const args of [
			['evidence'],
			['evidence', 'not-a-ref'],
			['evidence', hit.ref, '--kind', 'all'],
			['evidence', hit.ref, '--context', '1'],
		]) {
			const invalid = run(args);
			expect(invalid.status).toBe(1);
			expect(invalid.data.code).toBe('arguments');
		}
	});
});
