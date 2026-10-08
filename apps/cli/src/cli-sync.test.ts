import {
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
	codex_records,
	jsonl,
	pi_records,
} from '../../../packages/core/src/fixtures.ts';
import { run_cli, temp_dir } from './cli-fixture.ts';

test('creates omnirecall.db in the platform data directory', () => {
	const root = temp_dir('omnirecall-paths-');
	const pi_root = join(root, 'sessions');
	mkdirSync(pi_root);
	writeFileSync(join(pi_root, 'session.jsonl'), jsonl(pi_records()));
	const env = {
		HOME: root,
		USERPROFILE: root,
		XDG_DATA_HOME: join(root, 'xdg-data'),
		LOCALAPPDATA: join(root, 'local-data'),
		OMNIRECALL_DB: undefined,
	};
	const data_dir =
		process.platform === 'darwin'
			? join(root, 'Library', 'Application Support', 'omnirecall')
			: process.platform === 'win32'
				? join(root, 'local-data', 'omnirecall', 'Data')
				: join(root, 'xdg-data', 'omnirecall');
	const result = run_cli(
		['sync', '--pi-root', pi_root, '--json'],
		env,
	);
	expect(result.status, result.stderr + result.stdout).toBe(0);
	expect(existsSync(join(data_dir, 'omnirecall.db'))).toBe(true);
	const recalled = run_cli(['recall', 'migrations', '--json'], env);
	expect(recalled.status, recalled.stderr + recalled.stdout).toBe(0);
	expect(JSON.parse(recalled.stdout).returned_count).toBe(1);
});

test('plain sync discovers available histories, reuses custom sources and respects overrides', () => {
	const home = temp_dir('omni-auto-');
	const env = {
		HOME: home,
		USERPROFILE: home,
		CODEX_HOME: join(home, '.codex'),
	};
	const db = join(home, 'archive.db');
	const pi = join(home, '.pi', 'agent', 'sessions'),
		codex = join(home, '.codex', 'sessions');
	mkdirSync(pi, { recursive: true });
	mkdirSync(codex, { recursive: true });
	writeFileSync(join(pi, 'pi.jsonl'), jsonl(pi_records('auto-pi')));
	writeFileSync(
		join(codex, 'codex.jsonl'),
		jsonl(codex_records('auto-codex')),
	);
	writeFileSync(
		join(home, '.codex', 'history.jsonl'),
		'not a supported session\n',
	);
	let run = run_cli(['sync', '--db', db, '--json'], env);
	expect(run.status, run.stdout + run.stderr).toBe(0);
	expect(JSON.parse(run.stdout)).toMatchObject({
		sources_selected: 2,
		sessions_updated: 2,
	});
	const custom = join(home, 'custom');
	mkdirSync(custom);
	writeFileSync(
		join(custom, 'pi.jsonl'),
		jsonl(pi_records('custom-pi')),
	);
	run = run_cli(
		['sync', '--pi-root', custom, '--db', db, '--json'],
		env,
	);
	expect(JSON.parse(run.stdout)).toMatchObject({
		sources_selected: 1,
		sessions_updated: 1,
	});
	run = run_cli(['sync', '--db', db, '--json'], env);
	expect(JSON.parse(run.stdout)).toMatchObject({
		sources_selected: 3,
		sessions_updated: 0,
	});
	run = run_cli(
		['sync', '--agent', 'codex', '--db', db, '--json'],
		env,
	);
	expect(JSON.parse(run.stdout).sources_selected).toBe(1);
	rmSync(custom, { recursive: true });
	run = run_cli(['sync', '--db', db, '--json'], env);
	expect(run.status).toBe(2);
	expect(JSON.parse(run.stdout).issues[0].code).toBe('missing');
});

test('captured sync shows a concise summary and JSON mode stays structured', () => {
	const root = temp_dir('omni-progress-');
	const sessions = join(root, 'sessions');
	mkdirSync(sessions);
	writeFileSync(join(sessions, 'session.jsonl'), jsonl(pi_records()));
	const args = [
		'sync',
		'--pi-root',
		sessions,
		'--db',
		join(root, 'archive.db'),
	];
	const human = run_cli(args);
	expect(human.status).toBe(0);
	expect(human.stderr).not.toContain('Starting sync');
	expect(human.stdout).toContain('Sync complete.');
	expect(human.stdout).toMatch(/Files processed\s+1/);
	expect(human.stdout).not.toContain('schema_version');
	const machine = run_cli([...args, '--json']);
	expect(machine.status).toBe(0);
	expect(machine.stderr).not.toContain('Starting sync');
	expect(machine.stderr).not.toContain('Checking pi');
	expect(JSON.parse(machine.stdout).files_indexed).toBe(1);
});

test('human sync groups every issue while verbose and JSON retain bounded details', () => {
	const root = temp_dir('omni-summary-');
	const sessions = join(root, 'sessions');
	mkdirSync(sessions);
	for (let i = 0; i < 105; i++)
		writeFileSync(join(sessions, `bad-${i}.jsonl`), 'invalid\n');
	const args = [
		'sync',
		'--pi-root',
		sessions,
		'--db',
		join(root, 'archive.db'),
	];
	const human = run_cli(args);
	expect(human.status).toBe(2);
	expect(human.stdout).toContain('Sync completed with issues.');
	expect(human.stdout).toContain('pi: 105 invalid data');
	expect(human.stdout).not.toContain(sessions);
	expect(human.stdout).not.toContain('Invalid complete');
	expect(human.stdout).toContain('--verbose');
	const verbose = run_cli([...args, '--verbose']);
	expect(verbose.status).toBe(2);
	expect(verbose.stdout).toContain(sessions);
	expect(verbose.stdout).toContain('Showing 100 of 105 issues.');
	const machine = run_cli([...args, '--json']);
	expect(machine.status).toBe(2);
	const result = JSON.parse(machine.stdout);
	expect(result.issue_counts).toEqual([
		{ agent: 'pi', code: 'invalid', count: 105 },
	]);
	expect(result.issues).toHaveLength(100);
	expect(result.issues_truncated).toBe(true);
});

test('empty and failed human syncs give plain explanations', () => {
	const root = temp_dir('omni-empty-summary-');
	const empty = run_cli(['sync', '--db', join(root, 'archive.db')]);
	expect(empty.status).toBe(0);
	expect(empty.stdout).toContain('Nothing to sync.');
	const failed = run_cli(['sync', '--agent', 'unknown']);
	expect(failed.status).toBe(1);
	expect(failed.stderr).toContain('Sync failed:');
	expect(failed.stdout).toBe('');
});
