// Published entry point (`@optimystic/db-p2p/testing`), imported by production code
// (quereus-plugin-optimystic's `mesh-test` transactor), so everything reachable from here must
// import only runtime `dependencies` — never a devDependency. `raw-storage-conformance.ts` imports
// `chai` and so ships under its own `./testing/conformance` subpath instead.
// `test/testing-entry-runtime-deps.spec.ts` enforces this for every published subpath.
// NOTE: `./testing/conformance` points straight at that one module; if a second devDependency-based
// helper is ever added, give it a `src/testing/conformance/index.ts` barrel rather than a third subpath.
export * from './mesh-harness.js';
