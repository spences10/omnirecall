/** Keep FTS syntax intact while treating common package/path punctuation literally. */
export function search_expression(query: string): string {
	const trimmed = query.trim();
	if (!/["*()^+:]|\b(?:AND|OR|NOT|NEAR)\b/.test(trimmed))
		return trimmed
			.split(/\s+/)
			.map((word) => `"${word}"`)
			.join(' AND ');

	// Consume complete quoted strings (including escaped quotes), or an
	// unfinished quote through end-of-input so SQLite still rejects it.
	return trimmed.replace(
		/"(?:[^"]|"")*(?:"|$)|[^\s"()*^+:,]+/g,
		(term) => {
			if (
				/[-./@]/.test(term) &&
				/^[a-zA-Z0-9_\u0080-\uFFFF./@-]+$/.test(term) &&
				/[a-zA-Z0-9_\u0080-\uFFFF]/.test(term)
			)
				return `"${term}"`;
			return term;
		},
	);
}
