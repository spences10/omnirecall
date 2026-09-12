import { defineConfig } from 'vite-plus';

export default defineConfig({
	pack: {
		entry: ['src/index.ts'],
		copy: [
			'../../packages/core/src/schema.sql',
			'../../packages/core/src/migrations',
		],
		format: ['esm'],
		sourcemap: false,
		dts: false,
		outExtensions: () => ({ js: '.js' }),
	},
});
