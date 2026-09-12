import { defineConfig } from 'vite-plus';

export default defineConfig({
	test: {
		include: [
			'apps/*/src/**/*.test.ts',
			'packages/*/src/**/*.test.ts',
			'tools/**/*.test.ts',
		],
	},
	fmt: {
		useTabs: true,
		singleQuote: true,
		printWidth: 70,
		trailingComma: 'all',
		proseWrap: 'always',
	},
	lint: {
		jsPlugins: ['./tools/boundaries.ts'],
		rules: { 'omnirecall/boundaries': 'error' },
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
});
