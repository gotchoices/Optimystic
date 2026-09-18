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
  // Error classes (e.g. `PartialCommitError`) must stay single-instance across the `index` and
  // `plugin` entries so `instanceof` works no matter which entry a caller loads through or imports
  // from. `splitting: true` is what currently guarantees that, by putting shared code in one chunk
  // both entries pull from instead of duplicating it per entry — see the identity check in
  // test/browser-bundle.spec.ts, which fails if this ever stops being true.
  splitting: true,
  minify: false,
});
