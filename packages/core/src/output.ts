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
			result.schema_version !== 2 ||
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
	let output = JSON.stringify(result);
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
		output = JSON.stringify(result);
	}
	return output;
}
