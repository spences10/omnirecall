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
				schema_version: 1,
				status: result.status,
				truncated: true,
				output_budget_exceeded: true,
				results: [],
			});
		rows.pop();
		result.truncated = true;
		if (Array.isArray(result.results)) {
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
