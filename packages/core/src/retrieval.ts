import type {
	Archive,
	ArchivedMessage,
	LocatedMessage,
	MessageContext,
	SearchMatch,
} from './database.ts';
import { InputError } from './types.ts';

export const excerpt_chars = 1200;

export function message_ref(message: {
	revision_id: string;
	native_id: string;
}): string {
	return `m1.${message.revision_id}.${Buffer.from(message.native_id).toString('base64url')}`;
}

export function parse_ref(ref: string) {
	const match = /^m1\.([a-f0-9]{64})\.([A-Za-z0-9_-]+)$/.exec(ref);
	if (match && ref.length <= 22000) {
		const native_id = Buffer.from(match[2]!, 'base64url').toString(
			'utf8',
		);
		const identity = { revision_id: match[1]!, native_id };
		if (
			native_id.trim() &&
			native_id.length <= 4096 &&
			message_ref(identity) === ref
		)
			return identity;
	}
	throw new InputError(
		'arguments',
		'Invalid message reference; copy ref from search results',
	);
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

function attribution(message: LocatedMessage) {
	return {
		ref: message_ref(message),
		agent: message.agent,
		title: message.title?.slice(0, 200) ?? null,
		title_truncated: (message.title?.length ?? 0) > 200,
		project: message.project.slice(0, 200),
		project_truncated: message.project.length > 200,
		timestamp: message.timestamp,
		role: message.role,
		active: Boolean(message.active),
		current_revision: Boolean(message.current_revision),
		source_status: message.source_status,
		source_checked_at: message.source_checked_at,
		path_status: message.path_status,
	};
}

export function compact_search(matches: SearchMatch[]) {
	return matches.map((match) => ({
		...attribution(match),
		char_offset: match.char_offset,
		snippet: Array.from(match.snippet).slice(0, 600).join(''),
		snippet_truncated: Array.from(match.snippet).length > 600,
	}));
}

export function compact_recall(
	matches: (SearchMatch & MessageContext)[],
) {
	const messages = new Map<
		string,
		ReturnType<typeof compact_message>
	>();
	const results = compact_search(matches).map((result, index) => {
		const match = matches[index]!;
		for (const message of [...match.before, match, ...match.after])
			messages.set(message_ref(message), compact_message(message));
		return {
			...result,
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
	const identity = parse_ref(ref);
	const match = archive.read_message(
		identity.revision_id,
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
		identity.revision_id,
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
				revision_id: match.revision_id,
				project: match.project,
				project_truncated: false,
				title: match.title,
				title_truncated: false,
				source_path: match.source_path,
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
