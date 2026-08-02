description: A node that asked storage "does this collection exist?" and got back "no" used to quietly forget the revision number it already knew, then spend twenty seconds re-requesting revision 1 and failing. It now keeps what it knew, and reports the contradiction immediately by name.
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/test/absent-header-wedges-revision.spec.ts, docs/internals.md, docs/transactions.md

# Complete: `Collection` no longer drops a known-good revision

## What shipped

A collection's revision context can now only move forward when it is refreshed from a read, and a
storage answer that contradicts a revision the client already holds is reported as a named fault
instead of being silently absorbed.

- **`Collection.advanceContext(source, id, next)`** (private, `collection.ts:154-173`) is the single
  place a freshly-read `ActionContext` is adopted. It keeps what is already held when the read
  returns nothing, and when the read returns an older revision (logging
  `collection:context-not-lowered`); otherwise it adopts the new one. Equal revisions still adopt,
  because the newer read's `committed` list can be the more complete of the two.
- Both read sites route through it: `attachToLog` (was overwriting the revision just bootstrapped
  off the committed log tail with whatever `Log.getActionContext()` returned) and `updateInternal`
  (was assigning `latest?.context` unconditionally). `createOrOpen`'s invent branch still resets the
  context directly — that is a deliberate reset for a collection being brought into existence, not a
  read.
- **`CollectionHeaderVanishedError`** (`struct.ts`, exported from the package root) is thrown by
  `updateInternal` when the header block reads as authoritatively absent while the collection holds
  a committed revision. It names the collection id and the held revision. It is a plain `Error`, not
  a `StaleFailure`, so `sync`'s retry loop does not absorb it — the sync aborts on the first attempt
  instead of spending its whole retry budget re-requesting revision 1. A collection that has never
  committed holds no revision, so the absent-header no-op is untouched and `createOrOpen`'s invent
  path still works.
- Docs: `docs/internals.md` § Collection Header Blocks → "The revision context is monotonic";
  `docs/transactions.md` § Unavailable reads gained the header-contradiction case.

Spec: `packages/db-core/test/absent-header-wedges-revision.spec.ts`, 7 tests. Two fake transactors
drive it — one rewrites reads of a chosen block id into an authoritative "does not exist" answer,
one answers every read as of a pinned older revision (a replica that lags).

## Review findings

### Checked

The implement-stage diff read first and independently of the handoff summary; then the monotonic
guard's semantics against what `Log.getFrom` / `Log.getActionContext` actually return; then every
one of the 20 `update()` / `updateAndSync()` call sites across db-core, the plugin, and the demo for
callers the new throw could surprise; then the export surface; then every doc file that describes
absent-header or retry behaviour; then the spec for vacuous tests. `yarn build`, `yarn lint`,
`yarn test`, `yarn test:integration` all run.

### Found and fixed in this pass (all minor)

- **Nothing pinned that the context still *advances*.** The four behaviour-change tests all assert
  a revision *not moving*; a guard that refused every reassignment would satisfy all of them and
  silently stop `update()` from ever catching a peer up. Verified by making `advanceContext` never
  assign: all six original tests stayed green. Added `still adopts a HIGHER revision — the guard
  blocks lowering only` (a reader opened at rev 1, two revisions committed by another writer, then
  `update()` → next rev 4) and confirmed it fails (`expected 2 to equal 4`) with adoption disabled
  and passes with it restored.
- **Stale comment at the coordinator's retry refresh** (`coordinator.ts:184`). It read "Harmless (a
  non-participant's update() just fetches latest)" — no longer true, since a non-participant whose
  header momentarily reads absent now aborts the retry. The new NOTE in `collection.ts` explicitly
  pointed the reader at this comment, so the two contradicted each other. Rewritten to state the
  cost and keep the same remedy (narrow the refresh to participants).
- **`docs/transactions.md` § Unavailable reads was out of date.** Its closing bullet — "An
  authoritatively absent block still reads as absent … only an answer the repo *knows* is a guess
  throws" — is the natural place a reader looks for this behaviour, and it no longer told the whole
  truth. Added a paragraph naming `CollectionHeaderVanishedError`, its non-`StaleFailure` status,
  and the never-committed exception, cross-linked to internals.md.

### Considered and rejected — not defects

- **Equal-revision adoption replacing a longer `committed` list with a shorter one.** Read
  `Log.getFrom`: its `context.committed` is the checkpoint's pendings plus every action entry walked
  since, i.e. a complete log-derived set rather than a delta from the requested revision. Adopting
  it at an equal revision cannot lose entries.
- **A held context at revision 0 producing a false contradiction.** `getActionContext` returns
  `rev: checkpoint?.rev ?? 0`, which looked like it could seed a truthy-but-meaningless rev-0
  context that the throw would then treat as proof of a commit. It cannot: `findCheckpoint` reports
  the *newest* entry's revision, and it only runs for a chain with a non-empty tail, so the value is
  ≥ 1 wherever a header exists. No guard added.
- **Importing the new error through the `./index.js` barrel** (a cycle back into `collection.ts`).
  Matches the existing `SyncRetryExhaustedError` import on the same line, and the class is
  referenced only at call time inside a method, so there is no initialisation-order hazard.

### Gaps left standing, deliberately

- **The `next === undefined` branch of `advanceContext` has no test at all.** Confirmed — the
  lagging-replica tests supply a real-but-older context, not `undefined`, and the header-absent path
  now throws before reaching it. Reaching it needs a header that reads fine but whose log will not
  open, which takes hand-built chain surgery. The branch's behaviour (keep what is held) is the
  strictly conservative one, so the exposure is low; left uncovered rather than faked.
- **The invented-collection arm is still broken and still pinned by the last test.** A node that
  cannot see the header of a collection it has never committed to invents a rival empty collection,
  holds no revision, has no contradiction to detect, and still exhausts its retries at revision 1.
  Both owning tickets were verified present on the board:
  `tickets/implement/2-cluster-read-consult-cannot-report-unreachable.md` (make the read answer
  correctly) and `tickets/plan/stale-failure-carries-coordinator-revision.md` (give the client a
  revision to rebase onto). The test earns its place: it is an accurate characterisation of today's
  behaviour, it names both owners inline, and it will fail loudly — correctly — when the first of
  them lands.

### Tripwires

- **Durable invalidation vs. this error's wording** — parked as a `NOTE:` on
  `CollectionHeaderVanishedError` in `struct.ts`. Invalidation restores reverted content to its
  as-if-absent state, so once the cascade runs end-to-end, reverting the commit that *created* a
  collection would make its header legitimately absent for a client still holding that revision.
  Aborting is still the right action; only the message ("nothing was ever committed under this id")
  would misdiagnose it. The note says how to tell the two apart if it ever fires that way. The
  cascade is built but not live end-to-end (`docs/correctness.md`), so this is conditional, not a
  latent defect.
- **The coordinator's blanket refresh blast radius** — parked by the implementer as a `NOTE:` at the
  throw in `collection.ts`, and now matched by the corrected comment at `coordinator.ts:184`.

### Major findings

None. No new tickets filed.

## Validation

| Command | Result |
| --- | --- |
| `yarn build` (root) | clean |
| `yarn lint` (root) | clean |
| `yarn test` (root) | db-core **1320 passing**; db-p2p 1479 passing / 44 pending; quereus-plugin-optimystic 336 passing / 11 pending; all other packages green; **0 failing** |
| `yarn test:integration` (root) | 30 passing / 2 pending (db-p2p), 339 passing / 8 pending (plugin); **0 failing** |

No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was written.
