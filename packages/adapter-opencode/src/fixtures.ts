// Synthetic data only; never copy developer histories into tests.
import { DatabaseSync } from 'node:sqlite';
export const created = 1_788_257_600_000;
export const session_id = 'ses_synthetic';
export const schema = `
CREATE TABLE session_v2 (
 id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT, version TEXT NOT NULL,
 parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT, revert TEXT,
 time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
);
CREATE TABLE session_message (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE,
 type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
 data TEXT NOT NULL, UNIQUE(session_id, seq)
);`;
export function session(id = session_id) {
	return {
		id,
		directory: '/synthetic/opencode-project',
		title: 'OpenCode migration plan',
		version: '2.0.22',
		parent_id: null,
		fork_session_id: null,
		fork_boundary: null,
		revert: null,
		time_created: created,
		time_updated: created,
	};
}
export function message(
	seq: number,
	type: string,
	data: Record<string, unknown>,
	owner = session_id,
) {
	return {
		id: `msg_${owner}_${seq}`,
		session_id: owner,
		type,
		seq,
		time_created: created,
		time_updated: created,
		data: JSON.stringify({
			time: { created, completed: created + 1 },
			...data,
		}),
	};
}
export function messages(owner = session_id) {
	return [
		message(
			0,
			'user',
			{ text: 'Prepare the database', files: [], agents: [] },
			owner,
		),
		message(
			1,
			'assistant',
			{
				content: [
					{
						type: 'reasoning',
						text: 'reasoningneedle private reasoning',
					},
					{
						type: 'tool',
						id: 'call_1',
						name: 'read',
						state: {
							status: 'completed',
							input: { path: 'schema.ts' },
							content: [
								{
									type: 'text',
									text: 'tooloutputneedle schema details',
								},
							],
						},
					},
				],
			},
			owner,
		),
		message(
			2,
			'assistant',
			{
				content: [
					{
						type: 'text',
						text: 'Use opencodeneedle migrations safely',
					},
				],
			},
			owner,
		),
		message(
			3,
			'user',
			{ text: 'Confirm the final checks', files: [], agents: [] },
			owner,
		),
		message(4, 'idle', { outcome: 'succeeded' }, owner),
	];
}
export function put_message(
	db: DatabaseSync,
	row: ReturnType<typeof message>,
) {
	db.prepare(
		'INSERT OR REPLACE INTO session_message VALUES($id,$session_id,$type,$seq,$time_created,$time_updated,$data)',
	).run(row);
}
export function put_session(db: DatabaseSync, id = session_id) {
	db.prepare(
		'INSERT INTO session_v2 VALUES($id,$directory,$title,$version,$parent_id,$fork_session_id,$fork_boundary,$revert,$time_created,$time_updated)',
	).run(session(id));
	for (const row of messages(id)) put_message(db, row);
}
export function create_fixture(path: string) {
	const db = new DatabaseSync(path);
	db.exec(
		'PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;',
	);
	db.exec(schema);
	put_session(db);
	return db;
}
