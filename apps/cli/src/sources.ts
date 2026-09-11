import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import type { Archive } from '../../../packages/core/src/database.ts';
import { source_config } from '../../../packages/core/src/files.ts';
import type { Source } from '../../../packages/core/src/types.ts';

async function present(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		// Let sync report inaccessible locations rather than calling them absent.
		return !['ENOENT', 'ENOTDIR'].includes(
			(error as NodeJS.ErrnoException).code ?? '',
		);
	}
}
function contains(parent: string, child: string) {
	const path = relative(parent, child);
	return (
		!path ||
		(!isAbsolute(path) &&
			path !== '..' &&
			!path.startsWith('../') &&
			!path.startsWith('..\\'))
	);
}
export async function automatic_sources(
	archive: Archive,
): Promise<Source[]> {
	const configured: Source[] = [];
	for (let offset = 0; ;) {
		const page = archive.sources({ limit: 100, offset });
		configured.push(
			...page.slice(0, 100).map(({ source_id, agent, root }) => ({
				source_id,
				agent,
				root,
			})),
		);
		if (page.length <= 100) break;
		offset += 100;
	}
	const home = homedir();
	const codex = process.env.CODEX_HOME || join(home, '.codex');
	const candidates = [
		source_config('pi', join(home, '.pi', 'agent', 'sessions')),
		source_config('claude', join(home, '.claude', 'projects')),
	];
	if (
		(await present(join(codex, 'sessions'))) ||
		(await present(join(codex, 'archived_sessions')))
	)
		candidates.push(source_config('codex', codex));
	for (const candidate of candidates) {
		if (
			configured.some(
				(s) =>
					s.agent === candidate.agent &&
					(contains(s.root, candidate.root) ||
						contains(candidate.root, s.root)),
			)
		)
			continue;
		if (await present(candidate.root)) configured.push(candidate);
	}
	return configured;
}
