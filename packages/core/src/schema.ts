import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { InputError } from './types.ts';

export const application_id = 0x4f4d4e49;
export interface SchemaDefinition {
	version: number;
	baseline: string;
	migrations: Readonly<Record<number, string>>;
}
// Freeze schema.sql at publication. Register each later version's SQL here.
export const archive_schema: SchemaDefinition = {
	version: 1,
	baseline: readFileSync(
		new URL('./schema.sql', import.meta.url),
		'utf8',
	),
	migrations: {
		// 2: readFileSync(new URL('./migrations/002_description.sql', import.meta.url), 'utf8'),
	},
};
const baseline_tables = [
	'sources',
	'sessions',
	'resources',
	'records',
	'parts',
	'links',
	'session_inputs',
	'sync_cache',
];

function version(
	db: DatabaseSync,
	definition: SchemaDefinition,
	allow_create: boolean,
): number {
	const id = db
		.prepare('PRAGMA application_id')
		.get()?.application_id;
	const current = Number(
		db.prepare('PRAGMA user_version').get()?.user_version,
	);
	if (id !== application_id) {
		const occupied = db
			.prepare(
				"SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
			)
			.get();
		if (allow_create && id === 0 && current === 0 && !occupied)
			return 0;
		throw new InputError(
			'database',
			'Not an Omni Recall archive; refusing to modify it',
		);
	}
	if (current > definition.version)
		throw new InputError(
			'database',
			`Archive schema ${current} is newer than supported schema ${definition.version}; update omnirecall`,
		);
	if (current < 1)
		throw new InputError(
			'database',
			'Unversioned development archive is unsupported; use a new --db path',
		);
	if (current === 1) {
		// Development v1 predates the release baseline. Never adopt it by version alone.
		const tables = new Set(
			db
				.prepare("SELECT name FROM sqlite_schema WHERE type='table'")
				.all()
				.map((row) => row.name),
		);
		if (baseline_tables.some((table) => !tables.has(table)))
			throw new InputError(
				'database',
				'Archive does not match the release baseline; use a new --db path for development data',
			);
	}
	return current;
}
function transaction(db: DatabaseSync, action: () => void) {
	db.exec('BEGIN IMMEDIATE');
	try {
		action();
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

export function apply_schema(
	db: DatabaseSync,
	options: { read_only?: boolean; allow_create?: boolean } = {},
	definition: SchemaDefinition = archive_schema,
): void {
	const allow_create = Boolean(
		options.allow_create && !options.read_only,
	);
	let current = version(db, definition, allow_create);
	if (options.read_only) {
		if (current < definition.version)
			throw new InputError(
				'database',
				`Archive schema ${current} needs upgrading to ${definition.version}; run omnirecall sync with this database`,
			);
		return;
	}
	// Catch registry gaps before creating or modifying any tables.
	if (
		!Number.isSafeInteger(definition.version) ||
		definition.version < 1
	)
		throw new InputError('database', 'Invalid latest schema version');
	for (
		let next = Math.max(2, current + 1);
		next <= definition.version;
		next++
	)
		if (!definition.migrations[next])
			throw new InputError(
				'database',
				`Missing migration for archive schema ${next}`,
			);
	if (current === 0) {
		transaction(db, () => {
			// Another writer may have initialized the database while we waited for the lock.
			if (version(db, definition, allow_create) !== 0) return;
			db.exec(definition.baseline);
			db.exec(
				`PRAGMA application_id=${application_id}; PRAGMA user_version=1;`,
			);
			version(db, definition, false);
		});
		current = version(db, definition, false);
	}
	for (let next = current + 1; next <= definition.version; next++) {
		transaction(db, () => {
			const locked_version = version(db, definition, false);
			if (locked_version >= next) return;
			if (locked_version !== next - 1)
				throw new InputError(
					'database',
					'Unexpected archive version during migration',
				);
			db.exec(definition.migrations[next]!);
			db.exec(`PRAGMA user_version=${next}`);
		});
	}
}
