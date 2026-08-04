description: Anyone who installed a package depending on db-p2p could not load it at all — it crashed looking for a test-assertion library (chai) that is deliberately not shipped to consumers. The fix (split one barrel export) is already written and verified; this ticket is the build+test confirmation pass before handoff to review.
prereq:
files: packages/db-p2p/src/testing/index.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/package.json, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-rn/test/leveldb-storage.spec.ts, packages/db-p2p-storage-web/test/indexeddb-storage.spec.ts, packages/db-p2p-storage-ns/test/sqlite-storage.spec.ts, packages/db-p2p-storage-fs/README.md
difficulty: easy
repro: verified
----

# Fix from `fix/` stage already applied — implementation complete, verified

Source ticket was `tickets/fix/0-testing-barrel-drags-chai-into-consumer-installs.md` (repro +
cause fully diagnosed there; deleted on promotion into this ticket per workflow rules). The fix
was small enough that the fix-stage pass applied it directly rather than only describing it —
everything below already happened and was checked; this ticket exists to carry it through the
required implement → review hop honestly, not to redo the work.

## What changed

1. `packages/db-p2p/src/testing/index.ts` — dropped `export * from './raw-storage-conformance.js';`.
   The barrel now only re-exports `./mesh-harness.js` (`createMesh`, `buildNetworkTransactor(s)`,
   `nonResponsibleNodes`), none of which reference `chai`.
2. `packages/db-p2p/package.json` — added a new `exports` subpath:
   ```json
   "./testing/conformance": {
     "types": "./dist/src/testing/raw-storage-conformance.d.ts",
     "import": "./dist/src/testing/raw-storage-conformance.js"
   }
   ```
   `chai` stays a `devDependency`, unchanged.
3. Repointed the four suites that use `runRawStorageConformance` / `ConformanceHarness` from
   `@optimystic/db-p2p/testing` to `@optimystic/db-p2p/testing/conformance`:
   - `packages/db-p2p-storage-fs/test/file-storage.spec.ts`
   - `packages/db-p2p-storage-rn/test/leveldb-storage.spec.ts`
   - `packages/db-p2p-storage-web/test/indexeddb-storage.spec.ts`
   - `packages/db-p2p-storage-ns/test/sqlite-storage.spec.ts`
   - Updated one doc reference: `packages/db-p2p-storage-fs/README.md`.
4. `packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts` needed **no
   change** — it only imports `createMesh` / `buildNetworkTransactor` from `@optimystic/db-p2p/testing`,
   both still exported from the barrel.

## Verification already performed

- `yarn build` in `db-p2p`: `dist/src/testing/index.js` now emits only
  `export * from './mesh-harness.js';`.
- `yarn test` in `db-p2p`: 1506 passing, 44 pending (unchanged pass count from before the fix).
- `yarn build && yarn test` in each of `db-p2p-storage-fs`, `-rn`, `-web`, `-ns`: all green
  (52/44/43/49 passing respectively) using the new `/testing/conformance` subpath.
- `yarn build` in `quereus-plugin-optimystic`: succeeds unchanged.
- **Reproduced the original defect directly**, not just via a workspace build (the source ticket
  flagged that workspace builds resolve `chai` locally and mask the bug): in `packages/db-p2p`,
  renamed `node_modules/chai` aside, then:
  - `node -e "import('./dist/src/testing/index.js')"` → succeeds, exports the four
    mesh-harness functions, no `chai` involved.
  - `node -e "import('./dist/src/testing/raw-storage-conformance.js')"` (the new dedicated
    subpath's target) → fails with the exact original error, `Cannot find package 'chai'`,
    confirming that path is correctly gated to only whoever imports it explicitly and was never
    actually fixed to *not* need chai (nor should it be — it's chai-based assertion code).
  - Restored `node_modules/chai` afterward; `raw-storage-conformance.js` imports clean again.
- Did **not** attempt a literal `npm pack` + external-project install, because in this working
  tree `@optimystic/db-p2p`'s `package.json` still carries `"@optimystic/db-core": "workspace:^"`
  (rewritten to a real pinned version only by the release/publish step) — an external install of
  a tarball packed straight from this tree cannot resolve that dependency regardless of this fix,
  so it wouldn't have proven anything the chai-hidden import test above didn't already prove more
  directly. If a reviewer wants the literal npm-pack-and-install form for extra confidence, that's
  the one gap in this verification pass.

## Not done (flagged as out of scope by the source ticket itself)

The source ticket's own "worth considering separately" note: a *production* adapter
(`collection-factory.ts`) importing from a barrel named `testing` is itself a smell, and
`buildNetworkTransactor`/`createMesh` might belong in the main entry point instead. Left alone —
it's explicitly not required for consumer installs to load, which was the whole ask here. Passing
this along so review can decide whether it's worth a `backlog/` ticket of its own, or can just be
dropped.

## TODO

- [ ] Review the diff for correctness and scope creep.
- [ ] Optionally do the literal `npm pack` + external-directory install as a stronger proof (see
      the gap noted above) if reviewer wants it beyond the chai-hidden import test.
- [ ] Decide whether the production-import-from-`testing`-barrel smell above warrants its own
      `backlog/` ticket, or can be dropped without filing anything.
