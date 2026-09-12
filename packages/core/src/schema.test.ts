import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import {
	apply_schema,
	archive_schema,
	application_id,
	type SchemaDefinition,
} from './schema.ts';

const upgrade: SchemaDefinition = {
	...archive_schema,
	version: 3,
	migrations: {
		2: "ALTER TABLE sources ADD COLUMN migration_note TEXT; UPDATE sources SET migration_note='preserved';",
		3: 'CREATE TABLE migration_audit (source_id TEXT); INSERT INTO migration_audit SELECT source_id FROM sources;',
	},
};
function version(db: DatabaseSync) {
	return db.prepare('PRAGMA user_version').get()?.user_version;
}
function fixture(db: DatabaseSync) {
	apply_schema(db, { allow_create: true });
	db.exec(
		"INSERT INTO sources VALUES('pi:test','pi','/test','available',NULL)",
	);
}

test('fresh baseline includes the cache and reopening is idempotent', () => {
	const db = new DatabaseSync(':memory:');
	try {
		fixture(db);
		apply_schema(db);
		expect(version(db)).toBe(1);
		expect(
			db.prepare('PRAGMA application_id').get()?.application_id,
		).toBe(application_id);
		expect(db.prepare('SELECT * FROM sync_cache').all()).toEqual([]);
		expect(db.prepare('SELECT source_id FROM sources').all()).toEqual(
			[{ source_id: 'pi:test' }],
		);
	} finally {
		db.close();
	}
});

test('fresh and existing archives apply ordered upgrades and retain data', () => {
	for (const fresh of [true, false]) {
		const db = new DatabaseSync(':memory:');
		try {
			if (!fresh) fixture(db);
			apply_schema(db, { allow_create: fresh }, upgrade);
			apply_schema(db, {}, upgrade);
			expect(version(db)).toBe(3);
			expect(
				db
					.prepare('SELECT source_id,migration_note FROM sources')
					.all(),
			).toEqual(
				fresh
					? []
					: [{ source_id: 'pi:test', migration_note: 'preserved' }],
			);
			expect(
				db.prepare('SELECT * FROM migration_audit').all(),
			).toEqual(fresh ? [] : [{ source_id: 'pi:test' }]);
		} finally {
			db.close();
		}
	}
});

test('failed migration rolls back its DDL, data, and version and retries from the last committed step', () => {
	const db = new DatabaseSync(':memory:');
	try {
		fixture(db);
		const broken = {
			...upgrade,
			migrations: {
				...upgrade.migrations,
				3: 'ALTER TABLE sources ADD COLUMN failed TEXT; DELETE FROM sources; INSERT INTO missing_table VALUES(1);',
			},
		};
		expect(() => apply_schema(db, {}, broken)).toThrow();
		expect(version(db)).toBe(2);
		expect(
			db
				.prepare('SELECT source_id,migration_note FROM sources')
				.all(),
		).toEqual([
			{ source_id: 'pi:test', migration_note: 'preserved' },
		]);
		expect(
			db
				.prepare('PRAGMA table_info(sources)')
				.all()
				.some((row) => row.name === 'failed'),
		).toBe(false);
		apply_schema(db, {}, upgrade);
		expect(version(db)).toBe(3);
		expect(db.prepare('SELECT * FROM migration_audit').all()).toEqual(
			[{ source_id: 'pi:test' }],
		);
	} finally {
		db.close();
	}
});

test('a missing migration is rejected before modifying a fresh or existing archive', () => {
	for (const fresh of [true, false]) {
		const db = new DatabaseSync(':memory:');
		try {
			if (!fresh) fixture(db);
			expect(() =>
				apply_schema(
					db,
					{ allow_create: fresh },
					{ ...upgrade, migrations: { 2: upgrade.migrations[2]! } },
				),
			).toThrow('Missing migration');
			expect(version(db)).toBe(fresh ? 0 : 1);
			if (!fresh)
				expect(
					db.prepare('SELECT source_id FROM sources').all(),
				).toEqual([{ source_id: 'pi:test' }]);
		} finally {
			db.close();
		}
	}
});

test('initialization failure rolls back schema creation and ownership metadata', () => {
	const db = new DatabaseSync(':memory:');
	try {
		expect(() =>
			apply_schema(
				db,
				{ allow_create: true },
				{
					...archive_schema,
					baseline:
						'CREATE TABLE temporary_table(value TEXT); INSERT INTO missing_table VALUES(1);',
				},
			),
		).toThrow();
		expect(version(db)).toBe(0);
		expect(
			db.prepare('PRAGMA application_id').get()?.application_id,
		).toBe(0);
		expect(
			db.prepare('SELECT name FROM sqlite_schema').all(),
		).toEqual([]);
	} finally {
		db.close();
	}
});

test('read-only opens never upgrade; outdated and newer archives remain byte-identical', () => {
	const root = mkdtempSync(join(tmpdir(), 'omni-migrations-'));
	const path = join(root, 'archive.db');
	try {
		const writer = new DatabaseSync(path);
		fixture(writer);
		writer.close();
		const original = readFileSync(path);
		const reader = new DatabaseSync(path, { readOnly: true });
		try {
			apply_schema(reader, { read_only: true });
			expect(() =>
				apply_schema(reader, { read_only: true }, upgrade),
			).toThrow('run omnirecall sync');
		} finally {
			reader.close();
		}
		expect(readFileSync(path)).toEqual(original);
		const newer = new DatabaseSync(path);
		apply_schema(newer, {}, upgrade);
		newer.close();
		const upgraded = readFileSync(path);
		for (const read_only of [true, false]) {
			const db = new DatabaseSync(path, { readOnly: read_only });
			try {
				expect(() => apply_schema(db, { read_only })).toThrow(
					'newer than supported',
				);
			} finally {
				db.close();
			}
			expect(readFileSync(path)).toEqual(upgraded);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('an unversioned database is not adopted even when it has Omni ownership', () => {
	const db = new DatabaseSync(':memory:');
	try {
		db.exec(
			`PRAGMA application_id=${application_id}; CREATE TABLE sessions(id TEXT);`,
		);
		expect(() => apply_schema(db)).toThrow(
			'Unversioned development archive',
		);
		expect(version(db)).toBe(0);
	} finally {
		db.close();
	}
});
