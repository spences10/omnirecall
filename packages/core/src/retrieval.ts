import { createHash } from 'node:crypto';
import type {
	Archive,
	ArchivedMessage,
	LocatedMessage,
	MessageContext,
	SearchMatch,
	SessionMatch,
	SessionRecord,
} from './database.ts';
import { InputError } from './types.ts';

export const excerpt_chars = 1200;

export function message_ref(message: {
	archive_id: string;
	native_id: string;
}): string {
	return `m1.${message.archive_id}.${Buffer.from(message.native_id).toString('base64url')}`;
}

export function parse_ref(ref: string) {
	const match = /^[mr]1\.([a-f0-9]{64})\.([A-Za-z0-9_-]+)$/.exec(ref);
	if (match && ref.length <= 22000) {
		const native_id = Buffer.from(match[2]!, 'base64url').toString(
			'utf8',
		);
		const identity = { archive_id: match[1]!, native_id };
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

const short_pattern =
	/^([mr])2\.([a-f0-9]{12,64})\.([A-Za-z0-9_-]{1,4096})$/;

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
			typeof ref === 'string'
				? /^([mr])1\.([a-f0-9]{64})\.([A-Za-z0-9_-]+)$/.exec(ref)
				: null;
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

function compact_message(
	message: ArchivedMessage,
	char_offset = 0,
	chars = excerpt_chars,
) {
	const characters = Array.from(message.content);
	const content = characters.slice(0, chars).join('');
	const content_truncated =
		Boolean(message.content_truncated) || characters.length > chars;
	return {
		ref: message_ref(message),
		role: message.role,
		kind: message.kind ?? 'message',
		state: message.state ?? (message.active ? 'active' : 'inactive'),
		representation: message.representation ?? 'primary',
		timestamp: message.timestamp,
		active: Boolean(message.active),
		content,
		char_offset,
		content_truncated,
		next_char_offset: content_truncated
			? char_offset + Math.min(characters.length, chars)
			: null,
	};
}

function session_metadata(message: LocatedMessage | SessionRecord) {
	return {
		agent: message.agent,
		title: message.title?.slice(0, 200) ?? null,
		title_truncated: (message.title?.length ?? 0) > 200,
		project: message.project.slice(0, 200),
		project_truncated: message.project.length > 200,
		source_path: message.source_path,
		source_status: message.source_status,
		source_checked_at: message.source_checked_at,
		path_status: message.path_status,
	};
}

function attribution(message: LocatedMessage) {
	return {
		ref: message_ref(message),
		...session_metadata(message),
		timestamp: message.timestamp,
		role: message.role,
		kind: message.kind ?? 'message',
		state: message.state ?? (message.active ? 'active' : 'inactive'),
		representation: message.representation ?? 'primary',
		active: Boolean(message.active),
	};
}

export function compact_sessions(
	rows: ReturnType<Archive['sessions']>,
) {
	return rows.map((row) => ({
		...session_metadata(row),
		short_id: row.short_id,
		timestamp: row.timestamp,
		parent_session: row.parent_session,
		unindexed_records: row.unindexed_records,
		first_record_ref: row.first_record_ref,
	}));
}

export function compact_search(matches: SearchMatch[]) {
	return matches.map((match) => ({
		...attribution(match),
		char_offset: match.char_offset,
		snippet: Array.from(match.snippet).slice(0, 600).join(''),
		snippet_truncated: Array.from(match.snippet).length > 600,
	}));
}

// Session discovery rows stay small: no paths, statuses or message state.
export function compact_session_matches(matches: SessionMatch[]) {
	return matches.map((match) => ({
		short_id: match.short_id,
		hits: match.hits,
		last_hit: match.last_hit,
		agent: match.agent,
		title: match.title?.slice(0, 200) ?? null,
		title_truncated: (match.title?.length ?? 0) > 200,
		project: match.project.slice(0, 200),
		project_truncated: match.project.length > 200,
		ref: message_ref(match),
		snippet: Array.from(match.snippet).slice(0, 600).join(''),
		snippet_truncated: Array.from(match.snippet).length > 600,
	}));
}

const outline_chars = 160;

export function compact_outline(
	outline: ReturnType<Archive['outline']>,
) {
	return {
		session: {
			...compact_sessions([outline.session])[0]!,
			parts: outline.parts,
		},
		results: outline.rows.map((row) => {
			const line =
				row.content
					.split('\n')
					.find((text) => text.trim())
					?.trim() ?? '';
			const characters = Array.from(line);
			return {
				ref: message_ref(row),
				kind: row.kind ?? 'message',
				timestamp: row.timestamp,
				text: characters.slice(0, outline_chars).join(''),
				text_truncated:
					Boolean(row.content_truncated) ||
					characters.length > outline_chars ||
					row.content.trim() !== line,
			};
		}),
	};
}

/** Tool activity in the turn that contains the referenced message. */
export function turn_evidence(
	archive: Archive,
	ref: string,
	limit: number,
	offset: number,
) {
	const identity = resolve_ref(archive, ref);
	const evidence = archive.evidence(
		identity.archive_id,
		identity.native_id,
		{ limit, offset },
	);
	if (!evidence)
		throw new InputError(
			'not_found',
			'Message reference not found in this archive',
		);
	return {
		turn: {
			prompt_ref: evidence.prompt
				? message_ref(evidence.prompt)
				: null,
			next_prompt_ref: evidence.next_prompt
				? message_ref(evidence.next_prompt)
				: null,
		},
		rows: evidence.rows.map((row) => {
			const line = row.content.replace(/\s+/g, ' ').trim();
			const characters = Array.from(line);
			return {
				ref: message_ref(row),
				kind: row.kind ?? 'message',
				timestamp: row.timestamp,
				text: characters.slice(0, outline_chars).join(''),
				text_truncated:
					Boolean(row.content_truncated) ||
					characters.length > outline_chars,
			};
		}),
	};
}

export function compact_recall(
	matches: (SearchMatch & MessageContext)[],
) {
	const messages = new Map<
		string,
		ReturnType<typeof compact_message>
	>();
	const results = matches.map((match) => {
		for (const message of [...match.before, match, ...match.after])
			messages.set(message_ref(message), compact_message(message));
		const ref = message_ref(match);
		const message = messages.get(ref)!;
		// A truncated excerpt may omit the hit entirely. Keep its snippet unless
		// the returned content actually contains it (including any FTS ellipses).
		const needs_snippet =
			message.content_truncated &&
			!message.content.includes(match.snippet);
		return {
			ref,
			...session_metadata(match),
			char_offset: match.char_offset,
			...(needs_snippet
				? {
						snippet: Array.from(match.snippet).slice(0, 600).join(''),
						snippet_truncated: Array.from(match.snippet).length > 600,
					}
				: {}),
			before: match.before.map(message_ref),
			after: match.after.map(message_ref),
			branch_boundary: match.branch_boundary,
		};
	});
	return { results, messages: [...messages.values()] };
}

export function focused_read(
	archive: Archive,
	ref: string,
	context: number,
	char_offset: number,
	chars: number,
) {
	const identity = resolve_ref(archive, ref);
	const match = archive.read_message(
		identity.archive_id,
		identity.native_id,
		char_offset,
		chars,
	);
	if (!match)
		throw new InputError(
			'not_found',
			'Message reference not found in this archive',
		);
	if (char_offset > match.content_length)
		throw new InputError(
			'arguments',
			'Character offset exceeds message length',
		);
	const window = archive.context(
		identity.archive_id,
		identity.native_id,
		context + 1,
	);
	const before = context ? window.before.slice(-context) : [];
	const after = window.after.slice(0, context);
	return {
		results: [
			{
				...attribution(match),
				source_id: match.source_id,
				session_id: match.session_id,
				archive_id: match.archive_id,
				project: match.project,
				project_truncated: false,
				title: match.title,
				title_truncated: false,
				source_path: match.source_path,
				record_key: match.record_key,
				record_ref: match.record_key
					? record_ref(match.archive_id, match.record_key)
					: null,
				json_pointer: match.json_pointer,
				links: match.record_key
					? archive
							.record_links(match.archive_id, match.record_key)
							.slice(0, 20)
					: [],
				links_truncated: match.record_key
					? archive.record_links(match.archive_id, match.record_key)
							.length > 20
					: false,
				before: before.map(message_ref),
				after: after.map(message_ref),
				previous_ref:
					window.before.length > context
						? message_ref(window.before[0]!)
						: null,
				next_ref:
					window.after.length > context
						? message_ref(window.after[context]!)
						: null,
				branch_boundary: window.branch_boundary,
			},
		],
		messages: [
			...before.map((message) => compact_message(message, 0, chars)),
			compact_message(match, char_offset, chars),
			...after.map((message) => compact_message(message, 0, chars)),
		],
	};
}

export function raw_read(
	archive: Archive,
	ref: string,
	offset: number,
	chars: number,
) {
	const { archive_id, native_id } = resolve_ref(archive, ref);
	const row = archive.raw_record(
		archive_id,
		native_id,
		offset,
		chars,
		ref.startsWith('r'),
	);
	if (!row)
		throw new InputError(
			'not_found',
			'Original record is not available for this reference',
		);
	if (offset > row.content_length)
		throw new InputError(
			'arguments',
			'Character offset exceeds record length',
		);
	const next = offset + Array.from(row.content).length;
	return {
		results: [
			{
				ref,
				archive_id,
				record_key: row.record_key,
				record_ref: record_ref(archive_id, row.record_key),
				previous_ref:
					row.previous_key === null
						? null
						: record_ref(archive_id, row.previous_key),
				next_ref:
					row.next_key === null
						? null
						: record_ref(archive_id, row.next_key),
				native_type: row.native_type,
				content: row.content,
				char_offset: offset,
				content_truncated: next < row.content_length,
				next_char_offset: next < row.content_length ? next : null,
				format: 'raw_json_excerpt',
			},
		],
	};
}

export function record_ref(archive_id: string, key: string) {
	return `r1.${archive_id}.${Buffer.from(key).toString('base64url')}`;
}
