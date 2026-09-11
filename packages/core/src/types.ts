export type Agent = 'pi' | 'codex';
export type JsonObject = Record<string, unknown>;

export interface Message {
	native_id: string;
	parent_id: string | null;
	role: 'user' | 'assistant';
	content: string;
	timestamp: string;
	source_order: number;
	active: boolean;
	turn_id: string | null;
}

export interface Transcript {
	native_id: string;
	project: string;
	title: string | null;
	parent_session: string | null;
	timestamp: string;
	messages: Message[];
	omitted_records: number;
}

export interface Source {
	source_id: string;
	agent: Agent;
	root: string;
}

export interface RecordLine {
	value: JsonObject;
	byte_offset: number;
}

export interface Adapter {
	agent: Agent;
	discover: (root: string) => Promise<string[]>;
	parse: (records: RecordLine[]) => Transcript;
	titles?: (root: string) => Promise<Map<string, string>>;
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
