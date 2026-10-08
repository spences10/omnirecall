import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
	obj,
	preserve_records,
} from '../../adapter-shared/src/evidence.ts';
import {
	codex_entry_schema,
	codex_header_schema,
	codex_realtime_schema,
	codex_title_schema,
	validate_source,
} from '../../adapter-shared/src/schemas.ts';
import { InputError } from '../../core/src/errors.ts';
import {
	discover_jsonl,
	jsonl_adapter,
	read_snapshot,
} from '../../core/src/files.ts';
import {
	all_parts,
	date,
	metadata,
	object,
	text,
} from '../../core/src/readers.ts';
import type {
	JsonObject,
	RecordLine,
	Transcript,
} from '../../core/src/types.ts';
import { codex_evidence } from './evidence.ts';
import { codex_thread } from './thread.ts';

// Known native types. Anything else leaves the session's activity unknown.
const response_items = [
	'message',
	'reasoning',
	'function_call',
	'function_call_output',
	'custom_tool_call',
	'custom_tool_call_output',
	'web_search_call',
	'local_shell_call',
];
const realtime_items = [
	'realtime_session_started',
	'transcript_segment',
	'realtime_session_closed',
];
/** Entry types that carry no dialogue and never change turn state. */
const passive_entries = [
	'response_item',
	'token_usage_record',
	'compacted',
	'world_state',
];
/** Completed items kept as evidence rather than dialogue. */
const evidence_items = [
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
];
const turn_endings = ['task_complete', 'turn_aborted'];
const passive_events = [
	'token_count',
	'user_message',
	'agent_message',
	'thread_settings_applied',
];

// Approval reviewers receive machine-supplied conversation copies as user
// messages. Classify by explicit provenance, never by body text or filename.
function is_approval_reviewer(meta: JsonObject) {
	const source = obj(meta.source);
	const reviewer_name = obj(source.subagent).other;
	return (
		reviewer_name === 'guardian' ||
		reviewer_name === 'approval_reviewer' ||
		source.internal === 'guardian' ||
		meta.thread_source === 'guardian_review'
	);
}

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
	const approval_reviewer = is_approval_reviewer(meta);
	const result: Transcript = {
		native_id: text(meta.id),
		project: text(meta.cwd),
		title: metadata(meta.thread_name),
		parent_session:
			metadata(meta.forked_from_id) ??
			(approval_reviewer ? metadata(meta.parent_thread_id) : null),
		timestamp: date(header.timestamp),
		messages: [],
		unindexed_records: 0,
	};
	let unknown_state = false;
	const thread = codex_thread(result.native_id);
	let previous_ordinal = -1;
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
			!response_items.includes(String(payload.type))
		) {
			unknown_state = true;
			continue;
		}
		if (entry.type === 'realtime_item') {
			if (
				typeof payload.type === 'string' &&
				!realtime_items.includes(payload.type)
			) {
				unknown_state = true;
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
			thread.begin_turn(payload.turn_id);
			continue;
		}
		if (passive_entries.includes(String(entry.type))) continue;
		if (entry.type !== 'event_msg') {
			unknown_state = true;
			continue;
		}
		if (payload.type === 'task_started') {
			thread.begin_turn(payload.turn_id);
		} else if (payload.type === 'thread_rolled_back') {
			thread.roll_back(payload.num_turns);
		} else if (payload.type === 'item_completed') {
			const item = object(payload.item);
			const item_type = text(item.type);
			if (
				item_type !== 'UserMessage' &&
				item_type !== 'AgentMessage'
			) {
				if (!evidence_items.includes(item_type)) unknown_state = true;
			} else if (
				!thread.complete(
					payload,
					item,
					item_type === 'UserMessage' ? 'user' : 'assistant',
					timestamp,
					byte_offset,
				)
			)
				unknown_state = true;
		} else if (turn_endings.includes(String(payload.type))) {
			thread.end_turn();
		} else if (!passive_events.includes(String(payload.type))) {
			unknown_state = true;
		}
	}
	result.messages = thread.messages();
	result.inactive_turns = thread.inactive_turns();
	const preserved = preserve_records(
		records,
		result,
		codex_evidence(result.inactive_turns),
	);
	if (approval_reviewer) {
		for (const part of all_parts(preserved)) {
			if (part.kind === 'message' && part.role === 'user') {
				part.kind = 'review_context';
				part.role = 'context';
			}
		}
		if (typeof meta.parent_thread_id === 'string')
			preserved.links!.push({
				record_key: preserved.records![0]!.key,
				kind: 'child_session',
				namespace: 'session',
				target: meta.parent_thread_id,
			});
	}
	if (unknown_state)
		for (const message of all_parts(preserved)) {
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
