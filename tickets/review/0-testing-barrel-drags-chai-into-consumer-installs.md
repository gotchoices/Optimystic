description: Anyone who installed a package depending on db-p2p could not load it at all — it crashed looking for a test-assertion library (chai) that is deliberately not shipped to consumers. The fix (split one barrel export) is applied, built, and verified end to end; this ticket is the code-review pass before archiving.
prereq:
files: packages/db-p2p/src/testing/index.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/package.json, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-rn/test/leveldb-storage.spec.ts, packages/db-p2p-storage-web/test/indexeddb-storage.spec.ts, packages/db-p2p-storage-ns/test/sqlite-storage.spec.ts, packages/db-p2p-storage-fs/README.md, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts
difficulty: easy
----

# Fix verified in implement stage — ready for review

Root cause: `packages/db-p2p/src/testing/index.ts` re-exported both `mesh-harness.js`
(chai-free, used by production code) and `raw-storage-conformance.ts` (chai-based test
helper) from one barrel. Any consumer importing `@optimystic/db-p2p/testing` for the
production helpers pulled in chai transitively — a devDependency not installed for
consumers — and crashed at import time.

## Fix (already applied, this ticket is verify+handoff only)

1. `packages/db-p2p/src/testing/index.ts` — barrel now only re-exports `./mesh-harness.js`.
   `raw-storage-conformance.ts` is no longer re-exported from it.
2. `packages/db-p2p/package.json` — new `exports` subpath `./testing/conformance` points at
   `raw-storage-conformance.js` directly. `chai` stays a `devDependency`, unchanged.
3. Four conformance-test consumers repointed from `@optimystic/db-p2p/testing` to
   `@optimystic/db-p2p/testing/conformance`:
   - `packages/db-p2p-storage-fs/test/file-storage.spec.ts`
   - `packages/db-p2p-storage-rn/test/leveldb-storage.spec.ts`
   - `packages/db-p2p-storage-web/test/indexeddb-storage.spec.ts`
   - `packages/db-p2p-storage-ns/test/sqlite-storage.spec.ts`
   - Doc reference updated: `packages/db-p2p-storage-fs/README.md`.
4. `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts` — no
   change needed; it only imports `createMesh`/`buildNetworkTransactor` from
   `@optimystic/db-p2p/testing`, both still exported from the barrel.
5. `packages/quereus-plugin-optimystic/test/two-node-multi-collection-commit.spec.ts` — also
   imports `createMesh`/`buildNetworkTransactors` from the unchanged `.../testing` path;
   confirmed still valid, no update needed.

## Verification performed this stage (implement)

All of the following were re-run fresh in this stage, not just carried over from the fix
stage's claims:

- `yarn workspace @optimystic/db-p2p build` — `dist/src/testing/index.js` emits only
  `export * from './mesh-harness.js';`.
- `yarn workspace @optimystic/db-p2p test` — **1506 passing, 44 pending.**
- `yarn workspace @optimystic/db-p2p-storage-fs build && test` — **52 passing, 1 pending.**
- `yarn workspace @optimystic/db-p2p-storage-rn build && test` — **44 passing.**
- `yarn workspace @optimystic/db-p2p-storage-web build && test` — **43 passing.**
- `yarn workspace @optimystic/db-p2p-storage-ns build && test` — **49 passing.**
- `yarn workspace @optimystic/quereus-plugin-optimystic build` — succeeds unchanged.
- **Direct bug reproduction**, done fresh in this stage (not just via workspace build, which
  resolves `chai` locally and would mask the bug): in `packages/db-p2p`, renamed
  `node_modules/chai` aside, then:
  - `node -e "import('./dist/src/testing/index.js')"` → **succeeds**, exports
    `buildNetworkTransactor`, `buildNetworkTransactors`, `createMesh`,
    `nonResponsibleNodes` — no chai involved. This is the path every consumer actually uses.
  - `node -e "import('./dist/src/testing/raw-storage-conformance.js')"` (the new dedicated
    subpath) → **fails** with `Cannot find package 'chai' imported from
    .../dist/src/testing/raw-storage-conformance.js` — i.e. the original crash, now scoped
    only to whoever explicitly opts into the chai-based conformance harness. That's correct:
    that file legitimately needs chai and is never imported by production code.
  - Restored `node_modules/chai`; `raw-storage-conformance.js` imports clean again.

## Known gap — not attempted

Did not do a literal `npm pack` + external-directory install. In this working tree
`@optimystic/db-p2p`'s `package.json` still carries `"@optimystic/db-core": "workspace:^"`,
which only gets rewritten to a real pinned version by the release/publish step — an external
install of a tarball packed straight from this tree can't resolve that dependency regardless
of this fix, so it wouldn't prove anything beyond what the chai-hidden import test above
already proved more directly. Flagging in case a reviewer wants that literal form for extra
confidence anyway.

## For review to decide (not a defect, just a design question raised by the source ticket)

Source ticket noted: a *production* adapter (`collection-factory.ts`) importing from a barrel
named `testing` is a smell in its own right, and `buildNetworkTransactor`/`createMesh` might
belong under the main `db-p2p` entry point instead of under `/testing`. Out of scope for this
fix (consumer installs load fine either way) — review should decide whether this is worth a
`backlog/` ticket or can be dropped without filing anything.

## TODO (review)

- [ ] Review the diff for correctness and scope creep.
- [ ] Confirm the `exports` subpath split in `package.json` is the right long-term shape (vs.
      e.g. moving `raw-storage-conformance.ts` out of `src/testing/` entirely).
- [ ] Decide on the production-import-from-`testing`-barrel smell noted above: file a
      `backlog/` ticket, or drop it.
- [ ] Optionally run the literal `npm pack` + external install for stronger proof (see gap
      above) if desired beyond what's already verified.
