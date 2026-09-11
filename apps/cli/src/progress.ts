import type { SyncProgress } from '../../../packages/core/src/sync.ts';

/** Progress goes to stderr so stdout remains a single result document. */
export function sync_progress(enabled: boolean) {
	const started = Date.now();
	let current = 'Starting sync…';
	let last_phase = '';
	let last_write = 0;
	let closed = false;
	const render = () => {
		if (!enabled || closed) return;
		const line = `${current} (${Math.floor((Date.now() - started) / 1000)}s)`;
		process.stderr.write(
			process.stderr.isTTY ? `\r\x1b[2K${line}` : `${line}\n`,
		);
		last_write = Date.now();
	};
	render();
	const timer = enabled ? setInterval(render, 1000) : undefined;
	timer?.unref();
	return {
		update(this: void, progress: SyncProgress) {
			const {
				phase,
				agent,
				source_index,
				source_count,
				completed,
				total,
				files_indexed,
				failures,
			} = progress;
			const label = {
				discovering: 'Discovering',
				checking: 'Checking',
				importing: 'Importing',
				source_done: 'Finished',
			}[phase];
			const safe_agent = agent
				// Strip terminal control characters from adapter names.
				// eslint-disable-next-line no-control-regex
				.replace(/[\x00-\x1f\x7f-\x9f]/g, '')
				.slice(0, 40);
			current = `${label} ${safe_agent} [${source_index}/${source_count}]${phase === 'discovering' ? '' : `: ${completed}/${total} items`} — ${files_indexed} files indexed, ${failures} failures`;
			const phase_key = `${source_index}:${phase}`;
			if (
				phase_key !== last_phase ||
				Date.now() - last_write >=
					(process.stderr.isTTY ? 100 : 1000) ||
				completed === total
			)
				render();
			last_phase = phase_key;
		},
		finish() {
			if (closed) return;
			if (timer) clearInterval(timer);
			if (enabled && process.stderr.isTTY) process.stderr.write('\n');
			closed = true;
		},
	};
}
