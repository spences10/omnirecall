#!/usr/bin/env node
if (!process.stdout.isTTY) {
	process.env.NO_COLOR = '1';
}

const { runMain } = await import('citty');
const { main } = await import('./cli.ts');

const raw_args = process.argv.slice(2);
await runMain(main, {
	rawArgs: raw_args.length > 0 ? raw_args : ['--help'],
});

export {};
