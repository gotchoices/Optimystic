import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    plugin: 'src/plugin.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node16',
  external: ['quereus', '@optimystic/db-core', '@optimystic/db-p2p'],
  treeshake: true,
  // Anything both the `index` and `plugin` entries export (error classes above all, so `instanceof`
  // matches whichever entry a caller imports from) must be one object, not a copy per entry.
  // `splitting: true` guarantees that by putting shared code in one chunk both entries import;
  // test/entry-identity.spec.ts fails if that ever stops being true.
  splitting: true,
  minify: false,
});
