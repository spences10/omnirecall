import { codex_dialogue } from '../../adapter-shared/src/schemas.ts';
import { InputError } from '../../core/src/errors.ts';
import { text } from '../../core/src/readers.ts';
import type { JsonObject, Message } from '../../core/src/types.ts';

/** Turns and dialogue of one Codex thread, built by replaying its events. */
export function codex_thread(thread_id: string) {
	const turns: { id: string; active: boolean }[] = [];
	const messages = new Map<string, Message>();
	let current_turn: string | null = null;
	let previous_id: string | null = null;

	function ensure_turn(id: string) {
		const previous = turns.find((turn) => turn.id === id);
		if (previous && !previous.active)
			throw new InputError(
				'unsupported',
				'Reused rolled-back turn ID',
			);
		if (!previous) turns.push({ id, active: true });
	}

	return {
		messages: () => [...messages.values()],
		inactive_turns: () =>
			turns.filter((turn) => !turn.active).map((turn) => turn.id),

		begin_turn(id: unknown) {
			current_turn = text(id);
			ensure_turn(current_turn);
		},
		end_turn() {
			current_turn = null;
		},

		/** Deactivate the latest live turns and the dialogue they hold. */
		roll_back(count: unknown) {
			const live = turns.filter((turn) => turn.active);
			if (
				!Number.isSafeInteger(count) ||
				Number(count) < 0 ||
				Number(count) > live.length
			)
				throw new InputError(
					'unsupported',
					'Rollback cannot be resolved from available turns',
				);
			for (const turn of live.slice(live.length - Number(count)))
				turn.active = false;
			for (const message of messages.values())
				message.active = turns.some(
					(turn) => turn.id === message.turn_id && turn.active,
				);
			previous_id =
				[...messages.values()]
					.filter((message) => message.active)
					.at(-1)?.native_id ?? null;
			current_turn = null;
		},

		/**
		 * Record a completed user or agent message; a repeated item ID replaces
		 * its earlier text. Returns false when the content is not understood.
		 */
		complete(
			payload: JsonObject,
			item: JsonObject,
			role: 'user' | 'assistant',
			timestamp: string,
			byte_offset: number,
		): boolean {
			if (
				payload.thread_id !== undefined &&
				payload.thread_id !== thread_id
			)
				throw new InputError(
					'unsupported',
					'Completed item belongs to a different thread',
				);
			const turn_id =
				typeof payload.turn_id === 'string'
					? payload.turn_id
					: current_turn;
			if (!turn_id)
				throw new InputError(
					'unsupported',
					'Dialogue without a turn ID',
				);
			ensure_turn(turn_id);
			let content: string;
			try {
				content = codex_dialogue(item, byte_offset);
			} catch (error) {
				if (
					error instanceof InputError &&
					error.code === 'unsupported'
				)
					return false;
				throw error;
			}
			const id = text(item.id);
			const previous = messages.get(id);
			if (previous) {
				if (previous.turn_id !== turn_id || previous.role !== role)
					throw new InputError(
						'unsupported',
						'Conflicting completed item identity',
					);
				previous.content = content;
				previous.timestamp = timestamp;
				previous.source_order = byte_offset;
			} else if (content.trim()) {
				messages.set(id, {
					native_id: id,
					parent_id: previous_id,
					role,
					content,
					timestamp,
					source_order: byte_offset,
					active: true,
					turn_id,
				});
				previous_id = id;
			}
			return true;
		},
	};
}
