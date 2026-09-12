import * as v from 'valibot';
import { InputError, object } from '../../core/src/types.ts';
import {
	identity_schema,
	metadata_schema,
	timestamp_schema,
	validate,
} from '../../core/src/validation.ts';

const envelope = { timestamp: timestamp_schema };
const block = v.pipe(
	// Pi classifies missing or unknown block types as unsupported in dialogue().
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
const codex_text_block = v.looseObject({
	type: v.picklist(['text', 'Text']),
	text: v.string(),
});
const codex_attachment_types = [
	'image',
	'local_image',
	'audio',
	'local_audio',
	'skill',
	'mention',
] as const;
const codex_user_block = v.variant('type', [
	codex_text_block,
	v.looseObject({ type: v.picklist(codex_attachment_types) }),
]);
export const codex_item_schema = v.variant('type', [
	v.looseObject({
		id: identity_schema,
		type: v.literal('UserMessage'),
		content: v.union([v.string(), v.array(codex_user_block)]),
	}),
	v.looseObject({
		id: identity_schema,
		type: v.literal('AgentMessage'),
		content: v.union([v.string(), v.array(codex_text_block)]),
	}),
]);
export function codex_dialogue(
	item: Record<string, unknown>,
	byte_offset: number,
): string {
	if (Array.isArray(item.content))
		for (const [index, value] of item.content.entries()) {
			const block = object(value);
			if (
				typeof block.type === 'string' &&
				![
					'text',
					'Text',
					...(item.type === 'UserMessage'
						? codex_attachment_types
						: []),
				].includes(block.type)
			)
				throw new InputError(
					'unsupported',
					`Codex record at byte ${byte_offset}: Unknown dialogue content block type at content.${index}.type`,
				);
		}
	const parsed = validate_source(
		codex_item_schema,
		item,
		'Codex completed item',
		byte_offset,
	);
	return typeof parsed.content === 'string'
		? parsed.content
		: parsed.content
				.filter(
					(block) => block.type === 'text' || block.type === 'Text',
				)
				.map((block) => block.text)
				.join('\n');
}
const realtime_common = {
	id: identity_schema,
	realtime_session_id: identity_schema,
};
export const codex_realtime_schema = v.variant('type', [
	v.looseObject({
		...realtime_common,
		type: v.literal('realtime_session_started'),
	}),
	v.looseObject({
		...realtime_common,
		type: v.literal('transcript_segment'),
		role: v.picklist(['user', 'assistant']),
		text: v.string(),
	}),
	v.looseObject({
		...realtime_common,
		type: v.literal('realtime_session_closed'),
		outcome: identity_schema,
	}),
]);
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
