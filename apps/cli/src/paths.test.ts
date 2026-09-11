import envPaths from 'env-paths';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { database_path } from './paths.ts';

vi.mock('env-paths', () => ({ default: vi.fn() }));

beforeEach(() => {
	vi.stubEnv('OMNIRECALL_DB', undefined);
	vi.mocked(envPaths).mockReturnValue({
		data: resolve('platform-data', 'omnirecall'),
		config: '',
		cache: '',
		log: '',
		temp: '',
	});
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

test('uses the platform data directory without a nodejs suffix', () => {
	expect(database_path()).toBe(
		resolve('platform-data', 'omnirecall', 'omnirecall.db'),
	);
	expect(envPaths).toHaveBeenCalledWith('omnirecall', { suffix: '' });
});

test('environment override takes precedence over the platform default', () => {
	const override = join('custom-archive', 'history.db');
	vi.stubEnv('OMNIRECALL_DB', override);
	expect(database_path()).toBe(resolve(override));
	expect(envPaths).not.toHaveBeenCalled();
});

test('explicit path takes precedence over the environment', () => {
	vi.stubEnv('OMNIRECALL_DB', 'environment.db');
	expect(database_path('explicit.db')).toBe(resolve('explicit.db'));
	expect(envPaths).not.toHaveBeenCalled();
});
