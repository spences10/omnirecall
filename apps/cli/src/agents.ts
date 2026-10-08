import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { claude_adapter } from '../../../packages/adapter-claude/src/index.ts';
import { codex_adapter } from '../../../packages/adapter-codex/src/index.ts';
import { opencode_adapter } from '../../../packages/adapter-opencode/src/index.ts';
import { pi_adapter } from '../../../packages/adapter-pi/src/index.ts';
import type { Adapter } from '../../../packages/core/src/types.ts';

export async function present(
	path: string,
	file = false,
): Promise<boolean> {
	try {
		const info = await stat(path);
		return file ? info.isFile() : info.isDirectory();
	} catch (error) {
		// Let sync report inaccessible locations rather than calling them absent.
		return !['ENOENT', 'ENOTDIR'].includes(
			(error as NodeJS.ErrnoException).code ?? '',
		);
	}
}

interface AgentSupport {
	agent: string;
	adapter: Adapter;
	root_flag: string;
	root_help: string;
	/** Where this agent keeps its history by default, if it looks present. */
	default_root: (home: string) => Promise<string | undefined>;
}

// The one list of supported agents. Explicit roots, automatic discovery and
// help text all follow this order.
export const agents: AgentSupport[] = [
	{
		agent: 'pi',
		adapter: pi_adapter,
		root_flag: 'pi-root',
		root_help: 'Explicit Pi session tree root',
		default_root: async (home) =>
			join(home, '.pi', 'agent', 'sessions'),
	},
	{
		agent: 'codex',
		adapter: codex_adapter,
		root_flag: 'codex-root',
		root_help: 'Explicit Codex JSONL tree root',
		async default_root(home) {
			const root = process.env.CODEX_HOME || join(home, '.codex');
			return (await present(join(root, 'sessions'))) ||
				(await present(join(root, 'archived_sessions')))
				? root
				: undefined;
		},
	},
	{
		agent: 'claude',
		adapter: claude_adapter,
		root_flag: 'claude-root',
		root_help: 'Explicit Claude transcript tree root',
		default_root: async (home) => join(home, '.claude', 'projects'),
	},
	{
		agent: 'opencode',
		adapter: opencode_adapter,
		root_flag: 'opencode-root',
		root_help: 'OpenCode data directory containing a v2 opencode.db',
		async default_root(home) {
			const root = join(
				process.env.XDG_DATA_HOME || join(home, '.local', 'share'),
				'opencode',
			);
			return (await present(join(root, 'opencode.db'), true))
				? root
				: undefined;
		},
	},
];

const names = agents.map(({ agent }) => agent);
/** "pi, codex, claude, or opencode" */
export const agent_list = `${names.slice(0, -1).join(', ')}, or ${names.at(-1)}`;
