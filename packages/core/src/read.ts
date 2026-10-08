import {
	attribution,
	compact_message,
	summary_row,
} from './compact.ts';
import type { Archive } from './database.ts';
import { InputError } from './errors.ts';
import { message_ref, record_ref, resolve_ref } from './refs.ts';

const max_links = 20;

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
		rows: evidence.rows.map((row) =>
			summary_row(row, row.content.replace(/\s+/g, ' ').trim()),
		),
	};
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
	const links = match.record_key
		? archive.record_links(match.archive_id, match.record_key)
		: [];
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
				links: links.slice(0, max_links),
				links_truncated: links.length > max_links,
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

/** Default read output: the content, how to continue, and where it sits. */
export function slim_read(
	archive: Archive,
	read: ReturnType<typeof focused_read> | ReturnType<typeof raw_read>,
) {
	if (!('messages' in read)) {
		const {
			archive_id: _archive,
			record_key: _key,
			...row
		} = read.results[0]!;
		return { results: [row] };
	}
	const row = read.results[0]!;
	return {
		results: [
			{
				ref: row.ref,
				short_id: archive.short_id(row.archive_id),
				agent: row.agent,
				title: row.title,
				project: row.project,
				record_ref: row.record_ref,
				before: row.before,
				after: row.after,
				previous_ref: row.previous_ref,
				next_ref: row.next_ref,
				branch_boundary: row.branch_boundary,
			},
		],
		messages: read.messages,
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
