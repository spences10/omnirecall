import envPaths from 'env-paths';
import { join, resolve } from 'node:path';

export function database_path(override?: string): string {
	return resolve(
		override ??
			process.env.OMNIRECALL_DB ??
			join(
				envPaths('omnirecall', { suffix: '' }).data,
				'omnirecall.db',
			),
	);
}
