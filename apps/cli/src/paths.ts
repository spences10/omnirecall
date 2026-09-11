import { homedir, platform } from 'node:os';
import { posix, win32 } from 'node:path';

export function database_path(override?: string): string {
	const os = platform();
	const paths = os === 'win32' ? win32 : posix;
	const configured = override ?? process.env.OMNIRECALL_DB;
	if (configured !== undefined) return paths.resolve(configured);

	const home = homedir();
	let directory: string;
	if (os === 'darwin') {
		directory = paths.join(
			home,
			'Library',
			'Application Support',
			'omnirecall',
		);
	} else if (os === 'win32') {
		const local_data = process.env.LOCALAPPDATA;
		const root =
			local_data && paths.isAbsolute(local_data)
				? local_data
				: paths.join(home, 'AppData', 'Local');
		directory = paths.join(root, 'omnirecall', 'Data');
	} else {
		const xdg_data = process.env.XDG_DATA_HOME;
		const root =
			xdg_data && paths.isAbsolute(xdg_data)
				? xdg_data
				: paths.join(home, '.local', 'share');
		directory = paths.join(root, 'omnirecall');
	}
	return paths.join(directory, 'omnirecall.db');
}
