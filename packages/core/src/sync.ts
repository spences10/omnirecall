import { Archive } from './database.ts';
import { read_snapshot } from './files.ts';
import { InputError, type Adapter, type Source } from './types.ts';

export function error_code(error: unknown): string {
	if (error instanceof InputError) return error.code;
	const code = (error as NodeJS.ErrnoException)?.code;
	if (code === 'ENOENT') return 'missing';
	if (code === 'EACCES' || code === 'EPERM') return 'blocked';
	return 'error';
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
		omitted_records: 0,
		issues: [] as {
			source_id: string;
			path: string;
			code: string;
			message: string;
		}[],
		issues_truncated: false,
	};
	function issue(source: Source, path: string, error: unknown) {
		result.failures++;
		if (error_code(error) === 'error') result.operational_failures++;
		if (result.issues.length < 100)
			result.issues.push({
				source_id: source.source_id,
				path,
				code: error_code(error),
				message:
					error instanceof Error
						? error.message
						: 'Unknown source/index operation failure',
			});
		else result.issues_truncated = true;
	}
	for (const source of sources) {
		const adapter = adapters.find(
			(candidate) => candidate.agent === source.agent,
		);
		if (!adapter) throw new Error('Missing adapter');
		archive.register(source, 'checking');
		let files: string[];
		try {
			files = await adapter.discover(source.root);
		} catch (error) {
			archive.register(source, error_code(error));
			issue(source, source.root, error);
			continue;
		}
		const source_failures = result.failures;
		const partial_before = result.partial_files;
		let titles = new Map<string, string>();
		try {
			titles = (await adapter.titles?.(source.root)) ?? titles;
		} catch (error) {
			issue(source, source.root, error);
		}
		archive.reconcile_paths(source, new Set(files));
		// Detect divergent copies before changing the selected revision. Keep only hashes between passes.
		const candidates: {
			path: string;
			native_id: string;
			hash: string;
		}[] = [];
		const identities = new Map<string, Set<string>>();
		for (const path of files) {
			result.files_scanned++;
			try {
				const snapshot = await read_snapshot(path);
				const transcript = adapter.parse(snapshot.records);
				const hashes =
					identities.get(transcript.native_id) ?? new Set<string>();
				hashes.add(snapshot.hash);
				identities.set(transcript.native_id, hashes);
				candidates.push({
					path,
					native_id: transcript.native_id,
					hash: snapshot.hash,
				});
			} catch (error) {
				archive.path_status(source, path, error_code(error));
				issue(source, path, error);
			}
		}
		for (const candidate of candidates) {
			try {
				if (identities.get(candidate.native_id)!.size > 1)
					throw new InputError(
						'conflict',
						'Divergent files share a native session ID; no revision selected',
					);
				const snapshot = await read_snapshot(candidate.path);
				if (snapshot.hash !== candidate.hash)
					throw new InputError(
						'changed',
						'Source changed between discovery and ingestion; retry sync',
					);
				const transcript = adapter.parse(snapshot.records);
				transcript.title =
					titles.get(transcript.native_id) ?? transcript.title;
				const stored = archive.store(
					source,
					candidate.path,
					transcript,
					snapshot,
					titles.has(transcript.native_id),
				);
				result.files_indexed++;
				if (stored.added) result.revisions_added++;
				result.omitted_records += transcript.omitted_records;
				if (snapshot.partial) result.partial_files++;
			} catch (error) {
				archive.path_status(
					source,
					candidate.path,
					error_code(error),
				);
				issue(source, candidate.path, error);
			}
		}
		archive.register(
			source,
			source_failures !== result.failures ||
				partial_before !== result.partial_files
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
