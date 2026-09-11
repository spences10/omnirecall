const message_columns = (start = '1', count = '4000') => `
	m.rowid, m.revision_id, m.native_id, m.parent_id, m.role, m.kind, m.representation, m.state, m.record_key, m.json_pointer,
	substr(m.content, ${start}, ${count}) AS content,
	length(m.content) >= (${start}) + (${count}) AS content_truncated,
	m.timestamp, m.source_order, m.active, m.turn_id
`;

const source_filter = `
	($agent IS NULL OR s.agent = $agent)
	AND ($source IS NULL OR s.source_id = $source)
`;

const session_filter = `
	${source_filter}
	AND ($project IS NULL OR r.project = $project)
	AND ($session IS NULL OR t.session_id = $session)
	AND ($include_history = 1 OR r.revision_id = t.current_revision)
`;

// Select one path so its location and status always describe the same observation.
const provenance_join = `
	LEFT JOIN resources p ON p.rowid = (
		SELECT candidate.rowid
		FROM resources candidate
		WHERE EXISTS (SELECT 1 FROM revision_inputs ri WHERE ri.revision_id = r.revision_id AND ri.source_id=candidate.source_id AND ri.path=candidate.path)
		ORDER BY
			CASE candidate.status
				WHEN 'available' THEN 0
				WHEN 'partial' THEN 1
				ELSE 2
			END,
			candidate.checked_at DESC,
			candidate.path
		LIMIT 1
	)
`;

const provenance_columns = `
	COALESCE(p.path, r.recorded_path) AS source_path,
	COALESCE(p.status, 'superseded') AS path_status
`;

