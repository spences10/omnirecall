import {
	InputError,
	metadata,
	object,
	text,
	type Adapter,
	type JsonObject,
	type Message,
	type Transcript,
} from '../../core/src/types.ts';
import { discover, snapshot, type Snapshot } from './storage.ts';

function invalid(field: string): never {
	throw new InputError('invalid', `OpenCode: invalid field ${field}`);
}
function string(value: unknown, field: string): string {
	if (typeof value !== 'string') invalid(field);
	return value;
}
function integer(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0)
		invalid(field);
	return Number(value);
}
function timestamp(value: unknown, field: string): string {
	const date = new Date(integer(value, field));
	if (!Number.isFinite(date.getTime())) invalid(field);
	return date.toISOString();
}
function json(value: unknown, field: string): JsonObject {
	try {
		return object(JSON.parse(string(value, field)));
	} catch {
		return invalid(field);
	}
}
function array(value: unknown, field: string): unknown[] {
	if (!Array.isArray(value)) invalid(field);
	return value;
}

/** Interpret v2 projection rows, not the event log or the frozen v1 tables. */
export function parse_opencode(
	input: Pick<Snapshot, 'session' | 'messages'>,
): Transcript {
	const s = input.session;
	const id = text(s.id);
	const created = timestamp(s.time_created, 'session.time_created');
	timestamp(s.time_updated, 'session.time_updated');
	text(s.version);
	const result: Transcript = {
		native_id: id,
		project: string(s.directory, 'session.directory'),
		title: metadata(s.title),
		parent_session:
			metadata(s.parent_id) ?? metadata(s.fork_session_id),
		timestamp: created,
		messages: [],
		parts: [],
		links: [],
		unindexed_records: 0,
		records: [
			{
				key: 'session',
				native_id: id,
				native_type: 'session_v2',
				timestamp: created,
				source_order: 0,
				raw_json: JSON.stringify(s),
			},
		],
	};
	for (const [kind, target] of [
		['child_session', s.parent_id],
		['forked_from', s.fork_session_id],
	]) {
		if (typeof target === 'string')
			result.links!.push({
				record_key: 'session',
				kind: String(kind),
				namespace: 'session',
				target,
			});
	}
	if (s.fork_boundary != null)
		json(s.fork_boundary, 'session.fork_boundary');
	// Revert's effective model-history boundary is not inferred from projection
	// order. Keep the evidence visible, but make its activity explicitly unknown.
	let unknown_state = s.revert != null;
	if (s.revert != null) json(s.revert, 'session.revert');
	let previous: string | null = null;
	let previous_seq = -1;
	const ids = new Set<string>();
	for (const [index, row] of input.messages.entries()) {
		const message_id = text(row.id),
			type = text(row.type);
		if (row.session_id !== id) invalid('message.session_id');
		const seq = integer(row.seq, 'message.seq');
		if (seq <= previous_seq || ids.has(message_id))
			throw new InputError(
				'unsupported',
				'OpenCode message IDs and sequence order must be unique',
			);
		previous_seq = seq;
		ids.add(message_id);
		const stamp = timestamp(row.time_created, 'message.time_created');
		timestamp(row.time_updated, 'message.time_updated');
		const data = json(row.data, 'message.data');
		const key = `message:${message_id}`;
		const order = index + 1;
		// Unpack the native JSON column while retaining its exact JSON bytes and
		// every other SQLite column, so pointers address the archived data directly.
		const { data: raw_data, ...columns } = row;
		result.records!.push({
			key,
			native_id: message_id,
			native_type: type,
			timestamp: stamp,
			source_order: order,
			raw_json:
				JSON.stringify(columns).slice(0, -1) +
				',"data":' +
				raw_data +
				'}',
		});
		const add = (
			kind: string,
			role: string,
			content: string,
			pointer: string,
			suffix = pointer,
			parent = previous,
		): Message | undefined => {
			if (!content.trim()) return;
			const part: Message = {
				native_id:
					kind === 'message'
						? message_id
						: JSON.stringify([message_id, kind, suffix]),
				parent_id: parent,
				kind,
				role,
				content,
				timestamp: stamp,
				source_order: order,
				active: true,
				turn_id: null,
				record_key: key,
				json_pointer: pointer,
			};
			if (
				type === 'assistant' &&
				object(data.time).completed === undefined
			)
				part.state = 'in_progress';
			(kind === 'message' ? result.messages : result.parts!).push(
				part,
			);
			return part;
		};
		if (['user', 'assistant'].includes(type)) {
			const time = object(data.time);
			timestamp(time.created, 'message.data.time.created');
			if (time.completed !== undefined)
				timestamp(time.completed, 'message.data.time.completed');
		}
		if (type === 'user') {
			const message = add(
				'message',
				'user',
				string(data.text, 'user.text'),
				'/data/text',
			);
			if (message) previous = message.native_id;
		} else if (type === 'assistant') {
			const content = array(data.content, 'assistant.content').map(
				object,
			);
			const dialogue = content
				.filter((block) => block.type === 'text')
				.map((block) => string(block.text, 'assistant.content.text'))
				.join('\n');
			const message = add(
				'message',
				'assistant',
				dialogue,
				'/data/content',
			);
			if (message) previous = message.native_id;
			const calls = new Set<string>();
			for (const [i, block] of content.entries()) {
				const pointer = `/data/content/${i}`;
				if (block.type === 'text') continue;
				if (block.type === 'reasoning') {
					add(
						'reasoning',
						'assistant',
						string(block.text, 'reasoning.text'),
						`${pointer}/text`,
					);
				} else if (block.type === 'tool') {
					const call_id = text(block.id),
						name = text(block.name),
						state = object(block.state);
					if (calls.has(call_id))
						throw new InputError(
							'unsupported',
							'Repeated OpenCode tool call identity',
						);
					calls.add(call_id);
					if (
						!['streaming', 'running', 'completed', 'error'].includes(
							String(state.status),
						)
					) {
						unknown_state = true;
						continue;
					}
					const input =
						state.status === 'streaming'
							? string(state.input, 'tool.input')
							: JSON.stringify(object(state.input));
					const call = add(
						'tool_call',
						'assistant',
						`${name}\n${input}`,
						`${pointer}/state/input`,
						call_id,
					)!;
					if (
						state.status === 'streaming' ||
						state.status === 'running'
					)
						call.state = 'in_progress';
					result.links!.push({
						record_key: key,
						kind: 'tool_call',
						namespace: 'call',
						target: call_id,
					});
					if (
						state.status === 'completed' ||
						state.status === 'error'
					) {
						const output =
							state.content === undefined && state.status === 'error'
								? []
								: array(state.content, 'tool.content').map(object);
						const texts = output
							.filter((item) => item.type === 'text')
							.map((item) => string(item.text, 'tool.content.text'));
						if (
							output.some(
								(item) =>
									!['text', 'file'].includes(String(item.type)),
							)
						)
							unknown_state = true;
						if (state.status === 'error')
							texts.push(JSON.stringify(object(state.error)));
						add(
							'tool_result',
							'tool',
							texts.join('\n'),
							`${pointer}/state`,
							call_id,
							call.native_id,
						);
						result.links!.push({
							record_key: key,
							kind: 'tool_result_for',
							namespace: 'call',
							target: call_id,
						});
					}
				} else {
					text(block.type);
					unknown_state = true;
				}
			}
		} else if (['system', 'synthetic', 'skill'].includes(type)) {
			add(
				'context',
				'system',
				string(data.text, `${type}.text`),
				'/data/text',
			);
		} else if (type === 'shell') {
			add(
				'operation',
				'tool',
				[
					string(data.command, 'shell.command'),
					data.output === undefined
						? ''
						: typeof data.output === 'string'
							? data.output
							: JSON.stringify(data.output),
				]
					.filter(Boolean)
					.join('\n'),
				'/data',
			);
		} else if (type === 'compaction') {
			if (data.status === 'running' || data.status === 'completed')
				add(
					'summary',
					'system',
					[
						string(data.summary, 'compaction.summary'),
						string(data.recent, 'compaction.recent'),
					]
						.filter(Boolean)
						.join('\n'),
					'/data',
				);
			else if (data.status !== 'failed') unknown_state = true;
		} else if (
			![
				'idle',
				'agent-switched',
				'model-switched',
				'location-switched',
			].includes(type)
		) {
			unknown_state = true;
		}
	}
	if (unknown_state)
		for (const part of [...result.messages, ...result.parts!])
			part.state = 'unknown';
	const indexed = new Set(
		[...result.messages, ...result.parts!].map(
			(part) => part.record_key,
		),
	);
	result.unindexed_records = result.records!.filter(
		(record) => !indexed.has(record.key),
	).length;
	return result;
}

export const opencode_adapter: Adapter = {
	agent: 'opencode',
	parser_version: 1,
	discover,
	async fingerprint(unit) {
		return (await snapshot(unit)).hash;
	},
	async read(unit) {
		const captured = await snapshot(unit);
		return {
			sessions: [parse_opencode(captured)],
			inputs: [
				{
					path: unit.locators[0]!,
					hash: captured.hash,
					byte_offset: 0,
					partial: false,
				},
			],
		};
	},
};
