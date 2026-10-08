import { basename } from 'node:path';
import {
	obj,
	preserve_records,
	readable,
	str,
	tool_call_text,
	type RecordParts,
} from '../../adapter-shared/src/evidence.ts';
import {
	claude_message_schema,
	validate_source,
} from '../../adapter-shared/src/schemas.ts';
import { jsonl_adapter } from '../../core/src/files.ts';
import {
	all_parts,
	InputError,
	iso_timestamp,
	object,
	type RecordLine,
	type Transcript,
} from '../../core/src/types.ts';

/** Tools, thinking and summaries beside Claude dialogue. */
function claude_parts({ value: v, add, link }: RecordParts) {
	link('parent', 'record', v.parentUuid);
	link('summary_of', 'record', v.leafUuid);
	const content = obj(v.message).content;
	if (Array.isArray(content)) {
		for (const [i, value] of content.entries()) {
			const b = obj(value),
				pointer = `/message/content/${i}`;
			if (b.type === 'thinking')
				add('reasoning', readable(b), pointer, 'assistant');
			if (b.type === 'tool_use')
				add(
					'tool_call',
					tool_call_text(b.name, b.input),
					pointer,
					'assistant',
					str(b.id) ?? undefined,
				);
			if (b.type === 'tool_result') {
				add(
					'tool_result',
					readable(b.content),
					pointer,
					'tool',
					str(b.tool_use_id) ?? undefined,
				);
				link('tool_result_for', 'call', b.tool_use_id);
			}
		}
	}
	if (v.type === 'summary')
		add('summary', readable(v.summary), '/summary');
}

export function parse_claude(
	records: RecordLine[],
	path = '',
): Transcript {
	const ids = new Set(
		records
			.map((r) => r.value.sessionId)
			.filter((id) => typeof id === 'string' && id.length),
	);
	if (ids.size !== 1)
		throw new InputError(
			'unsupported',
			'Expected one identifiable Claude conversation per transcript',
		);
	const id = [...ids][0] as string;
	const subagent = /[/\\]subagents[/\\]/.test(path)
		? basename(path, '.jsonl')
		: null;
	const stamp = records
		.map((r) => iso_timestamp(r.value.timestamp))
		.find(Boolean);
	if (!stamp)
		throw new InputError(
			'invalid',
			'Claude transcript has no valid timestamp',
		);
	const result: Transcript = {
		native_id: id,
		session_key: subagent ? `${id}:subagent:${subagent}` : id,
		project:
			(records
				.map((r) => r.value.cwd)
				.find((v) => typeof v === 'string') as string) ?? '',
		title: null,
		parent_session: subagent ? id : null,
		timestamp: stamp,
		unindexed_records: 0,
		messages: [],
	};
	const seen = new Set<string>();
	for (const { value: v, byte_offset } of records) {
		if (v.type === 'summary' && typeof v.summary === 'string')
			result.title = v.summary.slice(0, 4096);
		if (!['user', 'assistant'].includes(String(v.type))) continue;
		const validated = validate_source(
			claude_message_schema,
			v,
			'Claude',
			byte_offset,
		);
		const uuid = validated.uuid;
		if (seen.has(uuid))
			throw new InputError(
				'unsupported',
				'Repeated Claude message identity requires correction semantics',
			);
		seen.add(uuid);
		const m = object(v.message);
		const content =
			typeof m.content === 'string'
				? m.content
				: Array.isArray(m.content)
					? m.content
							.map((b) => object(b))
							.filter(
								(b) =>
									b.type === 'text' && typeof b.text === 'string',
							)
							.map((b) => b.text)
							.join('\n')
					: '';
		if (!content.trim()) continue;
		result.messages.push({
			native_id: uuid,
			parent_id:
				typeof v.parentUuid === 'string' ? v.parentUuid : null,
			role: String(v.type),
			content,
			timestamp: iso_timestamp(v.timestamp) ?? result.timestamp,
			source_order: byte_offset,
			active: true,
			turn_id: null,
		});
	}
	// Native parents may be tool-only or metadata records without a searchable
	// message. Follow their explicit ancestry, never chronological neighbours.
	const parents = new Map<string, string | null>();
	for (const { value } of records) {
		if (typeof value.uuid !== 'string') continue;
		parents.set(
			value.uuid,
			parents.has(value.uuid) || typeof value.parentUuid !== 'string'
				? null
				: value.parentUuid,
		);
	}
	const nearest = new Map<string, string | null>(
		result.messages.map((message) => [
			message.native_id,
			message.native_id,
		]),
	);
	for (const message of result.messages) {
		let parent = message.parent_id;
		const visited = new Set<string>();
		while (parent && !nearest.has(parent) && !visited.has(parent)) {
			visited.add(parent);
			parent = parents.get(parent) ?? null;
		}
		const ancestor =
			parent && parent !== message.native_id
				? (nearest.get(parent) ?? null)
				: null;
		message.parent_id = ancestor;
		for (const id of visited) nearest.set(id, ancestor);
	}
	preserve_records(records, result, {
		dialogue_pointer: '/message/content',
		extract: claude_parts,
	});
	// Branch state is not established for Claude transcripts.
	for (const part of all_parts(result)) part.state = 'unknown';
	if (subagent && result.records?.[0])
		result.links!.push({
			record_key: result.records[0].key,
			kind: 'child_session',
			namespace: 'session',
			target: id,
		});
	return result;
}
export const claude_adapter = jsonl_adapter('claude', parse_claude);
