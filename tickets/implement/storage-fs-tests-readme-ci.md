----
description: Give the Node filesystem storage package a README and round out its test coverage and its verbose-test command so it participates fully in CI alongside the other storage adapters.
prereq:
files: packages/db-p2p-storage-fs/package.json, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/src/file-kv-store.ts, packages/db-p2p-storage-fs/src/atomic-write.ts, packages/db-p2p-storage-ns/README.md, packages/db-p2p-storage-ns/package.json
difficulty: easy
----

Origin: review finding eh-7 (docs/review.html, Section 9 "Cross-cutting engineering health").

`packages/db-p2p-storage-fs` is the durable, filesystem-backed persistence
adapter used by the reference peer and the SQL plugin. When this ticket was
filed it had no tests, no README, and was omitted from CI. **Since then the
`st-storage-*` hardening tickets landed and changed the picture** — read the
"Current state" below before doing anything, because most of the CI/test gap is
already closed and the remaining work is small.

## Current state (verify before editing)

- **Tests now exist.** `test/file-storage.spec.ts` (added by the storage
  hardening work) already covers: `FileRawStorage` metadata atomic-write +
  corrupt-`meta.json` tolerance, `listPendingTransactions` readdir error
  discrimination (ENOENT → empty vs EACCES → throw), and `FileKVStore`
  atomic-write round-trip + failed-rename safety. It uses a per-test
  `fs.mkdtemp` fixture with `afterEach` cleanup, and `node:assert` (not chai).
- **`atomic-write.ts` exists** — the non-atomic-write concern (Storage review
  st-2) is already addressed and tested. Nothing to do there.
- **CI already runs storage-fs's `test`.** The root `package.json` `test` and
  `test:verbose` scripts were refactored to
  `yarn workspaces foreach -At … run test` / `run test:verbose` across *all*
  workspaces — there is no longer a hand-maintained per-package list. So the
  "root test script omits storage-fs" concern in the original ticket is **moot**:
  storage-fs has a `test` script, so `yarn test` at the root already includes it.
  **Do not add an explicit storage-fs entry to the root package.json** — that's
  not how the scripts work anymore.

## What actually remains

Three gaps, all small:

**1. Missing `test:verbose` script.** storage-fs's `package.json` has only a
`test` script, and it uses `--reporter spec`. Its three siblings
(`db-p2p-storage-ns/rn/web`) each define both `test` (`--reporter min`) and
`test:verbose` (`--reporter spec`). Because storage-fs has no `test:verbose`
script, the root `yarn test:verbose` foreach **silently skips it**. Align it
with the siblings: make `test` use `--reporter min` and add a `test:verbose`
that uses `--reporter spec`. Keep the existing `node --import ./register.mjs …`
invocation.

**2. Test coverage is narrower than the siblings.** The existing spec is good on
atomicity/corruption but only exercises part of the `IRawStorage` surface. The
sibling adapters test the full round-trip. Add coverage (extend the existing
file, or split into `storage.spec.ts` + `kv-store.spec.ts` mirroring
`db-p2p-storage-ns`'s split — implementer's call) for:
- `FileRawStorage` round-trips not yet covered: `saveRevision`/`getRevision`,
  `saveTransaction`/`getTransaction`, `saveMaterializedBlock`/`getBlock`, and
  `savePendingTransaction` → `promotePendingTransaction` moving pend → actions.
- Action-id filename encoding: ids containing a colon (e.g. `tx:abcd`) must
  round-trip on all platforms — `file-storage.ts` encodes `:` as `%3A` for
  Windows. Assert a colon-bearing action id can be saved and read back.
- `FileKVStore.list(prefix)` (recursive `.json` walk) and `delete` — currently
  only `set`/`get` are tested.

**3. No README.** Write `packages/db-p2p-storage-fs/README.md`. Mirror the tone
and structure of `packages/db-p2p-storage-ns/README.md`. It should cover:
- What the package is: the Node filesystem `IRawStorage` + `IKVStore` adapter,
  the durable store for the reference peer and the SQL plugin.