export const sql = {
	get_source: `
		SELECT source_id, agent, root, status, checked_at
		FROM sources
		WHERE source_id = $source_id
	`,
	source_paths: `
		SELECT path FROM resources WHERE source_id = $source_id
	`,
	find_revision: `
		SELECT revision_id FROM revisions WHERE revision_id = $revision_id
	`,
	register_source: `
		INSERT INTO sources (source_id, agent, root, status, checked_at)
		VALUES ($source_id, $agent, $root, $status, $checked_at)
		ON CONFLICT (source_id) DO UPDATE SET
			status = excluded.status,
			checked_at = excluded.checked_at
	`,
	select_revision: `
		INSERT INTO sessions (session_id, source_id, native_id, current_revision)
		VALUES ($session_id, $source_id, $native_id, $revision_id)
		ON CONFLICT (session_id) DO UPDATE SET
			current_revision = excluded.current_revision
	`,
	insert_revision: `
		INSERT INTO revisions (
			revision_id, session_id, hash, parser_version, project, title,
			parent_session, timestamp, indexed_at, unindexed_records, recorded_path
		)
		VALUES (
			$revision_id, $session_id, $hash, $parser_version, $project, $title,
			$parent_session, $timestamp, $indexed_at, $unindexed_records, $recorded_path
		)
	`,
	insert_message: `
		INSERT INTO parts (
			revision_id, native_id, parent_id, role, kind, representation, state, record_key, json_pointer, content,
			timestamp, source_order, active, turn_id
		)
		VALUES (
			$revision_id, $native_id, $parent_id, $role, $kind, $representation, $state, $record_key, $json_pointer, $content,
			$timestamp, $source_order, $active, $turn_id
		)
	`,
	store_path: `
		INSERT INTO resources (
			source_id, path, session_id, revision_id, status,
			byte_offset, parser_version, checked_at
		)
		VALUES (
			$source_id, $path, $session_id, $revision_id, $status,
			$byte_offset, $parser_version, $checked_at
		)
		ON CONFLICT (source_id, path) DO UPDATE SET
			session_id = excluded.session_id,
			revision_id = excluded.revision_id,
			status = excluded.status,
			byte_offset = excluded.byte_offset,
			parser_version = excluded.parser_version,
			checked_at = excluded.checked_at
	`,
	path_status: `
		INSERT INTO resources (source_id, path, status, checked_at)
		VALUES ($source_id, $path, $status, $checked_at)
		ON CONFLICT (source_id, path) DO UPDATE SET
			status = excluded.status,
			checked_at = excluded.checked_at
	`,
	indexed_sessions: `
		SELECT count(*) AS indexed_sessions
		FROM sessions t JOIN sources s USING (source_id)
		WHERE ${source_filter}
	`,
	source_statuses: `
		SELECT s.status, count(*) AS count
		FROM sources s
		WHERE ${source_filter}
		GROUP BY s.status
		ORDER BY s.status
	`,
	sources: `
		SELECT s.source_id, s.agent, s.root, s.status, s.checked_at,
			(SELECT count(*) FROM sessions t WHERE t.source_id = s.source_id) AS session_count
		FROM sources s
		WHERE ${source_filter}
		ORDER BY s.source_id
		LIMIT $limit OFFSET $offset
	`,
	sessions: `
		SELECT
			t.session_id, t.native_id, s.source_id, s.agent, s.root,
			s.status AS source_status, s.checked_at AS source_checked_at,
			r.revision_id, r.hash, r.parser_version, r.project, r.title,
			r.parent_session, r.timestamp, r.indexed_at, r.unindexed_records,
			r.recorded_path,
			(r.revision_id = t.current_revision) AS current_revision,
			${provenance_columns}
		FROM sessions t
		JOIN sources s USING (source_id)
		JOIN revisions r USING (session_id)
		${provenance_join}
		WHERE ${session_filter}
		ORDER BY r.timestamp DESC, t.session_id, r.revision_id
		LIMIT $limit OFFSET $offset
	`,
	search: `
		SELECT
			${message_columns()},
			t.session_id, s.source_id, s.agent, s.root,
			s.status AS source_status, s.checked_at AS source_checked_at,
			r.project, r.title, r.parent_session, r.indexed_at, r.unindexed_records,
			(r.revision_id = t.current_revision) AS current_revision,
			${provenance_columns},
			substr(snippet(parts_fts, 0, '', '', '…', 32), 1, 4000) AS snippet,
			max(0, instr(m.content, snippet(parts_fts, 0, '', '', '', 32)) - 1) AS char_offset,
			bm25(parts_fts) AS relevance
		FROM parts_fts
		JOIN parts m ON m.rowid = parts_fts.rowid
		JOIN revisions r USING (revision_id)
		JOIN sessions t ON t.session_id = r.session_id
		JOIN sources s USING (source_id)
		${provenance_join}
		WHERE parts_fts MATCH $query
			AND ${session_filter}
			AND ($include_history = 1 OR (m.active = 1 AND m.representation = 'primary'))
			AND ($kind IS NULL OR m.kind = $kind)
			AND ($after IS NULL OR m.timestamp >= $after)
			AND ($before IS NULL OR m.timestamp <= $before)
		ORDER BY relevance, m.timestamp DESC, t.session_id,
			r.revision_id, m.source_order, m.native_id
		LIMIT $limit OFFSET $offset
	`,
	read_message: `
		SELECT ${message_columns('$char_offset + 1', '$chars')},
			length(m.content) AS content_length,
			t.session_id, s.source_id, s.agent, s.root,
			s.status AS source_status, s.checked_at AS source_checked_at,
			r.project, r.title, r.parent_session, r.indexed_at, r.unindexed_records,
			(r.revision_id = t.current_revision) AS current_revision,
			${provenance_columns}
		FROM parts m
		JOIN revisions r USING (revision_id)
		JOIN sessions t ON t.session_id = r.session_id
		JOIN sources s USING (source_id)
		${provenance_join}
		WHERE m.revision_id = $revision_id AND m.native_id = $native_id
	`,
	message: `
		SELECT ${message_columns()}
		FROM parts m
		WHERE m.revision_id = $revision_id AND m.native_id = $native_id
	`,
	children: `
		SELECT ${message_columns()}
		FROM parts m
		WHERE m.revision_id = $revision_id
			AND m.parent_id = $parent_id AND m.active = $active
            AND ($kind != 'message' OR m.kind = 'message')
		ORDER BY m.source_order
		LIMIT 2
	`,
};
