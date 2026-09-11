export type Agent = string;
export type JsonObject = Record<string, unknown>;

export interface Message {
	native_id: string;
	parent_id: string | null;
	role: string;
	kind?: string;
	record_key?: string;
	json_pointer?: string;
	representation?: string;
	state?: string;
	content: string;
	timestamp: string | null;
	source_order: number;
	active: boolean;
	turn_id: string | null;
}

export interface Transcript {
	inactive_turns?: string[];
	session_key?: string;
	native_id: string;
	project: string;
	title: string | null;
	parent_session: string | null;
	timestamp: string;
	messages: Message[];
	unindexed_records: number;
	records?: EvidenceRecord[];
	parts?: Message[];
	links?: EvidenceLink[];
}

export interface Source {
	source_id: string;
	agent: Agent;
	root: string;
}

export interface RecordLine {
	value: JsonObject;
	byte_offset: number;
	raw_json?: string;
}

export interface ImportUnit {
	key: string;
	locators: string[];
}
export interface ImportInput {
	path: string;
	hash: string;
	byte_offset: number;
	partial: boolean;
}
export interface ImportResult {
	sessions: Transcript[];
	inputs: ImportInput[];
}
export interface Adapter {
	parser_version: number;
	agent: Agent;
	discover(root: string): Promise<ImportUnit[]>;
	read(unit: ImportUnit): Promise<ImportResult>;
	// Opt in only when this token covers all inputs affecting read(), including interpretation.
	fingerprint?(unit: ImportUnit): Promise<string | undefined>;
	titles?(root: string): Promise<Map<string, string>>;
}
export interface JsonlAdapter extends Adapter {
	parse(records: RecordLine[], path?: string): Transcript;
}

export class InputError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export function object(value: unknown): JsonObject {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new InputError('invalid', 'Expected an object');
	return value as JsonObject;
}

export function text(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value.length > 4096
	)
		throw new InputError('invalid', 'Expected a nonempty string');
	return value;
}

export function metadata(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string' || value.length > 4096)
		throw new InputError(
			'invalid',
			'Metadata must be a string of at most 4096 characters',
		);
	return value;
}

export function date(value: unknown): string {
	const timestamp = Date.parse(text(value));
	if (!Number.isFinite(timestamp))
		throw new InputError('invalid', 'Invalid timestamp');
	return new Date(timestamp).toISOString();
}

export function dialogue(
	value: unknown,
	omitted_types: readonly string[] = [],
): string {
	if (typeof value === 'string') return value;
	if (!Array.isArray(value))
		throw new InputError('invalid', 'Expected message content');
	return value
		.flatMap((part: unknown) => {
			const block = object(part);
			if (block.type !== 'text') {
				if (
					typeof block.type === 'string' &&
					omitted_types.includes(block.type)
				)
					return [];
				throw new InputError(
					'unsupported',
					'Unknown dialogue content block type',
				);
			}
			if (typeof block.text !== 'string')
				throw new InputError('invalid', 'Invalid text block');
			return [block.text];
		})
		.join('\n');
}

export interface EvidenceRecord {
	input_path?: string;
	key: string;
	native_id: string | null;
	native_type: string | null;
	timestamp: string | null;
	source_order: number;
	raw_json: string;
}
export interface EvidenceLink {
	record_key: string;
	kind: string;
	namespace: string;
	target: string;
}
