import { afterEach, beforeEach, expect, test } from 'vitest';
import { Archive } from './database.ts';
import { source_config } from './files.ts';
import type { Source, Transcript } from './types.ts';

const options = { limit: 10, offset: 0, context: 0 };
const source = source_config('pi', '/synthetic/pi');
const other_source = source_config('codex', '/synthetic/codex');
let archive: Archive;
beforeEach(() => {
	archive = new Archive(':memory:');
});
afterEach(() => archive.close());
function store(
	id: string,
	changes: Partial<Transcript> = {},
	owner: Source = source,
) {
	archive.register(owner, 'available');
	const session: Transcript = {
		native_id: id,
		project: '/project',
		title: 'Migration plan',
		parent_session: null,
		timestamp: '2026-09-25T12:00:00.000Z',
		unindexed_records: 0,
		messages: [
			{
				native_id: 'm',
				parent_id: null,
				role: 'user',
				content: 'migration evidence',
				timestamp: '2026-09-26T12:00:00.000Z',
				source_order: 0,
				active: true,
				turn_id: null,
			},
		],
		...changes,
	};
	archive.store(owner, `/synthetic/${id}.jsonl`, session, {
		hash: id,
		byte_offset: 1,
		partial: false,
	});
	return archive
		.sessions({ ...options, source: owner.source_id })
		.find((row) => row.native_id === id)!;
}

test('literal title substrings apply consistently to sessions, search and recall', () => {
	store('one', { title: 'Find Migration 100%_done Café' });
	store('two', { title: 'Migration 100X_done' });
	store('three', { title: null });
	store('four', { title: "O'Reilly migration" });
	for (const [title, count] of [
		['migration', 3],
		['FIND MIGRATION', 1],
		['100%_', 1],
		['Café', 1],
		["O'Reilly", 1],
		["' OR 1=1 --", 0],
		['missing', 0],
	] as const) {
		const filtered = { ...options, title };
		expect(archive.sessions(filtered)).toHaveLength(count);
		expect(archive.search('migration', filtered)).toHaveLength(count);
		expect(archive.recall('migration', filtered)).toHaveLength(count);
	}
});

test('session dates filter session timestamps, not message timestamps, before pagination', () => {
	store('before', { timestamp: '2026-09-24T23:59:59.999Z' });
	store('start', { timestamp: '2026-09-25T00:00:00.000Z' });
	store('end', { timestamp: '2026-09-25T23:59:59.999Z' });
	store('after', { timestamp: '2026-09-26T00:00:00.000Z' });
	store('other-title', { title: 'Unrelated' });
	const bounds = {
		...options,
		title: 'migration',
		after: '2026-09-25T00:00:00.000Z',
		before: '2026-09-25T23:59:59.999Z',
	};
	expect(
		archive.sessions(bounds).map((row) => row.native_id),
	).toEqual(['end', 'start']);
	expect(
		archive
			.sessions({ ...bounds, limit: 1, offset: 1 })
			.map((row) => row.native_id),
	).toEqual(['start']);
	expect(
		archive
			.sessions({ ...bounds, before: bounds.after })
			.map((row) => row.native_id),
	).toEqual(['start']);
	expect(archive.search('migration', bounds)).toEqual([]);
	expect(
		archive.search('migration', {
			...bounds,
			after: '2026-09-26T00:00:00.000Z',
			before: undefined,
		}),
	).toHaveLength(4);
});

