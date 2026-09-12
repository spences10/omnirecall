import { Archive } from './database.ts';
import { digest } from './files.ts';
import { type SyncCache } from './sync-cache.ts';
import {
	InputError,
	type Adapter,
	type ImportResult,
	type ImportUnit,
	type Source,
} from './types.ts';
import {
	import_schema,
	metadata_schema,
	validate,
} from './validation.ts';
export function error_code(error: unknown): string {
	const code = (error as NodeJS.ErrnoException)?.code;
	if (error instanceof InputError) return error.code;
	return code === 'ENOENT'
		? 'missing'
		: code === 'EACCES' || code === 'EPERM'
			? 'blocked'
			: 'error';
}
export interface SyncProgress {
	phase: 'discovering' | 'checking' | 'importing' | 'source_done';
	agent: string;
	source_index: number;
	source_count: number;
	completed: number;
	total: number;
	files_indexed: number;
	files_skipped?: number;
	failures: number;
}

export async function sync(
	archive: Archive,
	sources: Source[],
	adapters: Adapter[],
	on_progress?: (progress: SyncProgress) => void,
) {
	const result = {
		status: 'ok',
		files_scanned: 0,
		files_indexed: 0,
		files_skipped: 0,
		sessions_updated: 0,
		partial_files: 0,
		failures: 0,
		operational_failures: 0,
		unindexed_records: 0,
		issues: [] as {
			source_id: string;
			path: string;
			code: string;
			message: string;
		}[],
		issues_truncated: false,
		issue_counts: [] as {
			agent: string;
			code: string;
			count: number;
		}[],
	};
	const issue = (source: Source, path: string, error: unknown) => {
		const code = error_code(error);
		const group = result.issue_counts.find(
			(group) => group.agent === source.agent && group.code === code,
		);
		if (group) group.count++;
		else
			result.issue_counts.push({
				agent: source.agent,
				code,
				count: 1,
			});
		result.failures++;
		if (error_code(error) === 'error') result.operational_failures++;
		if (result.issues.length < 100)
			result.issues.push({
				source_id: source.source_id,
				path,
				code: error_code(error),
				message:
					error instanceof Error ? error.message : 'Import failed',
			});
		else result.issues_truncated = true;
	};

	for (const [source_index, source] of sources.entries()) {
		const report = (
			phase: SyncProgress['phase'],
			completed = 0,
			total = 0,
		) =>
			on_progress?.({
				phase,
				agent: source.agent,
				source_index: source_index + 1,
				source_count: sources.length,
				completed,
				total,
				files_indexed: result.files_indexed,
				files_skipped: result.files_skipped,
				failures: result.failures,
			});
		report('discovering');
		const adapter = adapters.find((a) => a.agent === source.agent);
		if (!adapter)
			throw new InputError('unsupported', 'Missing adapter');
		archive.register(source, 'checking');
		let units: ImportUnit[];
		try {
			units = await adapter.discover(source.root);
		} catch (e) {
			archive.register(source, error_code(e));
			issue(source, source.root, e);
			report('source_done');
			continue;
		}
		const failures = result.failures,
			partial = result.partial_files;
		archive.reconcile_paths(
			source,
			new Set(units.flatMap((u) => u.locators)),
		);
		report('checking', 0, units.length);
		let titles = new Map<string, string>();
		try {
			titles = (await adapter.titles?.(source.root)) ?? titles;
		} catch (e) {
			issue(source, source.root, e);
		}
		const read = async (unit: ImportUnit) => {
			const batch = validate(
				import_schema,
				await adapter.read(
					unit,
					(() => {
						const cached = archive.checkpoint(source, unit.key);
						if (
							!cached ||
							cached.sessions.length !== 1 ||
							cached.inputs.length !== 1 ||
							cached.parser_version !== adapter.parser_version
						)
							return undefined;
						return {
							input: cached.inputs[0]!,
							records: () =>
								archive.record_lines(cached.sessions[0]!.archive_id),
						};
					})(),
				),
				`Adapter ${adapter.agent} output`,
			);
			if (!batch.inputs.length || !batch.sessions.length)
				throw new InputError(
					'unsupported',
					'Import unit contains no supported sessions or inputs',
				);
			for (const session of batch.sessions)
				for (const record of session.records ?? []) {
					if (batch.inputs.length > 1 && !record.input_path)
						throw new InputError(
							'invalid',
							'Multi-input records require input provenance',
						);
					if (
						record.input_path &&
						!batch.inputs.some((i) => i.path === record.input_path)
					)
						throw new InputError(
							'invalid',
							'Record references an unknown input',
						);
				}
			for (const session of batch.sessions)
				session.title = validate(
					metadata_schema,
					titles.get(session.native_id) ?? session.title,
					`Adapter ${adapter.agent} title`,
				);
			return batch;
		};
		const serialized = (value: unknown) =>
			JSON.stringify(value, (key, value) =>
				key === 'input_path' ? undefined : value,
			);
		const summaries = (batch: ImportResult) =>
			batch.sessions.map((session) => ({
				key: session.session_key ?? session.native_id,
				hash: digest(serialized(session)),
			}));
		const title_hash = digest(
			JSON.stringify(
				[...titles].sort(([a], [b]) => a.localeCompare(b)),
			),
		);
		const signature = (unit: ImportUnit, fingerprint: string) =>
			`1:${adapter.parser_version}:${digest(JSON.stringify([unit.locators, title_hash, fingerprint]))}`;

		const refreshed: SyncCache[] = [];
		for (const [index, unit] of units.entries()) {
			result.files_scanned += unit.locators.length;
			report('importing', index, units.length);
			try {
				const fingerprint = await adapter.fingerprint?.(unit);
				const token =
					fingerprint === undefined
						? undefined
						: signature(unit, fingerprint);
				const cached =
					token === undefined
						? undefined
						: archive.cached(source, unit.key, token);
				if (cached) {
					refreshed.push(cached);
					result.files_skipped += cached.inputs.length;
					result.files_indexed += cached.inputs.length;
					result.partial_files += cached.inputs.filter(
						(i) => i.partial,
					).length;
					result.unindexed_records += cached.sessions.reduce(
						(n, s) => n + s.unindexed_records,
						0,
					);
					continue;
				}
				const batch = await read(unit);
				if (
					fingerprint === undefined &&
					JSON.stringify(summaries(await read(unit))) !==
						JSON.stringify(summaries(batch))
				)
					throw new InputError(
						'changed',
						'Source changed during import; retry sync',
					);
				if (
					fingerprint !== undefined &&
					(await adapter.fingerprint!(unit)) !== fingerprint
				)
					throw new InputError(
						'changed',
						'Source changed during import; retry sync',
					);
				const cache: SyncCache = {
					sessions: [],
					inputs: batch.inputs,
					parser_version: adapter.parser_version,
				};
				let added = 0;
				const batch_summaries = summaries(batch);
				archive.atomic(() => {
					for (const [i, session] of batch.sessions.entries()) {
						const summary = batch_summaries[i]!;
						// Qualify identity consistently by import unit, including on the first import.
						session.session_key = JSON.stringify([
							unit.key,
							session.session_key ?? session.native_id,
						]);
						const stored = archive.store(
							source,
							batch.inputs[0]!.path,
							session,
							{
								parser_version: adapter.parser_version,
								hash: summary.hash,
								byte_offset: batch.inputs[0]!.byte_offset,
								partial: batch.inputs.some((i) => i.partial),
								inputs: batch.inputs,
								append: batch.append,
							},
						);
						if (stored.added) added++;
						cache.sessions.push({
							...summary,
							native_id: session.native_id,
							session_id: stored.session_id,
							archive_id: stored.archive_id,
							unindexed_records: session.unindexed_records,
						});
					}
					if (token !== undefined)
						archive.cache(source, unit.key, token, cache);
				});
				result.sessions_updated += added;
				result.files_indexed += batch.inputs.length;
				result.partial_files += batch.inputs.filter(
					(i) => i.partial,
				).length;
				result.unindexed_records += batch.sessions.reduce(
					(n, s) => n + s.unindexed_records,
					0,
				);
			} catch (error) {
				for (const path of unit.locators)
					archive.path_status(source, path, error_code(error));
				issue(source, unit.key, error);
			}
		}
		archive.atomic(() => {
			for (const cached of refreshed)
				archive.refresh_cached(source, cached);
		});
		report('source_done', units.length, units.length);

		archive.register(
			source,
			result.failures !== failures || result.partial_files !== partial
				? 'partial'
				: 'available',
		);
	}
	result.status =
		result.operational_failures && !result.files_indexed
			? 'error'
			: result.failures || result.partial_files
				? 'partial'
				: 'ok';
	return result;
}
