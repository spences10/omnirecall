import { defineConfig } from 'vite-plus';

export default defineConfig({
	pack: {
		entry: ['src/index.ts'],
		format: ['esm'],
		sourcemap: false,
		dts: false,
		outExtensions: () => ({ js: '.js' }),
	},
});
