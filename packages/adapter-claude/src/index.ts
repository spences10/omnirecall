import { basename } from 'node:path';
import { preserve_records } from '../../adapter-shared/src/evidence.ts';
import { jsonl_adapter } from '../../core/src/files.ts';
import {
	InputError,
	object,
	type RecordLine,
	type Transcript,
} from '../../core/src/types.ts';

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
		.map((r) => r.value.timestamp)
		.find(
			(t) => typeof t === 'string' && Number.isFinite(Date.parse(t)),
		);
	if (typeof stamp !== 'string')
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
		timestamp: new Date(stamp).toISOString(),
		unindexed_records: 0,
		messages: [],
	};
	const seen = new Set<string>();
	for (const { value: v, byte_offset } of records) {
		if (v.type === 'summary' && typeof v.summary === 'string')
			result.title = v.summary.slice(0, 4096);
		if (
			!['user', 'assistant'].includes(String(v.type)) ||
			typeof v.uuid !== 'string'
		)
			continue;
		if (seen.has(v.uuid))
			throw new InputError(
				'unsupported',
				'Repeated Claude message identity requires correction semantics',
			);
		seen.add(v.uuid);
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
			native_id: v.uuid,
			parent_id:
				typeof v.parentUuid === 'string' ? v.parentUuid : null,
			role: String(v.type),
			content,
			timestamp:
				typeof v.timestamp === 'string' &&
				Number.isFinite(Date.parse(v.timestamp))
					? new Date(v.timestamp).toISOString()
					: result.timestamp,
			source_order: byte_offset,
			active: true,
			turn_id: null,
		});
	}
	preserve_records(records, result, 'claude');
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
