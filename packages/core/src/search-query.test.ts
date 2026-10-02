import { expect, test } from 'vitest';
import { search_expression } from './search-query.ts';

test.each([
	['my-pi', '"my-pi"'],
	['my-pi deps', '"my-pi" AND "deps"'],
	['my-pi AND deps', '"my-pi" AND deps'],
	['node.js OR @scope/pkg', '"node.js" OR "@scope/pkg"'],
	[
		'(packages/core OR ../README.md) NOT deps',
		'("packages/core" OR "../README.md") NOT deps',
	],
	['NEAR(my-pi deps, 3)', 'NEAR("my-pi" deps, 3)'],
	['^my-pi* + deps', '^"my-pi"* + deps'],
	['café-lib OR 日本語/path', '"café-lib" OR "日本語/path"'],
	['"my-pi" AND deps', '"my-pi" AND deps'],
	['"say ""my-pi""" OR node.js', '"say ""my-pi""" OR "node.js"'],
	['"unfinished my-pi AND node.js', '"unfinished my-pi AND node.js'],
	['badcolumn:my-pi', 'badcolumn:"my-pi"'],
	['my-pi? AND deps', 'my-pi? AND deps'],
	['sqlite OR', 'sqlite OR'],
])(
	'normalizes %s without rewriting FTS syntax',
	(query, expected) => {
		expect(search_expression(query)).toBe(expected);
	},
);
