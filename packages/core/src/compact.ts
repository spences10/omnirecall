import type {
	Archive,
	ArchivedMessage,
	LocatedMessage,
	MessageContext,
	SearchMatch,
	SessionMatch,
	SessionRecord,
} from './database.ts';
import { message_ref } from './refs.ts';

export const excerpt_chars = 1200;
const snippet_chars = 600;
const label_chars = 200;
const outline_chars = 160;

function clip(value: string, max: number) {
	const characters = Array.from(value);
	return {
		text: characters.slice(0, max).join(''),
		truncated: characters.length > max,
	};
}

function snippet(match: SearchMatch) {
	const { text, truncated } = clip(match.snippet, snippet_chars);
	return { snippet: text, snippet_truncated: truncated };
}

function part_state(message: ArchivedMessage) {
	return {
		kind: message.kind ?? 'message',
		state: message.state ?? (message.active ? 'active' : 'inactive'),
		representation: message.representation ?? 'primary',
	};
}

function session_label(session: LocatedMessage | SessionRecord) {
	return {
		agent: session.agent,
		title: session.title?.slice(0, label_chars) ?? null,
		title_truncated: (session.title?.length ?? 0) > label_chars,
		project: session.project.slice(0, label_chars),
		project_truncated: session.project.length > label_chars,
	};
}

function session_metadata(message: LocatedMessage | SessionRecord) {
	return {
		...session_label(message),
		source_path: message.source_path,
		source_status: message.source_status,
		source_checked_at: message.source_checked_at,
		path_status: message.path_status,
	};
}

export function compact_message(
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
		...part_state(message),
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

export function attribution(message: LocatedMessage) {
	return {
		ref: message_ref(message),
		...session_metadata(message),
		timestamp: message.timestamp,
		role: message.role,
		...part_state(message),
		active: Boolean(message.active),
	};
}

/** One-line row for outline and evidence listings. */
export function summary_row(
	row: ArchivedMessage,
	line: string,
	abridged = false,
) {
	const { text, truncated } = clip(line, outline_chars);
	return {
		ref: message_ref(row),
		kind: row.kind ?? 'message',
		timestamp: row.timestamp,
		text,
		text_truncated:
			Boolean(row.content_truncated) || truncated || abridged,
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
		...snippet(match),
	}));
}

// Session discovery rows stay small: no paths, statuses or message state.
export function compact_session_matches(matches: SessionMatch[]) {
	return matches.map((match) => ({
		short_id: match.short_id,
		hits: match.hits,
		last_hit: match.last_hit,
		...session_label(match),
		ref: message_ref(match),
		...snippet(match),
	}));
}

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
			return summary_row(row, line, row.content.trim() !== line);
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
			...(needs_snippet ? snippet(match) : {}),
			before: match.before.map(message_ref),
			after: match.after.map(message_ref),
			branch_boundary: match.branch_boundary,
		};
	});
	return { results, messages: [...messages.values()] };
}
