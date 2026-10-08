import { homedir } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import type { Archive } from '../../../packages/core/src/database.ts';
import { source_config } from '../../../packages/core/src/files.ts';
import type { Source } from '../../../packages/core/src/types.ts';
import { agents, present } from './agents.ts';

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
	const candidates: Source[] = [];
	for (const { agent, default_root } of agents) {
		const root = await default_root(home);
		if (root) candidates.push(source_config(agent, root));
	}
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
