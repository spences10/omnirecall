import { afterEach, expect, test, vi } from 'vitest';
import { sync_progress } from './progress.ts';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test('reports immediately, refreshes while waiting, and stops when finished', () => {
	vi.useFakeTimers();
	const write = vi
		.spyOn(process.stderr, 'write')
		.mockReturnValue(true);
	const progress = sync_progress(true);
	expect(write).toHaveBeenCalledWith(
		expect.stringContaining('Starting sync'),
	);
	progress.update({
		phase: 'checking',
		agent: 'pi',
		source_index: 1,
		source_count: 2,
		completed: 3,
		total: 10,
		files_indexed: 0,
		failures: 1,
	});
	expect(write).toHaveBeenCalledWith(
		expect.stringContaining('Checking pi [1/2]: 3/10 items'),
	);
	vi.advanceTimersByTime(2000);
	expect(write).toHaveBeenLastCalledWith(
		expect.stringContaining('(2s)'),
	);
	progress.finish();
	const calls = write.mock.calls.length;
	vi.advanceTimersByTime(5000);
	expect(write).toHaveBeenCalledTimes(calls);
});

test('JSON mode creates no progress output or timer', () => {
	vi.useFakeTimers();
	const write = vi
		.spyOn(process.stderr, 'write')
		.mockReturnValue(true);
	const progress = sync_progress(false);
	progress.update({
		phase: 'discovering',
		agent: 'pi',
		source_index: 1,
		source_count: 1,
		completed: 0,
		total: 0,
		files_indexed: 0,
		failures: 0,
	});
	vi.advanceTimersByTime(2000);
	progress.finish();
	expect(write).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});
