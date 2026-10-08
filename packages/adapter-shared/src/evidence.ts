import { all_parts, iso_timestamp } from '../../core/src/readers.ts';
import type {
	JsonObject,
	Message,
	RecordLine,
	Transcript,
} from '../../core/src/types.ts';

// Lenient readers: evidence is kept even where dialogue parsing is strict.
export const obj = (value: unknown): JsonObject =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as JsonObject)
		: {};
export const str = (value: unknown) =>
	typeof value === 'string' ? value : null;
export function readable(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value))
		return value.map(readable).filter(Boolean).join('\n');
	const block = obj(value);
	return str(block.text) ?? str(block.thinking) ?? '';
}
export function tool_call_text(name: unknown, input: unknown) {
	return `${str(name) ?? ''}\n${typeof input === 'string' ? input : JSON.stringify(input ?? null)}`;
}

/** One original record, and how to attach searchable parts and links to it. */
export interface RecordParts {
	value: JsonObject;
	/** The dialogue message the adapter already took from this record. */
	original: Message | undefined;
	/** Blank content adds nothing. `call` pairs tool calls with their results. */
	add: (
		kind: string,
		content: string,
		pointer: string,
		role?: string,
		call?: string,
	) => Message | undefined;
	/** Non-string targets add nothing. */
	link: (kind: string, namespace: string, target: unknown) => void;
}

export interface EvidenceFormat {
	/** JSON pointer to dialogue content within a record. */
	dialogue_pointer: string;
	/** Called once per record, in source order. Defaults to active, no turn. */
	position?(value: JsonObject): {
		active: boolean;
		turn_id: string | null;
	};
	extract(record: RecordParts): void;
}

/** Count the records that produced no searchable message or part. */
export function tally_unindexed(transcript: Transcript) {
	const indexed = new Set(
		all_parts(transcript).map((part) => part.record_key),
	);
	transcript.unindexed_records = (transcript.records ?? []).filter(
		(record) => !indexed.has(record.key),
	).length;
}

/** Preserve envelopes independently of the searchable interpretation. */
export function preserve_records(
	lines: RecordLine[],
	transcript: Transcript,
	format: EvidenceFormat,
): Transcript {
	const records = lines.map(({ value, byte_offset, raw_json }) => ({
		key: String(byte_offset),
		native_id: str(value.id) ?? str(value.uuid),
		native_type: str(value.type),
		timestamp: iso_timestamp(value.timestamp),
		source_order: byte_offset,
		raw_json: raw_json ?? JSON.stringify(value),
	}));
	const parts: Message[] = [];
	const links: NonNullable<Transcript['links']> = [];
	transcript.records = records;
	transcript.parts = parts;
	transcript.links = links;
	const calls = new Map<string, Message[]>();
	const results: { part: Message; call: string }[] = [];
	const dialogue_by_order = new Map(
		transcript.messages.map((m) => [m.source_order, m]),
	);
	for (const [index, line] of lines.entries()) {
		const key = String(line.byte_offset);
		const { active, turn_id } = format.position?.(line.value) ?? {
			active: true,
			turn_id: null,
		};
		const original = dialogue_by_order.get(line.byte_offset);
		if (original) {
			original.kind = 'message';
			original.record_key = key;
			original.json_pointer = format.dialogue_pointer;
		}
		const timestamp = records[index]!.timestamp;
		format.extract({
			value: line.value,
			original,
			add(kind, content, pointer, role = kind, call) {
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
					turn_id,
					record_key: key,
					json_pointer: pointer,
				};
				parts.push(part);
				if (call && kind === 'tool_call')
					calls.set(call, [...(calls.get(call) ?? []), part]);
				if (call && kind === 'tool_result')
					results.push({ part, call });
				return part;
			},
			link(kind, namespace, target) {
				if (typeof target === 'string')
					links.push({ record_key: key, kind, namespace, target });
			},
		});
	}
	// A native call ID can be ambiguous; never pick a call by proximity alone.
	for (const { part, call } of results) {
		const candidates = calls.get(call) ?? [];
		if (candidates.length === 1)
			part.parent_id = candidates[0]!.native_id;
	}
	tally_unindexed(transcript);
	return transcript;
}
