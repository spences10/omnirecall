import {
	mkdtempSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
	discover_jsonl,
	max_file_bytes,
	read_snapshot,
} from './files.ts';
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'omnirecall-files-'));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

test('rejects invalid complete UTF-8, ignores unfinished UTF-8 until newline', async () => {
	const path = join(root, 'test.jsonl');
	writeFileSync(
		path,
		Buffer.concat([
			Buffer.from('{"type":"test"}\n'),
			Buffer.from([0xc3]),
		]),
	);
	expect(await read_snapshot(path)).toMatchObject({
		byte_offset: 16,
		partial: true,
	});
	writeFileSync(path, Buffer.from([0xc3, 10]));
	await expect(read_snapshot(path)).rejects.toMatchObject({
		code: 'invalid',
	});
});

test('reports incomplete headers and oversized files explicitly', async () => {
	const path = join(root, 'test.jsonl');
	writeFileSync(path, '{"type":');
	await expect(read_snapshot(path)).rejects.toMatchObject({
		code: 'partial',
	});
	truncateSync(path, max_file_bytes + 1);
	await expect(read_snapshot(path)).rejects.toMatchObject({
		code: 'unsupported',
	});
});

test('does not follow source symlinks', async () => {
	writeFileSync(join(root, 'target.jsonl'), '{}\n');
	symlinkSync(join(root, 'target.jsonl'), join(root, 'link.jsonl'));
	await expect(discover_jsonl(root)).rejects.toMatchObject({
		code: 'unsupported',
	});
	await expect(
		read_snapshot(join(root, 'link.jsonl')),
	).rejects.toMatchObject({ code: 'ELOOP' });
});
