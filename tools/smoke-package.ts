import assert from 'node:assert/strict';
import {
	spawnSync,
	type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'omnirecall-package-'));
function run(
	command: string,
	args: string[],
	options: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> = {},
) {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		timeout: 120_000,
		...options,
	});
	assert.equal(
		result.status,
		0,
		`${command} ${args.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`,
	);
	return result.stdout;
}
try {
	run(
		'pnpm',
		['--filter', 'omnirecall', 'pack', '--pack-destination', scratch],
		{ cwd: root },
	);
	const tarball = readdirSync(scratch).find((name) =>
		name.endsWith('.tgz'),
	);
	assert.ok(tarball, 'Package tarball was produced');
	const consumer = join(scratch, 'consumer');
	mkdirSync(consumer);
	writeFileSync(
		join(consumer, 'package.json'),
		JSON.stringify({ private: true }),
	);
	run(
		'npm',
		[
			'install',
			'--ignore-scripts',
			'--no-audit',
			'--no-fund',
			join(scratch, tarball),
		],
		{ cwd: consumer },
	);
	const home = join(scratch, 'home');
	const source = join(home, '.pi', 'agent', 'sessions');
	mkdirSync(source, { recursive: true });
	const timestamp = '2026-09-01T10:00:00.000Z';
	writeFileSync(
		join(source, 'fixture.jsonl'),
		[
			{
				type: 'session',
				version: 3,
				id: 'package-smoke',
				cwd: '/synthetic',
				timestamp,
			},
			{
				type: 'message',
				id: 'm1',
				parentId: null,
				timestamp,
				message: { role: 'user', content: 'package-smoke-needle' },
			},
		]
			.map((record) => JSON.stringify(record))
			.join('\n') + '\n',
	);
	const entry = join(
		consumer,
		'node_modules',
		'omnirecall',
		'dist',
		'index.js',
	);
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		CODEX_HOME: join(home, '.codex'),
		XDG_DATA_HOME: join(home, '.local', 'share'),
	};
	const db = join(scratch, 'archive.sqlite');
	const cli = (args: string[]) =>
		JSON.parse(
			run(process.execPath, [entry, ...args, '--db', db, '--json'], {
				cwd: consumer,
				env,
			}),
		);
	assert.equal(
		cli(['sync', '--pi-root', source]).sessions_updated,
		1,
	);
	assert.equal(
		cli(['sync', '--pi-root', source]).sessions_updated,
		0,
	);
	const hits = cli(['search', 'package-smoke-needle']).results;
	assert.equal(hits.length, 1);
	assert.equal(hits[0].agent, 'pi');
	assert.ok(JSON.stringify(hits[0]).includes('package-smoke-needle'));
	console.log(
		'Packed package: isolated install, sync, repeat sync and search passed.',
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
