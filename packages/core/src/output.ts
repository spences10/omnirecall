const shared_fields = {
	results: [
		'agent',
		'title',
		'title_truncated',
		'project',
		'project_truncated',
		'source_path',
		'source_status',
		'source_checked_at',
		'path_status',
		'state',
		'representation',
		'active',
		'parent_session',
		'unindexed_records',
	],
	messages: ['state', 'representation', 'active'],
};

/** Schema v3 keeps equal metadata once per table; row values override shared values. */
function shared_metadata(value: Record<string, unknown>) {
	const result = { ...value };
	const shared: Record<string, Record<string, unknown>> = {};
	for (const [table, fields] of Object.entries(shared_fields)) {
		const rows = value[table] as
			| Record<string, unknown>[]
			| undefined;
		if (!Array.isArray(rows) || rows.length < 2) continue;
		const common: Record<string, unknown> = {};
		for (const field of fields) {
			const first: unknown = rows[0]![field];
			if (
				first !== undefined &&
				rows.every(
					(row) => Object.hasOwn(row, field) && row[field] === first,
				)
			)
				common[field] = first;
		}
		if (!Object.keys(common).length) continue;
		shared[table] = common;
		result[table] = rows.map((row) => {
			const copy = { ...row };
			for (const field of Object.keys(common)) delete copy[field];
			return copy;
		});
	}
	if (Object.keys(shared).length) result.shared = shared;
	return result;
}

export function bounded_json(
	value: Record<string, unknown>,
	max_bytes: number,
): string {
	let clipped = false;
	function clip(item: unknown, key = ''): unknown {
		if (typeof item === 'string') {
			if (
				item.length <= 4000 ||
				!['content', 'snippet', 'message'].includes(key)
			)
				return item;
			clipped = true;
			return item.slice(0, 4000);
		}
		if (Array.isArray(item)) return item.map((entry) => clip(entry));
		if (item && typeof item === 'object') {
			const row = item as Record<string, unknown>;
			if (
				row.snippet_truncated ||
				row.title_truncated ||
				row.project_truncated
			)
				clipped = true;
			const result = Object.fromEntries(
				Object.entries(row).map(([key, entry]) => [
					key,
					clip(entry, key),
				]),
			);
			if (typeof row.content === 'string') {
				result.content_truncated =
					Boolean(row.content_truncated) || row.content.length > 4000;
				if (result.content_truncated) clipped = true;
			}
			return result;
		}
		return item;
	}
	const result = clip(value) as Record<string, unknown>;
	function prune_messages() {
		if (
			(result.schema_version !== 2 && result.schema_version !== 3) ||
			!Array.isArray(result.messages) ||
			!Array.isArray(result.results)
		)
			return;
		const refs = new Set(
			result.results.flatMap((row: Record<string, unknown>) => [
				row.ref,
				...(Array.isArray(row.before) ? row.before : []),
				...(Array.isArray(row.after) ? row.after : []),
			]),
		);
		result.messages = result.messages.filter(
			(message: Record<string, unknown>) => refs.has(message.ref),
		);
	}
	prune_messages();
	result.truncated = Boolean(result.truncated) || clipped;
	const render = () =>
		JSON.stringify(
			result.schema_version === 3 ? shared_metadata(result) : result,
		);
	let output = render();
	while (Buffer.byteLength(output) + 1 > max_bytes) {
		const rows =
			Array.isArray(result.results) && result.results.length
				? result.results
				: Array.isArray(result.issues) && result.issues.length
					? result.issues
					: null;
		if (!rows)
			return JSON.stringify({
				schema_version: result.schema_version ?? 1,
				status: result.status,
				truncated: true,
				output_budget_exceeded: true,
				results: [],
			});
		rows.pop();
		prune_messages();
		result.truncated = true;
		if (rows === result.issues) result.issues_truncated = true;
		if (rows === result.results && Array.isArray(result.results)) {
			result.returned_count = result.results.length;
			result.has_more = true;
			result.next_offset =
				Number(result.offset ?? 0) + result.results.length;
			if (!result.results.length)
				result.output_budget_exceeded = true;
		}
		output = render();
	}
	return output;
}
