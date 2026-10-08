import * as v from 'valibot';
import {
	InputError,
	object,
	type JsonObject,
} from '../../core/src/types.ts';
import {
	count_schema,
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

// OpenCode stores rows, not byte-addressed lines; its JSON arrives as text columns.
const plain_object = v.custom<JsonObject>(
	(value) =>
		Boolean(value) &&
		typeof value === 'object' &&
		!Array.isArray(value),
);
const epoch_schema = v.pipe(
	count_schema,
	v.check(
		(value) => Number.isFinite(new Date(value).getTime()),
		'Invalid timestamp',
	),
);
const json_column = v.pipe(v.string(), v.parseJson(), plain_object);
export const opencode_session_schema = v.looseObject({
	id: identity_schema,
	version: identity_schema,
	directory: v.string(),
	title: v.optional(metadata_schema),
	parent_id: v.optional(metadata_schema),
	fork_session_id: v.optional(metadata_schema),
	time_created: epoch_schema,
	time_updated: epoch_schema,
	fork_boundary: v.nullish(json_column),
	revert: v.nullish(json_column),
});
export const opencode_row_schema = v.looseObject({
	id: identity_schema,
	type: identity_schema,
	seq: count_schema,
	time_created: epoch_schema,
	time_updated: epoch_schema,
	data: json_column,
});
const opencode_time = v.looseObject({
	created: epoch_schema,
	completed: v.optional(epoch_schema),
});
export const opencode_user_schema = v.looseObject({
	time: opencode_time,
	text: v.string(),
});
export const opencode_assistant_schema = v.looseObject({
	time: opencode_time,
	content: v.array(plain_object),
});
/** A block of a type this adapter does not interpret. */
export const opencode_block_schema = v.looseObject({
	type: identity_schema,
});
/** Text and reasoning blocks, and system, synthetic and skill messages. */
export const opencode_text_schema = v.looseObject({
	text: v.string(),
});
const opencode_tool_output = v.array(
	v.pipe(
		plain_object,
		v.check(
			(value) =>
				value.type !== 'text' || typeof value.text === 'string',
			'Invalid text block',
		),
	),
);
export const opencode_tool_schema = v.looseObject({
	id: identity_schema,
	name: identity_schema,
	state: plain_object,
});
export const opencode_tool_state_schema = v.variant('status', [
	v.looseObject({
		status: v.literal('streaming'),
		input: v.string(),
	}),
	v.looseObject({
		status: v.literal('running'),
		input: plain_object,
	}),
	v.looseObject({
		status: v.literal('completed'),
		input: plain_object,
		content: opencode_tool_output,
	}),
	v.looseObject({
		status: v.literal('error'),
		input: plain_object,
		content: v.optional(opencode_tool_output),
		error: plain_object,
	}),
]);
export const opencode_shell_schema = v.looseObject({
	command: v.string(),
});
export const opencode_compaction_schema = v.looseObject({
	summary: v.string(),
	recent: v.string(),
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

export type Schema = v.GenericSchema;
export function validate_row<S extends v.GenericSchema>(
	schema: S,
	value: unknown,
	subject: string,
	row: number,
): v.InferOutput<S> {
	return validate(schema, value, `${subject} row ${row}`);
}