test('canonical IDs, archive IDs, native IDs and unique prefixes select the same session', () => {
	const row = store('01234567-89ab-cdef-0123-456789abcdef');
	expect(row.short_id).toBe(row.archive_id.slice(0, 12));
	for (const session of [
		row.session_id,
		row.archive_id,
		row.native_id,
		row.native_id.slice(0, 8),
		row.short_id,
	]) {
		const scoped = { ...options, session };
		expect(archive.sessions(scoped).map((r) => r.archive_id)).toEqual(
			[row.archive_id],
		);
		expect(
			archive.search('migration', scoped).map((r) => r.archive_id),
		).toEqual([row.archive_id]);
		expect(
			archive.recall('migration', scoped).map((r) => r.archive_id),
		).toEqual([row.archive_id]);
	}
	for (const session of ['not-found', '01234567-NOT-FOUND']) {
		expect(archive.sessions({ ...options, session })).toEqual([]);
		expect(
			archive.search('migration', { ...options, session }),
		).toEqual([]);
	}
	expect(() => archive.sessions({ ...options, session: '' })).toThrow(
		'must not be empty',
	);
});

test('native collisions require identity scope and cannot be hidden by title, date, query or pagination', () => {
	const first = store('shared-native', {
		title: 'First',
		session_key: 'first-unit',
	});
	store(
		'shared-native',
		{ title: 'Second', project: '/other-project' },
		other_source,
	);
	const session = 'shared-native';
	for (const filter of [
		{},
		{ title: 'First' },
		{ before: '2000-01-01T00:00:00.000Z' },
		{ limit: 1, offset: 50 },
	]) {
		expect(() =>
			archive.sessions({ ...options, session, ...filter }),
		).toThrow('Ambiguous session');
		expect(() =>
			archive.search('absent', { ...options, session, ...filter }),
		).toThrow('Ambiguous session');
		expect(() =>
			archive.recall('migration', { ...options, session, ...filter }),
		).toThrow('Ambiguous session');
	}
	for (const scope of [
		{ agent: 'pi' },
		{ source: source.source_id },
		{ project: '/project' },
	] as const) {
		expect(
			archive.sessions({ ...options, ...scope, session })[0]
				?.archive_id,
		).toBe(first.archive_id);
		expect(
			archive.search('migration', {
				...options,
				...scope,
				session,
			})[0]?.archive_id,
		).toBe(first.archive_id);
	}
	store('shared-native', { session_key: 'second-unit' });
	expect(() =>
		archive.sessions({
			...options,
			session,
			source: source.source_id,
		}),
	).toThrow('Ambiguous session');
	expect(
		archive.sessions({ ...options, session: first.session_id }),
	).toHaveLength(1);
	expect(
		archive.sessions({ ...options, session: first.archive_id }),
	).toHaveLength(1);
});

test('short IDs account for collisions outside the listed page and filters', () => {
	const first = store('original', { title: 'First' });
	store(
		`${first.short_id}copy`,
		{ title: 'Other', project: '/other' },
		other_source,
	);
	const refreshed = archive.sessions({
		...options,
		title: 'First',
		source: source.source_id,
		limit: 1,
	})[0]!;
	expect(refreshed.short_id.length).toBeGreaterThan(
		first.short_id.length,
	);
	expect(
		archive.sessions({ ...options, session: refreshed.short_id })[0]
			?.archive_id,
	).toBe(first.archive_id);
	expect(() =>
		archive.sessions({ ...options, session: first.short_id }),
	).toThrow('Ambiguous session');
	// Full archive/canonical identities remain authoritative even if a native ID matches them.
	store(first.archive_id, {}, other_source);
	expect(
		archive.sessions({ ...options, session: first.archive_id })[0]
			?.archive_id,
	).toBe(first.archive_id);
	expect(
		archive.sessions({ ...options, session: first.session_id })[0]
			?.archive_id,
	).toBe(first.archive_id);
});

test('native prefixes are literal and exact native IDs do not override competing prefixes', () => {
	const literal = store('under_score%native');
	store('underZscoreXnative');
	expect(
		archive.sessions({ ...options, session: 'under_score%' })[0]
			?.archive_id,
	).toBe(literal.archive_id);
	store('under_score%native-copy');
	expect(() =>
		archive.sessions({ ...options, session: literal.native_id }),
	).toThrow('Ambiguous session');
	expect(
		archive.sessions({ ...options, session: literal.short_id })[0]
			?.archive_id,
	).toBe(literal.archive_id);
});
