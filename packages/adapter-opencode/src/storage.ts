import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InputError } from '../../core/src/errors.ts';
import { digest, max_file_bytes } from '../../core/src/files.ts';
import { text } from '../../core/src/readers.ts';
import type { ImportUnit, JsonObject } from '../../core/src/types.ts';

export type Snapshot = {
	session: JsonObject;
	messages: JsonObject[];
	hash: string;
	bytes: number;
};
const columns = {
	session_v2: [
		'id',
		'directory',
		'title',
		'version',
		'parent_id',
		'fork_session_id',
		'fork_boundary',
		'revert',
		'time_created',
		'time_updated',
	],
	session_message: [
		'id',
		'session_id',
		'type',
		'seq',
		'time_created',
		'time_updated',
		'data',
	],
};

async function open_source(path: string) {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink())
		throw new InputError(
			'unsupported',
			'Expected a regular OpenCode SQLite database, not a symlink',
		);
	const db = new DatabaseSync(path, {
		readOnly: true,
		allowExtension: false,
	});
	try {
		db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
		for (const [table, required] of Object.entries(columns)) {
			const found = new Set(
				db
					.prepare(`PRAGMA table_info(${table})`)
					.all()
					.map((row) => row.name),
			);
			if (required.some((name) => !found.has(name)))
				throw new InputError(
					'unsupported',
					'Expected OpenCode v2 session_v2/session_message storage; legacy layouts are unsupported',
				);
		}
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

export async function discover(root: string): Promise<ImportUnit[]> {
	const path = join(root, 'opencode.db');
	const db = await open_source(path);
	try {
		return db
			.prepare('SELECT id FROM session_v2 ORDER BY id')
			.all()
			.map((row) => ({
				key: JSON.stringify([path, text(row.id)]),
				locators: [path],
			}));
	} finally {
		db.close();
	}
}

export async function snapshot(unit: ImportUnit): Promise<Snapshot> {
	let identity: unknown;
	try {
		identity = JSON.parse(unit.key);
	} catch {
		throw new InputError('invalid', 'Invalid OpenCode import unit');
	}
	if (
		!Array.isArray(identity) ||
		identity.length !== 2 ||
		identity[0] !== unit.locators[0] ||
		unit.locators.length !== 1
	)
		throw new InputError('invalid', 'Invalid OpenCode import unit');
	const path = text(identity[0]),
		id = text(identity[1]);
	const db = await open_source(path);
	try {
		const session = db
			.prepare('SELECT * FROM session_v2 WHERE id=?')
			.get(id);
		if (!session)
			throw new InputError(
				'changed',
				'OpenCode session disappeared during sync; retry sync',
			);
		const size = db
			.prepare(
				'SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS bytes FROM session_message WHERE session_id=?',
			)
			.get(id)!;
		if (
			Number(size.bytes) > max_file_bytes ||
			Number(size.count) > 100_000
		)
			throw new InputError(
				'unsupported',
				'OpenCode session exceeds the 64 MiB or 100000-record import limit',
			);
		const messages: JsonObject[] = [];
		let bytes = Buffer.byteLength(JSON.stringify(session));
		for (const row of db
			.prepare(
				'SELECT * FROM session_message WHERE session_id=? ORDER BY seq, id',
			)
			.iterate(id)) {
			bytes += Buffer.byteLength(JSON.stringify(row));
			if (bytes > max_file_bytes)
				throw new InputError(
					'unsupported',
					'OpenCode session exceeds the 64 MiB import limit',
				);
			messages.push(row);
		}
		if (bytes > max_file_bytes)
			throw new InputError(
				'unsupported',
				'OpenCode session exceeds the 64 MiB import limit',
			);
		// Content hashing catches in-place streaming updates, deletions and WAL-only
		// commits, even when timestamps/sequence maxima have not changed.
		return {
			session,
			messages,
			hash: digest(JSON.stringify([session, messages])),
			bytes,
		};
	} finally {
		db.close();
	}
}
