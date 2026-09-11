import { Archive } from './database.ts';
import { digest } from './files.ts';
import {
	InputError,
	type Adapter,
	type ImportResult,
	type ImportUnit,
	type Source,
} from './types.ts';
export function error_code(error: unknown): string {
	const code = (error as NodeJS.ErrnoException)?.code;
	if (error instanceof InputError) return error.code;
	return code === 'ENOENT'
		? 'missing'
		: code === 'EACCES' || code === 'EPERM'
			? 'blocked'
			: 'error';
}
export async function sync(
	archive: Archive,
	sources: Source[],
	adapters: Adapter[],
) {
	const result = {
		status: 'ok',
		files_scanned: 0,
		files_indexed: 0,
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
	for (const source of sources) {
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
			continue;
		}
		const failures = result.failures,
			partial = result.partial_files;
		archive.reconcile_paths(
			source,
			new Set(units.flatMap((u) => u.locators)),
		);
		let titles = new Map<string, string>();
		try {
			titles = (await adapter.titles?.(source.root)) ?? titles;
		} catch (e) {
			issue(source, source.root, e);
		}
		const read = async (unit: ImportUnit) => {
			const batch = await adapter.read(unit);
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
				session.title =
					titles.get(session.native_id) ?? session.title;
			return batch;
		};
		const serialized = (value: unknown) =>
			JSON.stringify(value, (key, value) =>
				key === 'input_path' ? undefined : value,
			);
		const hash = (batch: ImportResult) =>
			digest(serialized(batch.sessions));
		const candidates: { unit: ImportUnit; hash: string }[] = [];
		const identities = new Map<string, Set<string>>();
		for (const unit of units) {
			result.files_scanned += unit.locators.length;
			try {
				const batch = await read(unit);
				candidates.push({ unit, hash: hash(batch) });
				for (const session of batch.sessions) {
					const hashes =
						identities.get(
							session.session_key ?? session.native_id,
						) ?? new Set<string>();
					hashes.add(digest(serialized(session)));
					identities.set(
						session.session_key ?? session.native_id,
						hashes,
					);
				}
			} catch (e) {
				for (const path of unit.locators)
					archive.path_status(source, path, error_code(e));
				issue(source, unit.key, e);
			}
		}
		for (const candidate of candidates) {
			try {
				const batch = await read(candidate.unit);
				if (hash(batch) !== candidate.hash)
					throw new InputError(
						'changed',
						'Source changed between discovery and ingestion; retry sync',
					);
				for (const session of batch.sessions) {
					if (
						identities.get(session.session_key ?? session.native_id)!
							.size > 1
					)
						throw new InputError(
							'conflict',
							'Divergent inputs share a native session ID; no revision selected',
						);
				}
				let added = 0,
					unindexed = 0;
				archive.atomic(() => {
					for (const session of batch.sessions) {
						const stored = archive.store(
							source,
							batch.inputs[0]!.path,
							session,
							{
								parser_version: adapter.parser_version,
								hash: digest(serialized(session)),
								byte_offset: batch.inputs[0]!.byte_offset,
								partial: batch.inputs.some((i) => i.partial),
								inputs: batch.inputs,
							},
						);
						if (stored.added) added++;
						unindexed += session.unindexed_records;
					}
				});
				result.revisions_added += added;
				result.unindexed_records += unindexed;
				result.files_indexed += batch.inputs.length;
				result.partial_files += batch.inputs.filter(
					(i) => i.partial,
				).length;
			} catch (e) {
				for (const path of candidate.unit.locators)
					archive.path_status(source, path, error_code(e));
				issue(source, candidate.unit.key, e);
			}
		}
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
