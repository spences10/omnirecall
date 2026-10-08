import {
	obj,
	readable,
	str,
	tool_call_text,
	type EvidenceFormat,
} from '../../adapter-shared/src/evidence.ts';

/** Tools, reasoning, operations and realtime speech beside Codex dialogue. */
export function codex_evidence(
	inactive_turns: readonly string[] = [],
): EvidenceFormat {
	const inactive = new Set(inactive_turns);
	let turn: string | null = null;
	return {
		dialogue_pointer: '/payload/item/content',
		position(value) {
			turn = str(obj(value.payload).turn_id) ?? turn;
			return {
				active: !(turn && inactive.has(turn)),
				turn_id: turn,
			};
		},
		extract({ value: v, original, add, link }) {
			const p = obj(v.payload);
			link('forked_from', 'session', p.forked_from_id);
			const spawn = obj(obj(obj(p.source).subagent).thread_spawn);
			link('child_session', 'session', spawn.parent_thread_id);
			if (
				v.type === 'realtime_item' &&
				p.type === 'transcript_segment'
			) {
				const segment = add(
					'message',
					str(p.text) ?? '',
					'/payload/text',
					str(p.role) ?? 'unknown',
				);
				if (segment) {
					// Realtime segments are evidence, not an inferred continuation of the last coding turn.
					segment.turn_id = null;
					segment.parent_id = null;
					segment.state = 'unknown';
					segment.active = true;
				}
			}
			if (v.type === 'response_item') {
				if (
					p.type === 'function_call' ||
					p.type === 'custom_tool_call'
				)
					add(
						'tool_call',
						tool_call_text(p.name, p.arguments ?? p.input),
						'/payload',
						'assistant',
						str(p.call_id) ?? undefined,
					);
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
		},
	};
}
