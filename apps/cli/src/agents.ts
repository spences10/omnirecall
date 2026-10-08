import { claude_adapter } from '../../../packages/adapter-claude/src/index.ts';
import { codex_adapter } from '../../../packages/adapter-codex/src/index.ts';
import { opencode_adapter } from '../../../packages/adapter-opencode/src/index.ts';
import { pi_adapter } from '../../../packages/adapter-pi/src/index.ts';
import type { Adapter } from '../../../packages/core/src/types.ts';

// Explicit roots are listed and synced in this order.
export const agents: {
	agent: string;
	root_flag: string;
	adapter: Adapter;
}[] = [
	{
		agent: 'claude',
		root_flag: 'claude-root',
		adapter: claude_adapter,
	},
	{ agent: 'pi', root_flag: 'pi-root', adapter: pi_adapter },
	{ agent: 'codex', root_flag: 'codex-root', adapter: codex_adapter },
	{
		agent: 'opencode',
		root_flag: 'opencode-root',
		adapter: opencode_adapter,
	},
];
