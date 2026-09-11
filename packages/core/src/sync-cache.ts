import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import * as v from 'valibot';
import type { ImportResult } from './types.ts';
import { count_schema, identity_schema } from './validation.ts';

const cache_schema = v.object({
	sessions: v.array(
		v.object({
			key: identity_schema,
			hash: identity_schema,
			native_id: identity_schema,
			session_id: v.string(),
			revision_id: identity_schema,
			unindexed_records: count_schema,
		}),
	),
	inputs: v.array(
		v.object({
			path: v.string(),
			hash: identity_schema,
			byte_offset: count_schema,
			partial: v.boolean(),
		}),
	),
});
export type SyncCache = v.InferOutput<typeof cache_schema>;
export function parse_cache(data: string): SyncCache | undefined {
	try {
		const result = v.safeParse(cache_schema, JSON.parse(data));
		return result.success ? result.output : undefined;
	} catch {
		return undefined;
	}
}

/** Disk-backed staging bounds memory without parsing the source twice. */
export class ImportStage {
	#root: string | undefined;
	#next = 0;
	async put(batch: ImportResult): Promise<string> {
		this.#root ??= await mkdtemp(join(tmpdir(), 'omnirecall-stage-'));
		const path = join(this.#root, String(this.#next++));
		await writeFile(path, serialize(batch), { mode: 0o600 });
		return path;
	}
	async take(path: string): Promise<ImportResult> {
		// Only our validated output is written to this private temporary directory.
		const batch = deserialize(await readFile(path)) as ImportResult;
		await rm(path);
		return batch;
	}
	async close() {
		if (this.#root)
			await rm(this.#root, { recursive: true, force: true });
	}
}
