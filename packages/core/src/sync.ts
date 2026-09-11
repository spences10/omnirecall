import { Archive } from './database.ts';
import { digest } from './files.ts';
import { ImportStage, type SyncCache } from './sync-cache.ts';
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
		revisions_added: 0,
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
	};
	const issue = (source: Source, path: string, error: unknown) => {
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
	const stage = new ImportStage();
	try {
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
					await adapter.read(unit),
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
			type Candidate = {
				unit: ImportUnit;
				fingerprint?: string;
				signature?: string;
				staged?: string;
				cached?: SyncCache;
				summaries: { key: string; hash: string }[];
			};
			const candidates: Candidate[] = [];
			const identities = new Map<string, Set<string>>();
			for (const [index, unit] of units.entries()) {
				result.files_scanned += unit.locators.length;
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
					let candidate: Candidate;
					if (cached)
						candidate = {
							unit,
							fingerprint,
							signature: token,
							cached,
							summaries: cached.sessions,
						};
					else {
						const batch = await read(unit);
						if (
							fingerprint !== undefined &&
							(await adapter.fingerprint!(unit)) !== fingerprint
						)
							throw new InputError(
								'changed',
								'Source changed during parsing; retry sync',
							);
						candidate = {
							unit,
							fingerprint,
							signature: token,
							summaries: summaries(batch),
							staged:
								fingerprint === undefined
									? undefined
									: await stage.put(batch),
						};
					}
					candidates.push(candidate);
					for (const session of candidate.summaries) {
						const hashes =
							identities.get(session.key) ?? new Set<string>();
						hashes.add(session.hash);
						identities.set(session.key, hashes);
					}
				} catch (e) {
					for (const path of unit.locators)
						archive.path_status(source, path, error_code(e));
					issue(source, unit.key, e);
				}
				report('checking', index + 1, units.length);
			}
			report('importing', 0, candidates.length);
			const refreshed: SyncCache[] = [];
			for (const [index, candidate] of candidates.entries()) {
				try {
					if (
						candidate.fingerprint !== undefined &&
						(await adapter.fingerprint!(candidate.unit)) !==
							candidate.fingerprint
					)
						throw new InputError(
							'changed',
							'Source changed between discovery and ingestion; retry sync',
						);
					for (const session of candidate.summaries)
						if (identities.get(session.key)!.size > 1)
							throw new InputError(
								'conflict',
								'Divergent inputs share a native session ID; no revision selected',
							);
					if (candidate.cached) {
						refreshed.push(candidate.cached);
						result.files_skipped += candidate.cached.inputs.length;
						result.files_indexed += candidate.cached.inputs.length;
						result.partial_files += candidate.cached.inputs.filter(
							(input) => input.partial,
						).length;
						result.unindexed_records +=
							candidate.cached.sessions.reduce(
								(n, session) => n + session.unindexed_records,
								0,
							);
					} else {
						const batch = candidate.staged
							? await stage.take(candidate.staged)
							: await read(candidate.unit);
						if (
							candidate.staged &&
							(await adapter.fingerprint!(candidate.unit)) !==
								candidate.fingerprint
						)
							throw new InputError(
								'changed',
								'Source changed while loading staged data; retry sync',
							);
						// Adapters without a fingerprint contract retain the original two-read safeguard.
						if (
							!candidate.staged &&
							JSON.stringify(summaries(batch)) !==
								JSON.stringify(candidate.summaries)
						)
							throw new InputError(
								'changed',
								'Source changed between discovery and ingestion; retry sync',
							);
						const cached: SyncCache = {
							sessions: [],
							inputs: batch.inputs,
						};
						let added = 0,
							unindexed = 0;
						archive.atomic(() => {
							for (const [
								session_index,
								session,
							] of batch.sessions.entries()) {
								const summary = candidate.summaries[session_index]!;
								const stored = archive.store(
									source,
									batch.inputs[0]!.path,
									session,
									{
										parser_version: adapter.parser_version,
										hash: summary.hash,
										byte_offset: batch.inputs[0]!.byte_offset,
										partial: batch.inputs.some(
											(input) => input.partial,
										),
										inputs: batch.inputs,
									},
								);
								if (stored.added) added++;
								unindexed += session.unindexed_records;
								cached.sessions.push({
									...summary,
									native_id: session.native_id,
									session_id: stored.session_id,
									revision_id: stored.revision_id,
									unindexed_records: session.unindexed_records,
								});
							}
							if (candidate.signature !== undefined)
								archive.cache(
									source,
									candidate.unit.key,
									candidate.signature,
									cached,
								);
						});
						result.revisions_added += added;
						result.unindexed_records += unindexed;
						result.files_indexed += batch.inputs.length;
						result.partial_files += batch.inputs.filter(
							(input) => input.partial,
						).length;
					}
				} catch (e) {
					for (const path of candidate.unit.locators)
						archive.path_status(source, path, error_code(e));
					issue(source, candidate.unit.key, e);
				}
				report('importing', index + 1, candidates.length);
			}
			// Refresh provenance timestamps in one transaction rather than one commit per unchanged file.
			archive.atomic(() => {
				for (const cached of refreshed)
					archive.refresh_cached(source, cached);
			});

			report('source_done', candidates.length, candidates.length);
			archive.register(
				source,
				result.failures !== failures ||
					result.partial_files !== partial
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
	} finally {
		await stage.close();
	}
}