- The on-disk layout (confirmed from `file-storage.ts`):
  ```
  <basePath>/<blockId>/meta.json           — BlockMetadata (JSON)
  <basePath>/<blockId>/revs/<rev>.json     — ActionId per revision
  <basePath>/<blockId>/pend/<id>.json      — pending Transform
  <basePath>/<blockId>/actions/<id>.json   — committed Transform
  <basePath>/<blockId>/blocks/<id>.json    — materialized IBlock
  <basePath>/<key…>.json                   — FileKVStore (key '/'-segments → subdirs)
  ```
  Note colons in action ids are percent-encoded (`%3A`) in filenames for
  Windows compatibility.
- Atomic writes: every write goes through `atomic-write.ts` (temp file +
  rename), so a crash mid-write never leaves a torn canonical file.
- The **single-process assumption** — see "Known gaps" below — so a reader
  running two processes against the same `basePath` knows it is unguarded.

## Known gaps to record (do NOT fix here — just document)

These are out of scope; call them out in the README (a short "Known
limitations" section) so they aren't lost, and list them in the review handoff:

- **No cross-process lock.** `file-storage.ts:22` carries a TODO to use
  `proper-lockfile` to guard concurrent-process access to `basePath`, plus an
  explicit dispose pattern. Two processes sharing one `basePath` today can
  interleave writes. Tracked for the storage-hardening work.
- **No persistent peer identity.** Unlike the `ns`/`rn`/`web` adapters — each of
  which ships a `loadOrCreate*PeerKey` helper and an `identity.spec.ts` — the fs
  adapter has **no** identity module, and the reference peer never persists a
  private key, so an fs-backed node gets a fresh, ephemeral peer id on every
  restart. This is why the original ticket's "port the identity spec" step does
  **not** apply: there is nothing to test. Do not invent a `loadOrCreateFSPeerKey`
  here — that's a feature, not a test/docs task. Note the divergence in the
  README's identity/limitations section; if it warrants follow-up, the reviewer
  can file a `feat-` backlog ticket for a durable fs identity.

## Validation

Run from the package dir, streaming output (idle-timeout safe):
```
cd packages/db-p2p-storage-fs && yarn build 2>&1 | tee /tmp/fs-build.log
yarn test 2>&1 | tee /tmp/fs-test.log
yarn test:verbose 2>&1 | tee /tmp/fs-testv.log
```
Then confirm the root wiring picks it up:
```
cd ../.. && yarn workspaces foreach -At --exclude '@optimystic/optimystic' run test:verbose 2>&1 | tee /tmp/root-testv.log
```
(the last one runs every package — if it's too slow for the agent budget, at
minimum confirm storage-fs is no longer skipped by `test:verbose`; a bare
`yarn workspace @optimystic/db-p2p-storage-fs run test:verbose` proves the script
now exists.)

## TODO

- Add `test:verbose` to `packages/db-p2p-storage-fs/package.json` (`--reporter spec`)
  and switch `test` to `--reporter min`, matching the sibling storage packages.
- Extend the test suite to cover the round-trip surface listed above
  (revisions, transactions, materialized blocks, pend→actions promotion,
  colon-in-action-id encoding, `FileKVStore.list`/`delete`). Keep the
  mkdtemp-per-test fixture and cleanup pattern already in the file.
- Write `packages/db-p2p-storage-fs/README.md` per the outline above, including
  the "Known limitations" section (lockfile TODO + ephemeral identity).
- Build + run `test` and `test:verbose` for the package; stream logs with `tee`.
- Confirm storage-fs is no longer skipped by the root `test:verbose` foreach.
- Hand off to review noting: coverage is broadened but the cross-process lock
  and durable-identity gaps remain deliberately unaddressed (documented, not
  fixed).
