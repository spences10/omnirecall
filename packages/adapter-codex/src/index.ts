import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { preserve_records } from '../../adapter-shared/src/evidence.ts';
import {
	codex_dialogue,
	codex_entry_schema,
	codex_header_schema,
	codex_realtime_schema,
	codex_title_schema,
	validate_source,
} from '../../adapter-shared/src/schemas.ts';
import {
	discover_jsonl,
	jsonl_adapter,
	read_snapshot,
} from '../../core/src/files.ts';
import {
	date,
	InputError,
	metadata,
	object,
	text,
	type Message,
	type RecordLine,
	type Transcript,
} from '../../core/src/types.ts';

export function parse_codex(records: RecordLine[]): Transcript {
	const header = records[0]?.value;
	if (!header || header.type !== 'session_meta')
		throw new InputError(
			'unsupported',
			'Expected Codex session_meta header',
		);
	const meta = object(header.payload);
	if (meta.history_mode !== 'paginated')
		throw new InputError(
			meta.history_mode === 'legacy' ? 'legacy' : 'unsupported',
			'Only Codex history_mode=paginated is supported',
		);
	validate_source(
		codex_header_schema,
		header,
		'Codex',
		records[0]!.byte_offset,
	);
	const result: Transcript = {
		native_id: text(meta.id),
		project: text(meta.cwd),
		title: metadata(meta.thread_name),
		parent_session: metadata(meta.forked_from_id),
		timestamp: date(header.timestamp),
		messages: [],
		unindexed_records: 0,
	};
	let unknown_state = false;
	const turns: { id: string; active: boolean }[] = [];
	const messages = new Map<string, Message>();
	let current_turn: string | null = null;
	let previous_id: string | null = null;
	let previous_ordinal = -1;
	function ensure_turn(id: string) {
		const previous = turns.find((turn) => turn.id === id);
		if (previous && !previous.active)
			throw new InputError(
				'unsupported',
				'Reused rolled-back turn ID',
			);
		if (!previous) turns.push({ id, active: true });
	}
	for (const { value: entry, byte_offset } of records.slice(1)) {
		validate_source(codex_entry_schema, entry, 'Codex', byte_offset);
		const timestamp = date(entry.timestamp);
		if (entry.ordinal !== undefined) {
			if (
				!Number.isSafeInteger(entry.ordinal) ||
				Number(entry.ordinal) <= previous_ordinal
			)
				throw new InputError(
					'unsupported',
					'Non-increasing Codex ordinals',
				);
			previous_ordinal = Number(entry.ordinal);
		}
		const payload = object(entry.payload);
		if (
			entry.type === 'response_item' &&
			![
				'message',
				'reasoning',
				'function_call',
				'function_call_output',
				'custom_tool_call',
				'custom_tool_call_output',
				'web_search_call',
				'local_shell_call',
			].includes(String(payload.type))
		) {
			unknown_state = true;
			result.unindexed_records++;
			continue;
		}
		if (entry.type === 'realtime_item') {
			if (
				typeof payload.type === 'string' &&
				![
					'realtime_session_started',
					'transcript_segment',
					'realtime_session_closed',
				].includes(payload.type)
			) {
				unknown_state = true;
				result.unindexed_records++;
				continue;
			}
			validate_source(
				codex_realtime_schema,
				payload,
				'Codex realtime item',
				byte_offset,
			);
			// Realtime evidence is preserved separately; it need not belong to a coding turn.
			continue;
		}
		if (entry.type === 'turn_context') {
			current_turn = text(payload.turn_id);
			ensure_turn(current_turn);
			continue;
		}
		if (
			[
				'response_item',
				'token_usage_record',
				'compacted',
				'world_state',
			].includes(String(entry.type))
		) {
			result.unindexed_records++;
			continue;
		}
		if (entry.type !== 'event_msg') {
			unknown_state = true;
			result.unindexed_records++;
			continue;
		}
		if (payload.type === 'task_started') {
			current_turn = text(payload.turn_id);
			ensure_turn(current_turn);
		} else if (payload.type === 'thread_rolled_back') {
			const count = payload.num_turns;
			const live = turns.filter((turn) => turn.active);
			if (
				!Number.isSafeInteger(count) ||
				Number(count) < 0 ||
				Number(count) > live.length
			)
				throw new InputError(
					'unsupported',
					'Rollback cannot be resolved from available turns',
				);
			for (const turn of live.slice(live.length - Number(count)))
				turn.active = false;
			for (const message of messages.values())
				message.active = turns.some(
					(turn) => turn.id === message.turn_id && turn.active,
				);
			previous_id =
				[...messages.values()]
					.filter((message) => message.active)
					.at(-1)?.native_id ?? null;
			current_turn = null;
		} else if (payload.type === 'item_completed') {
			const item = object(payload.item);
			const item_type = text(item.type);
			if (
				item_type !== 'UserMessage' &&
				item_type !== 'AgentMessage'
			) {
				if (
					![
						'Reasoning',
						'CommandExecution',
						'FileChange',
						'McpToolCall',
						'DynamicToolCall',
						'WebSearch',
						'ImageView',
						'ImageGeneration',
						'Plan',
						'CollabAgentToolCall',
						'CollabToolCall',
						'Extension',
						'ContextCompaction',
					].includes(item_type)
				) {
					unknown_state = true;
					result.unindexed_records++;
					continue;
				}
				result.unindexed_records++;
				continue;
			}
			if (
				payload.thread_id !== undefined &&
				payload.thread_id !== result.native_id
			)
				throw new InputError(
					'unsupported',
					'Completed item belongs to a different thread',
				);
			const turn_id =
				typeof payload.turn_id === 'string'
					? payload.turn_id
					: current_turn;
			if (!turn_id)
				throw new InputError(
					'unsupported',
					'Dialogue without a turn ID',
				);
			ensure_turn(turn_id);
			let content: string;
			try {
				content = codex_dialogue(item, byte_offset);
			} catch (error) {
				if (
					error instanceof InputError &&
					error.code === 'unsupported'
				) {
					unknown_state = true;
					result.unindexed_records++;
					continue;
				}
				throw error;
			}
			const id = text(item.id);
			const previous = messages.get(id);
			const role = item_type === 'UserMessage' ? 'user' : 'assistant';
			if (previous) {
				if (previous.turn_id !== turn_id || previous.role !== role)
					throw new InputError(
						'unsupported',
						'Conflicting completed item identity',
					);
				previous.content = content;
				previous.timestamp = timestamp;
				previous.source_order = byte_offset;
			} else if (content.trim()) {
				messages.set(id, {
					native_id: id,
					parent_id: previous_id,
					role,
					content,
					timestamp,
					source_order: byte_offset,
					active: true,
					turn_id,
				});
				previous_id = id;
			}
		} else if (
			['task_complete', 'turn_aborted'].includes(String(payload.type))
		) {
			current_turn = null;
		} else if (
			[
				'token_count',
				'user_message',
				'agent_message',
				'thread_settings_applied',
			].includes(String(payload.type))
		) {
			result.unindexed_records++;
		} else {
			unknown_state = true;
			result.unindexed_records++;
			continue;
		}
	}
	result.messages = [...messages.values()];
	result.inactive_turns = turns
		.filter((t) => !t.active)
		.map((t) => t.id);
	const preserved = preserve_records(records, result, 'codex');
	if (unknown_state)
		for (const message of [
			...preserved.messages,
			...(preserved.parts ?? []),
		]) {
			message.state = 'unknown';
			message.active = true;
		}
	return preserved;
}

