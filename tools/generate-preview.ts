import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { preview_session } from './fixtures/preview-session.ts';

const root = resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'omnirecall-preview-'));
const output = join(root, 'assets', 'omnirecall-package-preview.png');

function cli(args: string[]) {
	const result = spawnSync(
		process.execPath,
		[
			join(root, 'apps/cli/dist/index.js'),
			...args,
			'--db',
			join(scratch, 'archive.sqlite'),
			'--json',
		],
		{
			cwd: scratch,
			encoding: 'utf8',
			timeout: 15_000,
			env: {
				...process.env,
				HOME: scratch,
				USERPROFILE: scratch,
				CODEX_HOME: join(scratch, '.codex'),
				XDG_DATA_HOME: join(scratch, '.local/share'),
			},
		},
	);
	assert.equal(
		result.status,
		0,
		result.error?.message ?? result.stderr + result.stdout,
	);
	return JSON.parse(result.stdout);
}

function escape_xml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

function wrap(text: string, columns: number): string[] {
	const lines: string[] = [];
	for (const word of text.split(/\s+/)) {
		const previous = lines.at(-1);
		if (previous && previous.length + word.length + 1 <= columns)
			lines[lines.length - 1] += ` ${word}`;
		else lines.push(word);
	}
	return lines;
}

function text(
	x: number,
	y: number,
	content: string,
	size = 26,
	fill = '#e4efec',
	extra = '',
): string {
	return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${escape_xml(content)}</text>`;
}

try {
	const source = join(scratch, 'sessions');
	mkdirSync(source);
	writeFileSync(
		join(source, 'example.jsonl'),
		preview_session
			.map((record) => JSON.stringify(record))
			.join('\n') + '\n',
	);
	assert.equal(
		cli(['sync', '--pi-root', source]).sessions_updated,
		1,
	);
	const results = cli(['search', 'indexed lookup', '--agent', 'pi'])
		.results as { ref: string; agent: string; title: string }[];
	assert.equal(results.length, 1);
	const hit = results[0]!;
	const read = cli(['read', hit.ref, '--context', '0']);
	const evidence = (
		read.messages as {
			ref: string;
			content: string;
			content_truncated: boolean;
		}[]
	).find((message) => message.ref === hit.ref);
	assert.ok(evidence && !evidence.content_truncated);
	const lines = wrap(evidence.content, 72);
	assert.ok(lines.length <= 3, 'Evidence must fit the preview');
	assert.equal(hit.agent, 'pi');

	// The conversation frame is illustrative. The evidence card is read from
	// the actual CLI's synthetic archive; no model call or live history is used.
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900" viewBox="0 0 1440 900">
<defs>
 <radialGradient id="glow" cx="0.08" cy="0" r="1"><stop stop-color="#143d36"/><stop offset="1" stop-color="#091310"/></radialGradient>
</defs>
<rect width="1440" height="900" rx="24" fill="url(#glow)"/>
<g font-family="DejaVu Sans Mono, monospace">
${text(64, 88, '> omnirecall', 43, '#91efd0', 'font-weight="700"')}
${text(64, 134, 'Past sessions. Present context.', 23, '#a6bdb4')}
${text(1376, 87, 'PI / CODEX / CLAUDE CODE', 17, '#a6bdb4', 'text-anchor="end"')}
<rect x="48" y="182" width="1344" height="644" rx="18" fill="#0c1714" stroke="#345047"/>
<path d="M48 240H1392" stroke="#263e35"/>
<circle cx="80" cy="211" r="6" fill="#648a7b"/><circle cx="104" cy="211" r="6" fill="#648a7b"/><circle cx="128" cy="211" r="6" fill="#648a7b"/>
${text(720, 217, 'your coding assistant', 17, '#8da99d', 'text-anchor="middle"')}
${text(88, 289, 'YOU', 16, '#91efd0', 'font-weight="700" letter-spacing="2"')}
${text(88, 335, 'Use npx omnirecall to find the session where we', 29)}
${text(88, 378, 'fixed slow search. What changed?', 29)}
<path d="M88 415H1352" stroke="#263e35"/>
${text(88, 455, 'ASSISTANT', 16, '#91efd0', 'font-weight="700" letter-spacing="2"')}
${text(88, 501, 'Found it — the fix was in the source-path lookup.', 27)}
<rect x="88" y="533" width="1264" height="203" rx="10" fill="#14251e" stroke="#365845"/>
<rect x="88" y="547" width="3" height="175" rx="1" fill="#a9dca5"/>
${text(115, 572, `PI  /  ${hit.title}`, 19, '#b8dcab', 'font-weight="700"')}
${lines.map((line, index) => text(115, 620 + index * 36, line, 25, '#e2eadd')).join('\n')}
${text(88, 784, 'Same conversation. Context recovered from an earlier session.', 20, '#a6bdb4')}
${text(1376, 868, 'Illustrative conversation · synthetic session evidence', 15, '#8da99d', 'text-anchor="end"')}
</g>
</svg>`;
	mkdirSync(join(root, 'assets'), { recursive: true });
	writeFileSync(output, new Resvg(svg).render().asPng());
	console.log(
		`Generated ${output} from a verified synthetic CLI result.`,
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
