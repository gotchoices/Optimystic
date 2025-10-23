import { defineConfig } from 'tsup';

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		plugin: 'src/plugin.ts',
	},
	format: ['esm'],
	dts: {
		resolve: true,
	},
	sourcemap: true,
	clean: true,
	splitting: false,
	treeshake: true,
	skipNodeModulesBundle: true,
});

