import * as v from 'valibot';
import { InputError, type ImportResult } from './types.ts';

export const identity_schema = v.pipe(
	v.string(),
	v.maxLength(4096),
	v.check(
		(value) => Boolean(value.trim()),
		'Expected a nonempty string',
	),
);
export const timestamp_schema = v.pipe(
	identity_schema,
	v.check(
		(value) => Number.isFinite(Date.parse(value)),
		'Invalid timestamp',
	),
);
export const count_schema = v.pipe(
	v.number(),
	v.safeInteger(),
	v.minValue(0),
);
export const metadata_schema = v.nullable(
	v.pipe(v.string(), v.maxLength(4096)),
);

// Report field locations without including private transcript values.
export function validate<S extends v.GenericSchema>(
	schema: S,
	value: unknown,
	context: string,
): v.InferOutput<S> {
	const result = v.safeParse(schema, value, { abortEarly: true });
	if (!result.success) {
		const issue = result.issues[0];
		const path =
			issue.path?.map((entry) => String(entry.key)).join('.') ||
			'<root>';
		throw new InputError(
			'invalid',
			`${context}: invalid field ${path}`,
		);
	}
	return result.output;
}

const message_schema = v.looseObject({
	native_id: identity_schema,
	parent_id: v.nullable(identity_schema),
	role: identity_schema,
	kind: v.optional(identity_schema),
	record_key: v.optional(identity_schema),
	json_pointer: v.optional(v.string()),
	representation: v.optional(identity_schema),
	state: v.optional(identity_schema),
	content: v.string(),
	timestamp: v.nullable(timestamp_schema),
	source_order: count_schema,
	active: v.boolean(),
	turn_id: v.nullable(identity_schema),
});
const record_schema = v.looseObject({
	input_path: v.optional(identity_schema),
	key: identity_schema,
	native_id: v.nullable(v.string()),
	native_type: v.nullable(v.string()),
	timestamp: v.nullable(timestamp_schema),
	source_order: count_schema,
	raw_json: v.string(),
});
const transcript_schema = v.looseObject({
	native_id: identity_schema,
	session_key: v.optional(identity_schema),
	project: v.string(),
	title: metadata_schema,
	parent_session: metadata_schema,
	timestamp: timestamp_schema,
	messages: v.array(message_schema),
	unindexed_records: count_schema,
	inactive_turns: v.optional(v.array(identity_schema)),
	records: v.optional(v.array(record_schema)),
	parts: v.optional(v.array(message_schema)),
	links: v.optional(
		v.array(
			v.looseObject({
				record_key: identity_schema,
				kind: identity_schema,
				namespace: identity_schema,
				target: v.string(),
			}),
		),
	),
});
export const import_schema = v.looseObject({
	sessions: v.array(transcript_schema),
	inputs: v.array(
		v.looseObject({
			path: identity_schema,
			hash: identity_schema,
			byte_offset: count_schema,
			partial: v.boolean(),
		}),
	),
}) satisfies v.GenericSchema<unknown, ImportResult>;
