export type Agent = string;
export type JsonObject = Record<string, unknown>;

export interface Message {
	native_id: string;
	parent_id: string | null;
	role: string;
	kind?: string;
	record_key?: string;
	json_pointer?: string;
	representation?: string;
	state?: string;
	content: string;
	timestamp: string | null;
	source_order: number;
	active: boolean;
	turn_id: string | null;
}

export interface Transcript {
	inactive_turns?: string[];
	session_key?: string;
	native_id: string;
	project: string;
	title: string | null;
	parent_session: string | null;
	timestamp: string;
	messages: Message[];
	unindexed_records: number;
	records?: EvidenceRecord[];
	parts?: Message[];
	links?: EvidenceLink[];
}

export interface Source {
	source_id: string;
	agent: Agent;
	root: string;
}

export interface RecordLine {
	value: JsonObject;
	byte_offset: number;
	raw_json?: string;
}

export interface ImportUnit {
	key: string;
	locators: string[];
}
export interface ImportInput {
	path: string;
	hash: string;
	byte_offset: number;
	partial: boolean;
}
export interface ResumeInput {
	input: ImportInput;
	records(): RecordLine[];
}
export interface ImportResult {
	append?: boolean;
	sessions: Transcript[];
	inputs: ImportInput[];
}
export interface Adapter {
	parser_version: number;
	agent: Agent;
	discover(root: string): Promise<ImportUnit[]>;
	read(
		unit: ImportUnit,
		previous?: ResumeInput,
	): Promise<ImportResult>;
	// Opt in only when this token covers all inputs affecting read(), including interpretation.
	fingerprint?(unit: ImportUnit): Promise<string | undefined>;
	titles?(root: string): Promise<Map<string, string>>;
}
export interface JsonlAdapter extends Adapter {
	parse(records: RecordLine[], path?: string): Transcript;
}

export interface EvidenceRecord {
	input_path?: string;
	key: string;
	native_id: string | null;
	native_type: string | null;
	timestamp: string | null;
	source_order: number;
	raw_json: string;
}
export interface EvidenceLink {
	record_key: string;
	kind: string;
	namespace: string;
	target: string;
}
