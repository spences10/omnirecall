import { homedir, platform } from 'node:os';
import { posix } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { database_path } from './paths.ts';

vi.mock('node:os', () => ({ homedir: vi.fn(), platform: vi.fn() }));

beforeEach(() => {
	vi.stubEnv('OMNIRECALL_DB', undefined);
	vi.stubEnv('XDG_DATA_HOME', undefined);
	vi.stubEnv('LOCALAPPDATA', undefined);
	vi.mocked(homedir).mockReturnValue('/home/tester');
	vi.mocked(platform).mockReturnValue('linux');
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

test('uses the persistent Linux data directory by default', () => {
	vi.stubEnv('TMPDIR', '/tmp/not-an-archive');
	expect(database_path()).toBe(
		'/home/tester/.local/share/omnirecall/omnirecall.db',
	);
});

test('honors an absolute XDG data directory', () => {
	vi.stubEnv('XDG_DATA_HOME', '/mnt/data');
	expect(database_path()).toBe('/mnt/data/omnirecall/omnirecall.db');
});

test.each(['', 'relative/data'])(
	'ignores invalid XDG_DATA_HOME %j',
	(value) => {
		vi.stubEnv('XDG_DATA_HOME', value);
		expect(database_path()).toBe(
			'/home/tester/.local/share/omnirecall/omnirecall.db',
		);
	},
);

test('uses Application Support on macOS', () => {
	vi.mocked(platform).mockReturnValue('darwin');
	vi.mocked(homedir).mockReturnValue('/Users/tester');
	vi.stubEnv('XDG_DATA_HOME', '/not-macos-data');
	expect(database_path()).toBe(
		'/Users/tester/Library/Application Support/omnirecall/omnirecall.db',
	);
});

test('uses LOCALAPPDATA and native separators on Windows', () => {
	vi.mocked(platform).mockReturnValue('win32');
	vi.mocked(homedir).mockReturnValue(String.raw`C:\Users\tester`);
	vi.stubEnv('LOCALAPPDATA', String.raw`D:\Local Data`);
	expect(database_path()).toBe(
		String.raw`D:\Local Data\omnirecall\Data\omnirecall.db`,
	);
});

test('supports Windows UNC data paths', () => {
	vi.mocked(platform).mockReturnValue('win32');
	vi.stubEnv('LOCALAPPDATA', String.raw`\\server\share\data`);
	expect(database_path()).toBe(
		String.raw`\\server\share\data\omnirecall\Data\omnirecall.db`,
	);
});

test.each([undefined, '', 'relative-data'])(
	'falls back to the Windows profile for LOCALAPPDATA %j',
	(value) => {
		vi.mocked(platform).mockReturnValue('win32');
		vi.mocked(homedir).mockReturnValue(String.raw`C:\Users\tester`);
		vi.stubEnv('LOCALAPPDATA', value);
		expect(database_path()).toBe(
			String.raw`C:\Users\tester\AppData\Local\omnirecall\Data\omnirecall.db`,
		);
	},
);

test('environment override takes precedence over the platform default', () => {
	vi.stubEnv('OMNIRECALL_DB', 'custom-archive/history.db');
	expect(database_path()).toBe(
		posix.resolve('custom-archive/history.db'),
	);
	expect(homedir).not.toHaveBeenCalled();
});

test('explicit path takes precedence over the environment', () => {
	vi.stubEnv('OMNIRECALL_DB', 'environment.db');
	expect(database_path('explicit.db')).toBe(
		posix.resolve('explicit.db'),
	);
	expect(homedir).not.toHaveBeenCalled();
});

test('preserves explicit Windows filenames', () => {
	vi.mocked(platform).mockReturnValue('win32');
	expect(database_path(String.raw`D:\Archives\custom.db`)).toBe(
		String.raw`D:\Archives\custom.db`,
	);
	expect(homedir).not.toHaveBeenCalled();
});
