// Synthetic dialogue only. Never load developer histories in tests.
export const timestamp = '2026-09-01T10:00:00.000Z';
export function jsonl(records: unknown[]): string {
	return (
		records.map((record) => JSON.stringify(record)).join('\n') + '\n'
	);
}
export function pi_entry(
	id: string,
	parent_id: string | null,
	role: string,
	content: unknown,
) {
	return {
		type: 'message',
		id,
		parentId: parent_id,
		timestamp,
		message: { role, content },
	};
}
export function pi_records(
	id = 'collision',
	project = '/synthetic/project',
) {
	return [
		{
			type: 'session',
			version: 3,
			id,
			cwd: project,
			timestamp,
			parentSession: '/synthetic/parent.jsonl',
		},
		{
			type: 'session_info',
			id: 'name',
			parentId: null,
			timestamp,
			name: 'Pi migration plan',
		},
		pi_entry('u1', 'name', 'user', 'Prepare the database'),
		pi_entry('a1', 'u1', 'assistant', [
			{ type: 'thinking', thinking: 'hidden-secret-thought' },
			{ type: 'text', text: 'Use café migrations safely' },
		]),
		pi_entry('tool', 'a1', 'toolResult', [
			{ type: 'text', text: 'private-tool-output' },
		]),
		pi_entry('u2', 'tool', 'user', 'Confirm the final checks'),
	];
}
export function codex_entry(
	type: string,
	payload: Record<string, unknown>,
) {
	return { type, timestamp, payload };
}
export function codex_item(
	id: string,
	type: string,
	content: string,
	turn_id = 'turn-1',
) {
	return codex_entry('event_msg', {
		type: 'item_completed',
		turn_id,
		item: {
			id,
			type,
			content: [
				{
					type: type === 'AgentMessage' ? 'Text' : 'text',
					text: content,
				},
			],
		},
	});
}
export function codex_records(
	id = 'collision',
	project = '/synthetic/project',
) {
	return [
		codex_entry('session_meta', {
			id,
			cwd: project,
			history_mode: 'paginated',
			thread_name: 'Codex migration plan',
		}),
		codex_entry('event_msg', {
			type: 'task_started',
			turn_id: 'turn-1',
		}),
		codex_item('u1', 'UserMessage', 'Prepare the database'),
		codex_entry('response_item', {
			type: 'message',
			role: 'assistant',
			content: [
				{
					type: 'output_text',
					text: 'Duplicate café migrations safely',
				},
			],
		}),
		codex_entry('response_item', {
			type: 'reasoning',
			encrypted_content: 'hidden-secret-thought',
		}),
		codex_item('a1', 'AgentMessage', 'Use café migrations safely'),
		codex_entry('response_item', {
			type: 'function_call_output',
			output: 'private-tool-output',
		}),
		codex_item('u2', 'UserMessage', 'Confirm the final checks'),
		codex_entry('event_msg', {
			type: 'task_complete',
			turn_id: 'turn-1',
		}),
	];
}
