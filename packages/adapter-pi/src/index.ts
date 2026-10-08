import {
	obj,
	preserve_records,
	readable,
	str,
	tool_call_text,
	type RecordParts,
} from '../../adapter-shared/src/evidence.ts';
import {
	pi_entry_schema,
	pi_header_schema,
	pi_message_schema,
	validate_source,
} from '../../adapter-shared/src/schemas.ts';
import { InputError } from '../../core/src/errors.ts';
import { jsonl_adapter } from '../../core/src/files.ts';
import {
	date,
	dialogue,
	metadata,
	object,
	text,
} from '../../core/src/readers.ts';
import type {
	Message,
	RecordLine,
	Transcript,
} from '../../core/src/types.ts';

/** Tools, thinking, summaries and shell runs beside Pi dialogue. */
function pi_parts({ value: v, add, link }: RecordParts) {
	link('parent', 'record', v.parentId);
	link('first_retained', 'record', v.firstKeptEntryId);
	link('summary_of', 'record', v.fromId);
	link('label_target', 'record', v.targetId);
	link('forked_from', 'locator', v.parentSession);
	const m = obj(v.message);
	const role = str(m.role) ?? str(v.type) ?? 'unknown';
	if (role === 'toolResult') {
		add(
			'tool_result',
			readable(m.content),
			'/message/content',
			'tool',
			str(m.toolCallId) ?? undefined,
		);
		link('tool_result_for', 'call', m.toolCallId);
	} else if (Array.isArray(m.content)) {
		for (const [i, value] of m.content.entries()) {
			const b = obj(value),
				pointer = `/message/content/${i}`;
			if (b.type === 'thinking')
				add('reasoning', readable(b), pointer, 'assistant');
			if (b.type === 'toolCall')
				add(
					'tool_call',
					tool_call_text(b.name, b.arguments),
					pointer,
					'assistant',
					str(b.id) ?? undefined,
				);
		}
	}
	if (v.type === 'compaction' || v.type === 'branch_summary')
		add('summary', readable(v.summary), '/summary');
	if (v.type === 'custom_message')
		add('message', readable(v.content), '/content', 'custom');
	if (role === 'bashExecution')
		add(
			'operation',
			[str(m.command), str(m.output)].filter(Boolean).join('\n'),
			'/message',
		);
}

export function parse_pi(records: RecordLine[]): Transcript {
	const header = records[0]?.value;
	if (!header || header.type !== 'session' || header.version !== 3)
		throw new InputError(
			'unsupported',
			'Only Pi session version 3 trees are supported',
		);
	validate_source(
		pi_header_schema,
		header,
		'Pi',
		records[0]!.byte_offset,
	);
	const result: Transcript = {
		native_id: text(header.id),
		project: text(header.cwd),
		title: null,
		parent_session: metadata(header.parentSession),
		timestamp: date(header.timestamp),
		messages: [],
		unindexed_records: 0,
	};
	const parents = new Map<string, string | null>();
	const nearest_message = new Map<string, string | null>();
	let leaf: string | null = null;
	for (const { value: entry, byte_offset } of records.slice(1)) {
		validate_source(pi_entry_schema, entry, 'Pi', byte_offset);
		const id = text(entry.id);
		const parent_id =
			entry.parentId === null ? null : text(entry.parentId);
		if (
			parents.has(id) ||
			(parent_id !== null && !parents.has(parent_id))
		)
			throw new InputError(
				'invalid',
				'Duplicate entry ID or missing/forward tree parent',
			);
		const timestamp = date(entry.timestamp);
		parents.set(id, parent_id);
		leaf = id;
		let ancestor =
			parent_id === null
				? null
				: (nearest_message.get(parent_id) ?? null);
		if (entry.type === 'message') {
			const message = object(entry.message);
			if (message.role === 'user' || message.role === 'assistant') {
				validate_source(
					pi_message_schema,
					message,
					'Pi message',
					byte_offset,
				);
				const content = dialogue(
					message.content,
					['thinking', 'image', 'toolCall'],
					true,
				);
				if (content.trim()) {
					const normalized: Message = {
						native_id: id,
						parent_id: ancestor,
						role: message.role,
						content,
						timestamp,
						source_order: byte_offset,
						active: false,
						turn_id: null,
					};
					result.messages.push(normalized);
					ancestor = id;
				}
			}
		} else if (entry.type === 'session_info') {
			result.title = metadata(entry.name);
		}
		nearest_message.set(id, ancestor);
	}
	const active_ids = new Set<string>();
	while (leaf !== null) {
		active_ids.add(leaf);
		leaf = parents.get(leaf) ?? null;
	}
	for (const message of result.messages)
		message.active = active_ids.has(message.native_id);
	return preserve_records(records, result, {
		dialogue_pointer: '/message/content',
		position: (value) => ({
			active: active_ids.has(str(value.id) ?? ''),
			turn_id: null,
		}),
		extract: pi_parts,
	});
}

export const pi_adapter = jsonl_adapter('pi', parse_pi);
