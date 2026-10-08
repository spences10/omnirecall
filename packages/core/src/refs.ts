import { createHash } from 'node:crypto';
import type { Archive } from './database.ts';
import { InputError } from './errors.ts';

const canonical_pattern =
	/^([mr])1\.([a-f0-9]{64})\.([A-Za-z0-9_-]+)$/;
const short_pattern =
	/^([mr])2\.([a-f0-9]{12,64})\.([A-Za-z0-9_-]{1,4096})$/;

export function message_ref(message: {
	archive_id: string;
	native_id: string;
}): string {
	return `m1.${message.archive_id}.${Buffer.from(message.native_id).toString('base64url')}`;
}

export function record_ref(archive_id: string, key: string) {
	return `r1.${archive_id}.${Buffer.from(key).toString('base64url')}`;
}

export function parse_ref(ref: string) {
	const match = canonical_pattern.exec(ref);
	if (match && ref.length <= 22000) {
		const native_id = Buffer.from(match[3]!, 'base64url').toString(
			'utf8',
		);
		const identity = { archive_id: match[2]!, native_id };
		if (
			native_id.trim() &&
			native_id.length <= 4096 &&
			message_ref(identity).slice(2) === ref.slice(2)
		)
			return identity;
	}
	throw new InputError(
		'arguments',
		'Invalid message reference; copy ref from search results',
	);
}

function native_digest(native_id: string) {
	return createHash('sha256')
		.update(native_id)
		.digest('base64url')
		.slice(0, 11);
}

export function is_short_ref(ref: string) {
	return short_pattern.test(ref);
}

/** Resolve a canonical or short reference to its archived identity. */
export function resolve_ref(archive: Archive, ref: string) {
	const short = short_pattern.exec(ref);
	if (!short) return parse_ref(ref);
	const [archive_id, other] = archive.archive_ids(short[2]!);
	if (!archive_id)
		throw new InputError(
			'not_found',
			'Reference not found in this archive',
		);
	if (other)
		throw new InputError(
			'arguments',
			'Ambiguous short reference; repeat the search for a current ref',
		);
	if (short[1] === 'r')
		return {
			archive_id,
			native_id: Buffer.from(short[3]!, 'base64url').toString('utf8'),
		};
	const matches = archive
		.part_ids(archive_id)
		.filter((native_id) => native_digest(native_id) === short[3]);
	if (!matches.length)
		throw new InputError(
			'not_found',
			'Message reference not found in this archive',
		);
	if (matches.length > 1)
		throw new InputError(
			'arguments',
			'Ambiguous short reference; repeat the search for a current ref',
		);
	return { archive_id, native_id: matches[0]! };
}

const ref_fields = new Set([
	'ref',
	'record_ref',
	'previous_ref',
	'next_ref',
	'first_record_ref',
	'prompt_ref',
	'next_prompt_ref',
	'before',
	'after',
]);

/** Rewrite canonical references in compact output to their short form. */
export function short_refs<T>(archive: Archive, value: T): T {
	const short_ids = new Map<string, string>();
	const shorten = (ref: unknown) => {
		const match =
			typeof ref === 'string' ? canonical_pattern.exec(ref) : null;
		if (!match) return ref;
		const archive_id = match[2]!;
		let short_id = short_ids.get(archive_id);
		if (!short_id) {
			short_id = archive.short_id(archive_id);
			short_ids.set(archive_id, short_id);
		}
		return match[1] === 'r'
			? `r2.${short_id}.${match[3]}`
			: `m2.${short_id}.${native_digest(parse_ref(match[0]).native_id)}`;
	};
	const walk = (item: unknown): unknown => {
		if (Array.isArray(item)) return item.map(walk);
		if (!item || typeof item !== 'object') return item;
		return Object.fromEntries(
			Object.entries(item).map(([key, entry]) => [
				key,
				!ref_fields.has(key)
					? walk(entry)
					: Array.isArray(entry)
						? entry.map(shorten)
						: shorten(entry),
			]),
		);
	};
	return walk(value) as T;
}
