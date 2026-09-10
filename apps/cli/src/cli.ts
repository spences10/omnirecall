import { defineCommand as define_command } from 'citty';
import { readFileSync as read_file_sync } from 'node:fs';

const package_metadata = JSON.parse(
	read_file_sync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

const info = define_command({
	meta: {
		name: 'info',
		description: 'Show package information and implementation status',
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
			status: 'scaffold',
			capabilities: [],
		};

		if (args.json) {
			console.log(JSON.stringify(result));
			return;
		}

		console.log(`${result.name} v${result.version}`);
		console.log(
			'Early scaffold. Transcript indexing and search are not implemented yet.',
		);
	},
});

export const main = define_command({
	meta: {
		name: package_metadata.name,
		version: package_metadata.version,
		description: 'Recall coding-agent conversations (early scaffold)',
	},
	subCommands: { info },
});
