import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
	InputError,
	object,
	type Agent,
	type RecordLine,
	type Source,
} from './types.ts';

export const max_file_bytes = 64 * 1024 * 1024;
export const parser_version = 2;

export function digest(value: string | Buffer): string {
	return createHash('sha256').update(value).digest('hex');
}

export function source_config(agent: Agent, root: string): Source {
	const absolute_root = resolve(root);
	return {
		agent,
		root: absolute_root,
		source_id: `${agent}:${digest(absolute_root).slice(0, 24)}`,
	};
}

export async function discover_jsonl(
	root: string,
): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isSymbolicLink())
			throw new InputError(
				'unsupported',
				'Symlinks in source trees are not supported',
			);
		if (entry.isDirectory())
			files.push(...(await discover_jsonl(path)));
		else if (entry.isFile() && entry.name.endsWith('.jsonl'))
			files.push(path);
	}
	return files.sort();
}

// Read a bounded snapshot without decoding an unfinished UTF-8 record.
export async function read_snapshot(
	path: string,
	previous?: import('./types.ts').ResumeInput,
) {
	const handle = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size > max_file_bytes)
			throw new InputError(
				'unsupported',
				'Expected a regular file of at most 64 MiB',
			);
		let start_offset = 0;
		let hash = createHash('sha256');
		async function read_into(buffer: Buffer, position: number) {
			let offset = 0;
			while (offset < buffer.length) {
				const { bytesRead } = await handle.read(
					buffer,
					offset,
					buffer.length - offset,
					position + offset,
				);
				if (!bytesRead)
					throw new InputError(
						'changed',
						'Source truncated during read; retry sync',
					);
				offset += bytesRead;
			}
		}
		// Hash the imported prefix in bounded chunks, without decoding it again.
		if (previous && previous.input.byte_offset <= before.size) {
			const chunk = Buffer.alloc(
				Math.min(previous.input.byte_offset, 1024 * 1024),
			);
			let position = 0;
			while (position < previous.input.byte_offset) {
				const part = chunk.subarray(
					0,
					Math.min(
						chunk.length,
						previous.input.byte_offset - position,
					),
				);
				await read_into(part, position);
				hash.update(part);
				position += part.length;
			}
			if (hash.copy().digest('hex') === previous.input.hash)
				start_offset = previous.input.byte_offset;
			else hash = createHash('sha256');
		}
		const append = start_offset > 0;
		const buffer = Buffer.alloc(before.size - start_offset);
		await read_into(buffer, start_offset);

		const after = await stat(path);
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw new InputError(
				'changed',
				'Source changed during read; retry sync',
			);
		const complete_length = buffer.lastIndexOf(10) + 1;
		const byte_offset = start_offset + complete_length;
		const complete = buffer.subarray(0, complete_length);
		hash.update(complete);

		const records: RecordLine[] = append ? previous!.records() : [];
		const decoder = new TextDecoder('utf-8', { fatal: true });
		let start = 0;
		while (start < complete.length) {
			const end = complete.indexOf(10, start);
			try {
				const line = decoder.decode(complete.subarray(start, end));
				if (line.trim())
					records.push({
						value: object(JSON.parse(line)),
						raw_json: line,
						byte_offset: start_offset + start,
					});
			} catch {
				throw new InputError(
					'invalid',
					`Invalid complete JSON/UTF-8 record at byte ${start_offset + start}`,
				);
			}
			start = end + 1;
		}
		if (!records.length)
			throw new InputError('partial', 'No complete header yet');
		return {
			records,
			append,
			byte_offset,
			partial: byte_offset < before.size,
			hash: hash.digest('hex'),
		};
	} finally {
		await handle.close();
	}
}

// Format helpers are optional adapter machinery, not the core import contract.
export function jsonl_adapter(
	agent: string,
	parse: import('./types.ts').JsonlAdapter['parse'],
	discover = discover_jsonl,
): import('./types.ts').JsonlAdapter {
	const read: import('./types.ts').JsonlAdapter['read'] =
		async function (
			this: import('./types.ts').JsonlAdapter,
			unit,
			previous,
		) {
			if (unit.locators.length !== 1)
				throw new InputError(
					'invalid',
					'JSONL unit requires one input',
				);
			const path = unit.locators[0]!;
			const snapshot = await read_snapshot(path, previous);
			return {
				sessions: [this.parse(snapshot.records, path)],
				append: snapshot.append,
				inputs: [
					{
						path,
						hash: snapshot.hash,
						byte_offset: snapshot.byte_offset,
						partial: snapshot.partial,
					},
				],
			};
		};
	return {
		agent,
		parse,
		parser_version,
		read,
		async fingerprint(unit) {
			// A wrapper that changes parsing/reading must explicitly provide its own cache contract.
			if (this.read !== read || this.parse !== parse)
				return undefined;
			if (unit.locators.length !== 1) return undefined;
			const info = await lstat(unit.locators[0]!, { bigint: true });
			if (!info.isFile() || info.size > BigInt(max_file_bytes))
				throw new InputError(
					'unsupported',
					'Expected a regular file of at most 64 MiB',
				);
			return [
				info.dev,
				info.ino,
				info.size,
				info.mtimeNs,
				info.ctimeNs,
				info.mode,
			].join(':');
		},
		async discover(root) {
			return (await discover(root)).map((path) => ({
				key: path,
				locators: [path],
			}));
		},
	};
}
