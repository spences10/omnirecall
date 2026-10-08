import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
	create_fixture as create_opencode,
	message as opencode_message,
	put_message as put_opencode_message,
} from '../../../packages/adapter-opencode/src/fixtures.ts';
import { jsonl } from '../../../packages/core/src/fixtures.ts';
import { archive_cli, run_cli, suite_dir } from './cli-fixture.ts';

// Each suite is one scenario: its tests run in order against a shared archive.

describe('Claude transcripts', () => {
	const root = suite_dir('omni-claude-cli-');
	const db = join(root, 'archive.db');
	const run = archive_cli(db);
	const find_result = () =>
		run(['search', 'tool_unique_failure', '--kind', 'tool_result'])
			.results[0];

	beforeAll(() => {
		writeFileSync(
			join(root, 'session.jsonl'),
			jsonl([
				{
					type: 'assistant',
					uuid: 'a',
					sessionId: 's',
					timestamp: '2026-09-01T00:00:00Z',
					message: {
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								id: 'c',
								name: 'Bash',
								input: { command: 'check' },
							},
						],
					},
				},
				{
					type: 'user',
					uuid: 'u',
					sessionId: 's',
					timestamp: '2026-09-01T00:00:01Z',
					message: {
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'c',
								content: 'tool_unique_failure',
								is_error: true,
							},
						],
					},
				},
			]),
		);
		const imported = run_cli([
			'sync',
			'--claude-root',
			root,
			'--db',
			db,
			'--json',
		]);
		expect(imported.status, imported.stdout + imported.stderr).toBe(
			0,
		);
	});

	test('tool output is searchable only when --kind includes it', () => {
		expect(
			run(['search', 'tool_unique_failure']).results,
		).toHaveLength(0);
		expect(
			run(['search', 'tool_unique_failure', '--kind', 'all']).results,
		).toHaveLength(1);
		expect(find_result().kind).toBe('tool_result');
	});

	test('a raw record is read in pages through its record ref', () => {
		const first = run([
			'read',
			find_result().ref,
			'--raw',
			'--chars',
			'25',
		]).results[0];
		expect(first.next_char_offset).toBe(25);
		const next = run([
			'read',
			first.record_ref,
			'--char-offset',
			'25',
			'--chars',
			'25',
		]);
		expect(next.results[0].char_offset).toBe(25);
	});
});

describe('OpenCode v2 storage found through XDG_DATA_HOME', () => {
	const root = suite_dir('omni-opencode-cli-');
	const data = join(root, 'xdg');
	const opencode_root = join(data, 'opencode');
	const db = join(root, 'archive.db');
	const run = archive_cli(db, { env: { XDG_DATA_HOME: data } });
	let writer: ReturnType<typeof create_opencode>;
	let listed: Record<string, string>;
	let hit: Record<string, string>;

	beforeAll(() => {
		mkdirSync(opencode_root, { recursive: true });
		writer = create_opencode(join(opencode_root, 'opencode.db'));
	});
	afterAll(() => writer.close());

	test('sync discovers the live database and skips it when unchanged', () => {
		expect(run(['sync', '--agent', 'opencode'])).toMatchObject({
			sources_selected: 1,
			sessions_updated: 1,
		});
		expect(run(['sync', '--agent', 'opencode'])).toMatchObject({
			files_skipped: 1,
			sessions_updated: 0,
		});
	});

	test('sessions and search locate the session by title and short_id', () => {
		listed = run([
			'sessions',
			'--agent',
			'opencode',
			'--title',
			'migration',
		]).results[0];
		expect(listed.source_path).toBe(
			join(opencode_root, 'opencode.db'),
		);
		hit = run([
			'search',
			'opencodeneedle',
			'--session',
			listed.short_id,
		]).results[0];
		expect(hit.agent).toBe('opencode');
	});

	test('recall returns the surrounding dialogue', () => {
		const recalled = run([
			'recall',
			'opencodeneedle',
			'--agent',
			'opencode',
			'--full',
		]).results[0];
		expect(recalled.before[0].content).toBe('Prepare the database');
		expect(recalled.after[0].content).toBe(
			'Confirm the final checks',
		);
	});

	test('read returns the message, its original row and the session row', () => {
		expect(
			run(['read', hit.ref]).messages.some((m: { content: string }) =>
				m.content.includes('opencodeneedle'),
			),
		).toBe(true);
		expect(
			JSON.parse(run(['read', hit.ref, '--raw']).results[0].content)
				.data.content[0].text,
		).toContain('opencodeneedle');
		expect(
			run(['read', listed.first_record_ref]).results[0].native_type,
		).toBe('session_v2');
	});

	test('tool output is searchable only when --kind includes it', () => {
		expect(run(['search', 'tooloutputneedle']).results).toHaveLength(
			0,
		);
		expect(
			run(['search', 'tooloutputneedle', '--kind', 'tool_result'])
				.results,
		).toHaveLength(1);
	});

	test('a message rewritten in place replaces its archived text', () => {
		put_opencode_message(
			writer,
			opencode_message(2, 'assistant', {
				content: [
					{ type: 'text', text: 'updatedcodexfree OpenCode answer' },
				],
			}),
		);
		expect(
			run(['sync', '--opencode-root', opencode_root])
				.sessions_updated,
		).toBe(1);
		expect(run(['search', 'opencodeneedle']).results).toHaveLength(0);
		expect(
			run(['read', hit.ref, '--context', '0']).messages[0].content,
		).toContain('updatedcodexfree');
	});

	test('sources lists an explicit OpenCode root', () => {
		expect(
			run(['sources', '--opencode-root', opencode_root]).results[0]
				.agent,
		).toBe('opencode');
	});
});
