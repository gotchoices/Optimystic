import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node16',
  external: ['quereus', '@optimystic/db-core', '@optimystic/db-p2p'],
  treeshake: true,
  splitting: false,
  minify: false,
});
