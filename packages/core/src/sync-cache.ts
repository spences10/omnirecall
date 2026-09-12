import * as v from 'valibot';
import { count_schema, identity_schema } from './validation.ts';

const cache_schema = v.object({
	parser_version: count_schema,
	sessions: v.array(
		v.object({
			key: identity_schema,
			hash: identity_schema,
			native_id: identity_schema,
			session_id: v.string(),
			archive_id: identity_schema,
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
