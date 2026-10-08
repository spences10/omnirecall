import { defineCommand } from 'citty';
import { existsSync, readFileSync } from 'node:fs';
import { Archive } from '../../../packages/core/src/database.ts';
import { bounded_json } from '../../../packages/core/src/output.ts';
import { short_refs } from '../../../packages/core/src/refs.ts';
import { error_code } from '../../../packages/core/src/sync.ts';
import { command_definition } from './args.ts';
import { run_query, run_sync } from './handlers.ts';
import { database_path } from './paths.ts';
import { sync_progress } from './progress.ts';
import { integer, output_mode, parse_request } from './request.ts';
import { sync_summary } from './sync-output.ts';

const package_metadata = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };
const capabilities = [
	'sources',
	'sync',
	'search',
	'recall',
	'sessions',
	'outline',
	'evidence',
	'read',
];
const info = defineCommand({
	meta: {
		name: 'info',
		description:
			'Show package information and supported capabilities',
	},
	args: {
		json: {
			type: 'boolean',
			description: 'Output machine-readable JSON',
		},
	},
	run({ args }) {
		const result = {
			schema_version: 1,
			name: package_metadata.name,
			version: package_metadata.version,
			status: 'preview',
			capabilities,
			agent_instructions:
				'Use <command> --help for options. Unsure which session: search --by-session. Skim one: outline <short_id>. Then recall for context, evidence <ref> for what was run, read <ref> for full text.',
		};
		console.log(
			args.json
				? JSON.stringify(result)
				: `${result.name} v${result.version}\nPreview: Pi, Claude Code, Codex and OpenCode session evidence; durable local archive.\n${result.agent_instructions}`,
		);
	},
});

function command(name: string) {
	return defineCommand({
		...command_definition(name),
		async run({ args }) {
			let archive: Archive | undefined;
			let progress: ReturnType<typeof sync_progress> | undefined;
			const { compact, schema_version, ...mode } = output_mode(
				name,
				args,
			);
			let max_bytes = mode.max_bytes;
			try {
				max_bytes = integer(
					args['max-bytes'],
					max_bytes,
					1024,
					1048576,
				);
				const request = parse_request(name, args, compact);
				if (name === 'sync')
					progress = sync_progress(
						!args.json && Boolean(process.stderr.isTTY),
					);
				const db_path = database_path(args.db);
				if (name === 'sync' || existsSync(db_path))
					archive = new Archive(db_path, name !== 'sync');
				let result: Record<string, unknown>;
				if (name === 'sync') {
					const synced = await run_sync(
						archive!,
						request,
						progress?.update,
					);
					progress?.finish();
					if (!args.json) {
						console.log(sync_summary(synced, Boolean(args.verbose)));
						return;
					}
					result = synced;
				} else
					result = await run_query({
						name,
						args,
						archive,
						request,
						compact,
					});
				const output = bounded_json(
					{
						schema_version,
						...(compact && archive
							? short_refs(archive, result)
							: result),
					},
					max_bytes,
				);
				console.log(
					args.json
						? output
						: JSON.stringify(JSON.parse(output), null, 2),
				);
			} catch (error) {
				progress?.finish();
				process.exitCode = 1;
				if (name === 'sync' && !args.json) {
					console.error(
						`Sync failed: ${error instanceof Error ? error.message : 'Operation failed'}`,
					);
					return;
				}
				console.log(
					bounded_json(
						{
							schema_version,
							status: 'error',
							code: error_code(error),
							message:
								error instanceof Error
									? error.message
									: 'Operation failed',
							results: [],
						},
						max_bytes,
					),
				);
			} finally {
				progress?.finish();
				archive?.close();
			}
		},
	});
}

export const main = defineCommand({
	meta: {
		name: package_metadata.name,
		version: package_metadata.version,
		description:
			'Search archived coding sessions; use <command> --help for options.',
	},
	subCommands: {
		info,
		sources: command('sources'),
		sync: command('sync'),
		search: command('search'),
		recall: command('recall'),
		sessions: command('sessions'),
		outline: command('outline'),
		evidence: command('evidence'),
		read: command('read'),
	},
});
