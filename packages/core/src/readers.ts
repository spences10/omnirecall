import { InputError } from './errors.ts';
import type { JsonObject, Message, Transcript } from './types.ts';

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

/** A lenient reading: anything that is not a valid timestamp is absent. */
export function iso_timestamp(value: unknown): string | null {
	return typeof value === 'string' &&
		Number.isFinite(Date.parse(value))
		? new Date(value).toISOString()
		: null;
}

export function dialogue(
	value: unknown,
	omitted_types: readonly string[] = [],
	allow_unknown = false,
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
					(allow_unknown || omitted_types.includes(block.type))
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

/** Dialogue messages followed by the other searchable parts. */
export function all_parts(
	transcript: Pick<Transcript, 'messages' | 'parts'>,
): Message[] {
	return [...transcript.messages, ...(transcript.parts ?? [])];
}
