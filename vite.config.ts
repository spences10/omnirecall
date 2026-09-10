import { defineConfig } from 'vite-plus';

export default defineConfig({
	test: {
		include: ['apps/*/src/**/*.test.ts'],
	},
	fmt: {
		useTabs: true,
		singleQuote: true,
		printWidth: 70,
		trailingComma: 'all',
		proseWrap: 'always',
	},
	lint: {
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
});
