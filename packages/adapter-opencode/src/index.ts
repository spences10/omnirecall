import { tally_unindexed } from '../../adapter-shared/src/evidence.ts';
import {
	opencode_assistant_schema,
	opencode_block_schema,
	opencode_compaction_schema,
	opencode_row_schema,
	opencode_session_schema,
	opencode_shell_schema,
	opencode_text_schema,
	opencode_tool_schema,
	opencode_tool_state_schema,
	opencode_user_schema,
	validate_row,
	type Schema,
} from '../../adapter-shared/src/schemas.ts';
import {
	all_parts,
	InputError,
	type Adapter,
	type Message,
	type Transcript,
} from '../../core/src/types.ts';
import { validate } from '../../core/src/validation.ts';
import { discover, snapshot, type Snapshot } from './storage.ts';

// Unknown values in these positions are retained with unknown state.
const tool_statuses = ['streaming', 'running', 'completed', 'error'];
const context_types = ['system', 'synthetic', 'skill'];
const passive_types = [
	'idle',
	'agent-switched',
	'model-switched',
	'location-switched',
];

const iso = (milliseconds: number) =>
	new Date(milliseconds).toISOString();

/** Interpret v2 projection rows, not the event log or the frozen v1 tables. */
export function parse_opencode(
	input: Pick<Snapshot, 'session' | 'messages'>,
): Transcript {
	const s = validate(
		opencode_session_schema,
		input.session,
		'OpenCode session',
	);
	const id = s.id;
	const created = iso(s.time_created);
	const result: Transcript = {
		native_id: id,
		project: s.directory,
		title: s.title ?? null,
		parent_session: s.parent_id ?? s.fork_session_id ?? null,
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
				raw_json: JSON.stringify(input.session),
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
	// Revert's effective model-history boundary is not inferred from projection
	// order. Keep the evidence visible, but make its activity explicitly unknown.
	let unknown_state = s.revert != null;
	let previous: string | null = null;
	let previous_seq = -1;
	const ids = new Set<string>();
	for (const [index, native] of input.messages.entries()) {
		const order = index + 1;
		const row = validate_row(
			opencode_row_schema,
			native,
			'OpenCode message',
			order,
		);
		const { id: message_id, type, data } = row;
		if (native.session_id !== id)
			throw new InputError(
				'invalid',
				`OpenCode message row ${order}: invalid field session_id`,
			);
		if (row.seq <= previous_seq || ids.has(message_id))
			throw new InputError(
				'unsupported',
				'OpenCode message IDs and sequence order must be unique',
			);
		previous_seq = row.seq;
		ids.add(message_id);
		const stamp = iso(row.time_created);
		const key = `message:${message_id}`;
		// Unpack the native JSON column while retaining its exact JSON bytes and
		// every other SQLite column, so pointers address the archived data directly.
		const { data: raw_data, ...columns } = native;
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
		const check = <S extends Schema>(
			schema: S,
			value: unknown,
			subject: string,
		) => validate_row(schema, value, `OpenCode ${subject}`, order);
		let in_progress = false;
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
			if (in_progress) part.state = 'in_progress';
			(kind === 'message' ? result.messages : result.parts!).push(
				part,
			);
			return part;
		};
		if (type === 'user') {
			const user = check(opencode_user_schema, data, 'user message');
			const message = add('message', 'user', user.text, '/data/text');
			if (message) previous = message.native_id;
		} else if (type === 'assistant') {
			const { content, time } = check(
				opencode_assistant_schema,
				data,
				'assistant message',
			);
			in_progress = time.completed === undefined;
			const dialogue = content
				.filter((block) => block.type === 'text')
				.map(
					(block) =>
						check(opencode_text_schema, block, 'text block').text,
				)
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
						check(opencode_text_schema, block, 'reasoning block')
							.text,
						`${pointer}/text`,
					);
				} else if (block.type === 'tool') {
					const tool = check(
						opencode_tool_schema,
						block,
						'tool block',
					);
					if (calls.has(tool.id))
						throw new InputError(
							'unsupported',
							'Repeated OpenCode tool call identity',
						);
					calls.add(tool.id);
					if (!tool_statuses.includes(String(tool.state.status))) {
						unknown_state = true;
						continue;
					}
					const state = check(
						opencode_tool_state_schema,
						tool.state,
						'tool state',
					);
					const call = add(
						'tool_call',
						'assistant',
						`${tool.name}\n${state.status === 'streaming' ? state.input : JSON.stringify(state.input)}`,
						`${pointer}/state/input`,
						tool.id,
					)!;
					result.links!.push({
						record_key: key,
						kind: 'tool_call',
						namespace: 'call',
						target: tool.id,
					});
					if (
						state.status === 'streaming' ||
						state.status === 'running'
					) {
						call.state = 'in_progress';
						continue;
					}
					const output = state.content ?? [];
					const texts = output
						.filter((item) => item.type === 'text')
						.map((item) => item.text as string);
					if (
						output.some(
							(item) => !['text', 'file'].includes(String(item.type)),
						)
					)
						unknown_state = true;
					if (state.status === 'error')
						texts.push(JSON.stringify(state.error));
					add(
						'tool_result',
						'tool',
						texts.join('\n'),
						`${pointer}/state`,
						tool.id,
						call.native_id,
					);
					result.links!.push({
						record_key: key,
						kind: 'tool_result_for',
						namespace: 'call',
						target: tool.id,
					});
				} else {
					check(opencode_block_schema, block, 'content block');
					unknown_state = true;
				}
			}
		} else if (context_types.includes(type)) {
			add(
				'context',
				'system',
				check(opencode_text_schema, data, `${type} message`).text,
				'/data/text',
			);
		} else if (type === 'shell') {
			const shell = check(
				opencode_shell_schema,
				data,
				'shell message',
			);
			add(
				'operation',
				'tool',
				[
					shell.command,
					shell.output === undefined
						? ''
						: typeof shell.output === 'string'
							? shell.output
							: JSON.stringify(shell.output),
				]
					.filter(Boolean)
					.join('\n'),
				'/data',
			);
		} else if (type === 'compaction') {
			if (data.status === 'running' || data.status === 'completed') {
				const compaction = check(
					opencode_compaction_schema,
					data,
					'compaction message',
				);
				add(
					'summary',
					'system',
					[compaction.summary, compaction.recent]
						.filter(Boolean)
						.join('\n'),
					'/data',
				);
			} else if (data.status !== 'failed') unknown_state = true;
		} else if (!passive_types.includes(type)) {
			unknown_state = true;
		}
	}
	if (unknown_state)
		for (const part of all_parts(result)) part.state = 'unknown';
	tally_unindexed(result);
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
