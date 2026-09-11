import { defineConfig } from 'vite-plus';

export default defineConfig({
	pack: {
		entry: ['src/index.ts'],
		copy: ['../../packages/core/src/schema.sql'],
		format: ['esm'],
		sourcemap: false,
		dts: false,
		outExtensions: () => ({ js: '.js' }),
	},
});
