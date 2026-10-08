import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
	create_fixture as create_opencode,
	message as opencode_message,
	put_message as put_opencode_message,
} from '../../../packages/adapter-opencode/src/fixtures.ts';
import { jsonl } from '../../../packages/core/src/fixtures.ts';
import { archive_cli, run_cli, temp_dir } from './cli-fixture.ts';

test('Claude tool search and raw-record continuation work through the built CLI', () => {
	const root = temp_dir('omni-claude-cli-');
	const db = join(root, 'archive.db');
	const run = archive_cli(db);
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
	expect(imported.status, imported.stdout + imported.stderr).toBe(0);
	for (const [flags, count] of [
		[[], 0],
		[['--kind', 'all'], 1],
	] as const) {
		const result = run(['search', 'tool_unique_failure', ...flags]);
		expect(result.results).toHaveLength(count);
	}
	const search = run_cli([
		'search',
		'tool_unique_failure',
		'--kind',
		'tool_result',
		'--db',
		db,
		'--json',
	]);
	const hit = JSON.parse(search.stdout).results[0];
	expect(hit.kind).toBe('tool_result');
	const read = run_cli([
		'read',
		hit.ref,
		'--raw',
		'--chars',
		'25',
		'--db',
		db,
		'--json',
	]);
	const first = JSON.parse(read.stdout).results[0];
	expect(first.next_char_offset).toBe(25);
	const next = run_cli([
		'read',
		first.record_ref,
		'--char-offset',
		'25',
		'--chars',
		'25',
		'--db',
		db,
		'--json',
	]);
	expect(JSON.parse(next.stdout).results[0].char_offset).toBe(25);
});

test('OpenCode v2 is discovered through XDG and supports CLI retrieval from live WAL storage', () => {
	const root = temp_dir('omni-opencode-cli-');
	const data = join(root, 'xdg');
	const opencode_root = join(data, 'opencode');
	mkdirSync(opencode_root, { recursive: true });
	const writer = create_opencode(join(opencode_root, 'opencode.db'));
	const db = join(root, 'archive.db');
	const env = { XDG_DATA_HOME: data };
	const run = archive_cli(db, { env });
	try {
		expect(run(['sync', '--agent', 'opencode'])).toMatchObject({
			sources_selected: 1,
			sessions_updated: 1,
		});
		expect(run(['sync', '--agent', 'opencode'])).toMatchObject({
			files_skipped: 1,
			sessions_updated: 0,
		});
		const listed = run([
			'sessions',
			'--agent',
			'opencode',
			'--title',
			'migration',
		]).results[0];
		expect(listed.source_path).toBe(
			join(opencode_root, 'opencode.db'),
		);
		const hit = run([
			'search',
			'opencodeneedle',
			'--session',
			listed.short_id,
		]).results[0];
		expect(hit.agent).toBe('opencode');
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
		expect(run(['search', 'tooloutputneedle']).results).toHaveLength(
			0,
		);
		expect(
			run(['search', 'tooloutputneedle', '--kind', 'tool_result'])
				.results,
		).toHaveLength(1);
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
		expect(
			run(['sources', '--opencode-root', opencode_root]).results[0]
				.agent,
		).toBe('opencode');
	} finally {
		writer.close();
	}
});
