import * as v from 'valibot';
import {
	identity_schema,
	metadata_schema,
	timestamp_schema,
	validate,
} from '../../core/src/validation.ts';

const envelope = { timestamp: timestamp_schema };
const block = v.pipe(
	// Pi/Codex classify missing or unknown block types as unsupported in dialogue().
	v.looseObject({ type: v.optional(v.unknown()) }),
	v.check(
		(value) =>
			value.type !== 'text' || typeof value.text === 'string',
		'Invalid text block',
	),
);
const content = v.union([v.string(), v.array(block)]);

export const pi_header_schema = v.looseObject({
	...envelope,
	id: identity_schema,
	cwd: identity_schema,
	parentSession: v.optional(metadata_schema),
});
export const pi_entry_schema = v.looseObject({
	...envelope,
	type: identity_schema,
	id: identity_schema,
	parentId: v.nullable(identity_schema),
});
export const pi_message_schema = v.looseObject({
	role: identity_schema,
	content,
});
export const codex_header_schema = v.looseObject({
	...envelope,
	payload: v.looseObject({
		id: identity_schema,
		cwd: identity_schema,
		thread_name: v.optional(metadata_schema),
		forked_from_id: v.optional(metadata_schema),
	}),
});
export const codex_entry_schema = v.looseObject({
	...envelope,
	type: identity_schema,
	payload: v.looseObject({}),
});
export const codex_item_schema = v.looseObject({
	id: identity_schema,
	type: identity_schema,
	content,
});
export const codex_title_schema = v.looseObject({
	id: identity_schema,
	updated_at: timestamp_schema,
	thread_name: v.pipe(v.string(), v.maxLength(4096)),
});
export const claude_message_schema = v.looseObject({
	uuid: identity_schema,
	sessionId: v.optional(identity_schema),
	cwd: v.optional(v.string()),
	parentUuid: v.optional(v.nullable(identity_schema)),
	timestamp: v.optional(timestamp_schema),
	message: v.looseObject({
		content: v.union([
			v.string(),
			v.array(
				v.intersect([
					block,
					v.looseObject({ type: identity_schema }),
				]),
			),
		]),
	}),
});

export function validate_source<S extends v.GenericSchema>(
	schema: S,
	value: unknown,
	agent: string,
	byte_offset: number,
): v.InferOutput<S> {
	return validate(
		schema,
		value,
		`${agent} record at byte ${byte_offset}`,
	);
}
