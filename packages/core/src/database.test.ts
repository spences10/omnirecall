import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { Archive } from './database.ts';
import { type Source, type Transcript } from './types.ts';

const source: Source = {
	source_id: 'pi:test',
	agent: 'pi',
	root: '/test',
};
const transcript: Transcript = {
	native_id: 'session',
	project: '/test',
	title: 'Test session',
	parent_session: null,
	timestamp: '2026-01-01T00:00:00.000Z',
	omitted_records: 0,
	messages: [
		{
			native_id: 'message',
			parent_id: null,
			role: 'user',
			content: 'migration',
			timestamp: '2026-01-01T00:00:00.000Z',
			source_order: 1,
			active: true,
			turn_id: null,
		},
	],
};
const snapshot = {
	hash: 'same-transcript',
	byte_offset: 1,
	partial: false,
};
const options = { limit: 10, offset: 0, context: 2 };

test('refuses a foreign database without changing it', () => {
	const root = mkdtempSync(join(tmpdir(), 'omnirecall-ownership-'));
	try {
		const path = join(root, 'foreign.sqlite');
		const foreign = new DatabaseSync(path);
		foreign.exec('CREATE TABLE keep_me(value TEXT);');
		foreign.close();
		const original = readFileSync(path);
		expect(() => new Archive(path)).toThrow(
			'Not an Omni Recall archive',
		);
		expect(readFileSync(path)).toEqual(original);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('provenance path and status come from the same most recent candidate', () => {
	vi.useFakeTimers();
	const archive = new Archive(':memory:');
	try {
		archive.register(source, 'available');
		archive.store(source, '/test/a.jsonl', transcript, snapshot);
		archive.store(source, '/test/z.jsonl', transcript, snapshot);
		vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
		archive.path_status(source, '/test/a.jsonl', 'missing');
		vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'));
		archive.path_status(source, '/test/z.jsonl', 'blocked');
		for (const row of [
			...archive.sessions(options),
			...archive.search('migration', options),
		]) {
			expect(row).toMatchObject({
				source_path: '/test/z.jsonl',
				path_status: 'blocked',
			});
		}
	} finally {
		archive.close();
		vi.useRealTimers();
	}
});

test('reuses statements across imports and retrievals', () => {
	const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
	const archive = new Archive(':memory:');
	try {
		for (let index = 0; index < 3; index++) {
			archive.register(source, 'available');
			archive.store(source, '/test/session.jsonl', transcript, {
				...snapshot,
				hash: `revision-${index}`,
			});
			expect(archive.recall('migration', options)).toHaveLength(1);
		}
		const queries = prepare.mock.calls.map(([query]) => query);
		expect(
			queries.filter((query) =>
				query.includes('INSERT INTO messages'),
			),
		).toHaveLength(1);
		expect(queries).toHaveLength(new Set(queries).size);
	} finally {
		archive.close();
		prepare.mockRestore();
	}
});

test('source lookup, coverage and path reconciliation preserve archived sessions', () => {
	const archive = new Archive(':memory:');
	try {
		expect(archive.source('absent')).toBeUndefined();
		expect(archive.coverage()).toEqual({
			indexed_sessions: 0,
			source_statuses: [],
			freshness: 'last_explicit_sync',
		});
		archive.register(source, 'available');
		archive.store(
			source,
			'/test/session.jsonl',
			transcript,
			snapshot,
		);
		const codex_source: Source = {
			...source,
			source_id: 'codex:test',
			agent: 'codex',
		};
		archive.register(codex_source, 'blocked');
		expect(archive.source(source.source_id)).toMatchObject({
			...source,
			status: 'available',
		});
		expect(archive.coverage({ agent: 'pi' })).toEqual({
			indexed_sessions: 1,
			source_statuses: [{ status: 'available', count: 1 }],
			freshness: 'last_explicit_sync',
		});
		expect(
			archive.coverage({ source: codex_source.source_id }),
		).toEqual({
			indexed_sessions: 0,
			source_statuses: [{ status: 'blocked', count: 1 }],
			freshness: 'last_explicit_sync',
		});
		archive.reconcile_paths(source, new Set());
		expect(archive.search('migration', options)[0]).toMatchObject({
			source_path: '/test/session.jsonl',
			path_status: 'missing',
		});
		expect(archive.coverage().indexed_sessions).toBe(1);
	} finally {
		archive.close();
	}
});

test('reopens the version-one schema without migrating or modifying it', () => {
	const root = mkdtempSync(join(tmpdir(), 'omnirecall-schema-'));
	const path = join(root, 'archive.sqlite');
	try {
		const existing = new DatabaseSync(path);
		try {
			existing.exec(
				readFileSync(
					new URL('./schema.sql', import.meta.url),
					'utf8',
				),
			);
			existing.exec(
				'PRAGMA application_id=0x4f4d4e49; PRAGMA user_version=1;',
			);
		} finally {
			existing.close();
		}
		const original = readFileSync(path);
		const archive = new Archive(path, true);
		try {
			expect(archive.coverage().indexed_sessions).toBe(0);
			expect(archive.sessions(options)).toEqual([]);
		} finally {
			archive.close();
		}
		expect(readFileSync(path)).toEqual(original);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