export async function session_titles(
	root: string,
): Promise<Map<string, string>> {
	const titles = new Map<
		string,
		{ title: string; timestamp: string }
	>();
	let snapshot;
	try {
		snapshot = await read_snapshot(join(root, 'session_index.jsonl'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			return new Map();
		throw error;
	}
	if (snapshot.partial)
		throw new InputError(
			'partial',
			'Codex title index has an incomplete record',
		);
	for (const { value, byte_offset } of snapshot.records) {
		validate_source(
			codex_title_schema,
			value,
			'Codex title',
			byte_offset,
		);
		const id = text(value.id);
		const timestamp = date(value.updated_at);
		if (typeof value.thread_name !== 'string')
			throw new InputError('invalid', 'Invalid Codex title');
		if (timestamp >= (titles.get(id)?.timestamp ?? ''))
			titles.set(id, {
				title: metadata(value.thread_name)!,
				timestamp,
			});
	}
	return new Map([...titles].map(([id, value]) => [id, value.title]));
}

export const codex_adapter = Object.assign(
	jsonl_adapter('codex', parse_codex, async (root) => {
		const entries = await readdir(root, { withFileTypes: true });
		const history_dirs = entries.filter(
			(e) =>
				e.isDirectory() &&
				['sessions', 'archived_sessions'].includes(e.name),
		);
		const paths = history_dirs.length
			? (
					await Promise.all(
						history_dirs.map((e) =>
							discover_jsonl(join(root, e.name)),
						),
					)
				).flat()
			: await discover_jsonl(root);
		return paths
			.filter((path) => path !== join(root, 'session_index.jsonl'))
			.sort();
	}),
	{ titles: session_titles, parser_version: 3 },
);
