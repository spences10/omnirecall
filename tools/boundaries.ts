import { relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');

export function boundary_error(filename: string, specifier: string) {
	const file = relative(root, resolve(root, filename))
		.split(sep)
		.join('/');
	const source = file.match(/^(packages|apps)\/([^/]+)\//)?.[0];
	if (!source) return null;
	const target = specifier.startsWith('.')
		? relative(root, resolve(root, file, '..', specifier))
				.split(sep)
				.join('/')
		: specifier.replace(/^@omnirecall\//, 'packages/');
	const destination = target.match(
		/^(packages|apps)\/([^/]+)(?:\/|$)/,
	);
	if (!destination) return null;
	const target_workspace = `${destination[1]}/${destination[2]}/`;
	if (source === target_workspace) return null;
	if (
		source.startsWith('packages/') &&
		target_workspace.startsWith('apps/')
	) {
		return 'Packages must not import the CLI.';
	}
	// Integration tests deliberately compose adapters and core.
	if (file.endsWith('.test.ts')) return null;
	if (source === 'packages/core/')
		return 'Core must not import adapters or applications.';
	if (
		source.startsWith('packages/adapter-') &&
		target_workspace !== 'packages/core/' &&
		target_workspace !== 'packages/adapter-shared/'
	) {
		return 'Adapters may only depend on core and adapter-shared.';
	}
	return null;
}

type Literal = { value?: unknown };
type ImportNode = { source?: Literal | null };
type CallNode = {
	callee: { type: string; name?: string };
	arguments: Literal[];
};
type RuleContext = {
	filename: string;
	report: (diagnostic: {
		node: ImportNode | CallNode;
		message: string;
	}) => void;
};

export default {
	meta: { name: 'omnirecall' },
	rules: {
		boundaries: {
			create(context: RuleContext) {
				function check(
					node: ImportNode | CallNode,
					source: Literal | null | undefined,
				) {
					if (typeof source?.value !== 'string') return;
					const message = boundary_error(
						context.filename,
						source.value,
					);
					if (message) context.report({ node, message });
				}
				return {
					ImportDeclaration(node: ImportNode) {
						check(node, node.source);
					},
					ExportNamedDeclaration(node: ImportNode) {
						check(node, node.source);
					},
					ExportAllDeclaration(node: ImportNode) {
						check(node, node.source);
					},
					ImportExpression(node: ImportNode) {
						check(node, node.source);
					},
					CallExpression(node: CallNode) {
						if (
							node.callee.type === 'Identifier' &&
							node.callee.name === 'require'
						) {
							check(node, node.arguments[0]);
						}
					},
				};
			},
		},
	},
};
