import type {
	JsonObject,
	Message,
	RecordLine,
	Transcript,
} from '../../core/src/types.ts';

const obj = (value: unknown): JsonObject =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as JsonObject)
		: {};
const str = (value: unknown) =>
	typeof value === 'string' ? value : null;
function readable(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value))
		return value.map(readable).filter(Boolean).join('\n');
	const block = obj(value);
	return str(block.text) ?? str(block.thinking) ?? '';
}

/** Preserve envelopes independently of the searchable interpretation. */
export function preserve_records(
	lines: RecordLine[],
	transcript: Transcript,
	agent: string,
): Transcript {
	transcript.records = lines.map(
		({ value, byte_offset, raw_json }) => ({
			key: String(byte_offset),
			native_id: str(value.id) ?? str(value.uuid),
			native_type: str(value.type),
			timestamp:
				typeof value.timestamp === 'string' &&
				Number.isFinite(Date.parse(value.timestamp))
					? new Date(value.timestamp).toISOString()
					: null,
			source_order: byte_offset,
			raw_json: raw_json ?? JSON.stringify(value),
		}),
	);
	transcript.parts = [];
	transcript.links = [];
	const calls = new Map<string, Message[]>();
	const results: { part: Message; call: string }[] = [];
	const dialogue_by_order = new Map(
		transcript.messages.map((m) => [m.source_order, m]),
	);
	let turn: string | null = null;
	const inactive_turns = new Set(transcript.inactive_turns ?? []);
	const pi_parents = new Map(
		lines.map((l) => [str(l.value.id), str(l.value.parentId)]),
	);
	const pi_active = new Set<string>();
	let leaf = str(lines.at(-1)?.value.id);
	while (leaf && !pi_active.has(leaf)) {
		pi_active.add(leaf);
		leaf = pi_parents.get(leaf) ?? null;
	}
	for (const [index, line] of lines.entries()) {
		const v = line.value,
			p = obj(v.payload),
			key = String(line.byte_offset);
		if (str(p.turn_id)) turn = str(p.turn_id);
		const original = dialogue_by_order.get(line.byte_offset);
		if (original) {
			original.kind = 'message';
			original.record_key = key;
			original.json_pointer =
				agent === 'codex'
					? '/payload/item/content'
					: '/message/content';
		}
		const timestamp = transcript.records[index]!.timestamp;
		const active =
			agent === 'pi'
				? pi_active.has(str(v.id) ?? '')
				: !(turn && inactive_turns.has(turn));
		const add = (
			kind: string,
			content: string,
			pointer: string,
			role = kind,
			call?: string,
		) => {
			if (!content.trim()) return;
			const part: Message = {
				native_id: `part:${key}:${pointer}`,
				parent_id: original?.native_id ?? null,
				role,
				kind,
				content,
				timestamp,
				source_order: line.byte_offset,
				active,
				turn_id: agent === 'codex' ? turn : null,
				record_key: key,
				json_pointer: pointer,
			};
			transcript.parts!.push(part);
			if (call && kind === 'tool_call')
				calls.set(call, [...(calls.get(call) ?? []), part]);
			if (call && kind === 'tool_result')
				results.push({ part, call });
			return part;
		};
		const link = (
			kind: string,
			namespace: string,
			target: unknown,
		) => {
			if (typeof target === 'string')
				transcript.links!.push({
					record_key: key,
					kind,
					namespace,
					target,
				});
		};
		link('parent', 'record', v.parentId ?? v.parentUuid);
		link('first_retained', 'record', v.firstKeptEntryId);
		link('summary_of', 'record', v.fromId ?? v.leafUuid);
		link('label_target', 'record', v.targetId);
		link('forked_from', 'locator', v.parentSession);
		link('forked_from', 'session', p.forked_from_id);
		const spawn = obj(obj(obj(p.source).subagent).thread_spawn);
		link('child_session', 'session', spawn.parent_thread_id);
		if (agent === 'pi' || agent === 'claude') {
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
					if (b.type === 'toolCall' || b.type === 'tool_use') {
						const input = b.arguments ?? b.input;
						add(
							'tool_call',
							`${str(b.name) ?? ''}\n${typeof input === 'string' ? input : JSON.stringify(input ?? null)}`,
							pointer,
							'assistant',
							str(b.id) ?? undefined,
						);
					}
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
			if (
				v.type === 'compaction' ||
				v.type === 'branch_summary' ||
				v.type === 'summary'
			)
				add('summary', readable(v.summary), '/summary');
			if (v.type === 'custom_message')
				add('message', readable(v.content), '/content', 'custom');
			if (role === 'bashExecution')
				add(
					'operation',
					[str(m.command), str(m.output)].filter(Boolean).join('\n'),
					'/message',
				);
		} else {
			if (v.type === 'response_item') {
				if (
					p.type === 'function_call' ||
					p.type === 'custom_tool_call'
				) {
					const input = p.arguments ?? p.input;
					add(
						'tool_call',
						`${str(p.name) ?? ''}\n${typeof input === 'string' ? input : JSON.stringify(input ?? null)}`,
						'/payload',
						'assistant',
						str(p.call_id) ?? undefined,
					);
				}
				if (
					p.type === 'function_call_output' ||
					p.type === 'custom_tool_call_output'
				) {
					add(
						'tool_result',
						typeof p.output === 'string'
							? p.output
							: JSON.stringify(p.output ?? null),
						'/payload/output',
						'tool',
						str(p.call_id) ?? undefined,
					);
					link('tool_result_for', 'call', p.call_id);
				}
			}
			if (p.type === 'item_completed') {
				const item = obj(p.item);
				if (
					['UserMessage', 'AgentMessage'].includes(
						String(item.type),
					) &&
					!original
				) {
					const prior = add(
						'message',
						readable(item.content),
						'/payload/item/content',
						item.type === 'UserMessage' ? 'user' : 'assistant',
					);
					if (prior) prior.representation = 'superseded';
				}
				if (item.type === 'Reasoning')
					add(
						'reasoning',
						readable(item.summary_text),
						'/payload/item/summary_text',
						'assistant',
					);
				if (
					![
						'UserMessage',
						'AgentMessage',
						'Reasoning',
						'ContextCompaction',
					].includes(String(item.type))
				) {
					add('operation', JSON.stringify(item), '/payload/item');
					link(
						'child_session',
						'session',
						item.new_thread_id ?? item.newThreadId,
					);
				}
			}
			if (v.type === 'compacted')
				add('summary', readable(p.message), '/payload/message');
		}
	}
	if (agent === 'claude')
		for (const part of [...transcript.messages, ...transcript.parts])
			part.state = 'unknown';
	// A native call ID can be ambiguous; never pick a call by proximity alone.
	for (const { part, call } of results) {
		const candidates = calls.get(call) ?? [];
		if (candidates.length === 1)
			part.parent_id = candidates[0]!.native_id;
	}
	const indexed = new Set(
		[...transcript.messages, ...transcript.parts!].map(
			(p) => p.record_key,
		),
	);
	transcript.unindexed_records = transcript.records.filter(
		(r) => !indexed.has(r.key),
	).length;
	return transcript;
}
