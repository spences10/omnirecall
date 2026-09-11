import type { sync } from '../../../packages/core/src/sync.ts';

type Result = Awaited<ReturnType<typeof sync>> & {
	sources_selected?: number;
	message?: string;
};
// Source paths and adapter errors must not introduce terminal control sequences.
function plain(value: string) {
	// eslint-disable-next-line no-control-regex
	return value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}
export function sync_summary(
	result: Result,
	verbose = false,
): string {
	const heading =
		result.status === 'error'
			? 'Sync failed.'
			: result.status === 'empty'
				? 'Nothing to sync.'
				: result.status === 'partial'
					? 'Sync completed with issues.'
					: 'Sync complete.';
	const metrics: [string, number][] = [
		['Sources', result.sources_selected ?? 0],
		['Files scanned', result.files_scanned],
		['Files processed', result.files_indexed - result.files_skipped],
		['Files unchanged', result.files_skipped],
		['Revisions added', result.revisions_added],
	];
	if (result.partial_files)
		metrics.push(['Incomplete files', result.partial_files]);
	if (result.failures) metrics.push(['Issues', result.failures]);
	const lines = [
		heading,
		'',
		...metrics.map(
			([label, value]) => `  ${label.padEnd(20)}${value}`,
		),
	];
	if (result.message) lines.push('', plain(result.message));
	if (result.issue_counts.length) {
		const labels: Record<string, string> = {
			unsupported: 'unsupported format',
			legacy: 'legacy format',
			invalid: 'invalid data',
			conflict: 'conflicting copies',
			missing: 'missing source',
			blocked: 'access denied',
			changed: 'changed during sync',
			partial: 'incomplete input',
			error: 'import error',
		};
		lines.push('', 'Needs attention:');
		for (const group of result.issue_counts)
			lines.push(
				`  ${plain(group.agent)}: ${group.count} ${plain(labels[group.code] ?? group.code)}`,
			);
	}
	if (result.partial_files)
		lines.push(
			'',
			'Incomplete files will be checked again on the next sync.',
		);
	if (result.failures) {
		if (verbose) {
			lines.push('', 'Issue details:');
			for (const issue of result.issues)
				lines.push(
					`  ${plain(issue.path)}\n    ${plain(issue.code)}: ${plain(issue.message)}`,
				);
			if (result.issues_truncated)
				lines.push(
					`  Showing ${result.issues.length} of ${result.failures} issues.`,
				);
		} else
			lines.push(
				'',
				'Use --verbose for issue details or --json for structured output.',
			);
	}
	return lines.join('\n');
}
