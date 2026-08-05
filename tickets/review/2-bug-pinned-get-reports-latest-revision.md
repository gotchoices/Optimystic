description: Storage used to hand back older versions of data labelled with the newest version number, so the safety check that catches work built on out-of-date data was being told the data was fresher than it really was. Storage now reports the version the content actually is.
files: packages/db-core/src/network/struct.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-core/test/transactor-source.spec.ts, packages/db-p2p/test/storage-repo.spec.ts
difficulty: medium
----

# Review: revision-pinned reads now report the revision they materialized at

## What changed

A block read can be *pinned*: the caller passes `context.rev = N` and storage serves the
newest committed content at or below N, not the newest content it holds. Storage did that
correctly but then labelled the answer with `state.latest` — the newest revision it holds
for the block. Everything downstream that asks "what revision did this read observe?"
believed the label.

The materialized revision was already computed and discarded:
`IBlockStorage.getBlock(rev)` returns `{ block, actionRev }` where `actionRev` **is** the
revision the content was materialized at. The fix carries it out to the caller.

### The interface change (the load-bearing decision)

`GetBlockResult` (`packages/db-core/src/network/struct.ts`) gains one **optional** field:

```ts
export type GetBlockResult = {
	block?: IBlock;
	state: BlockActionState;
	/** The revision the returned `block` was actually materialized at ... */
	materializedRev?: number;
	unavailable?: BlockUnavailableReason;
};
```

Two invariants the reviewer should hold the diff against:

- **`state.latest` was NOT redefined.** It still means "the newest revision this repo holds
  for the block". Callers depend on that: `StorageRepo.get`'s own promotion pre-scan
  compares `context.committed` against it, and `CoordinatorRepo.get` drives read-repair off
  `localEntry.state.latest.rev`. Both still work off the same number they always did.
- **Optional, with a fallback.** A producer that does not know the materialized revision
  leaves it absent; `TransactorSource` then falls back to `state.latest?.rev ?? 0`, which
  is exactly today's behaviour. So every unchanged producer and test double still compiles
  and still behaves as before.

The ticket offered a cheaper alternative (clamp the recorded revision to
`min(state.latest.rev, actionContext.rev)` inside `TransactorSource`, no schema change).
It was **not** used: the real value was available, and the clamp would misreport whenever
no commit landed between the pin and latest. The interface change proved non-disruptive —
adding an optional field required no edits to `CoordinatorRepo`, `ClusterRepo`,
`NetworkTransactor`, `RepoClient`, `reference-peer`, or any test double.

### Producers

| Producer | Change | Why |
|---|---|---|
| `StorageRepo.get` | **Populated** from `blockRev.actionRev.rev` | The only db-p2p repo that materializes; honours `context.rev` |
| `TestTransactor.get` (db-core test double) | **Populated** | It also honours `context.rev`, so it had the same mis-stamping — and the db-core tests below are meaningless without it |
| `CoordinatorRepo` | none | Returns `StorageRepo`'s entries verbatim; the field rides along. Its own construction (`flagUnconfirmedAbsence`) is an *absent* entry, which correctly has no materialized revision |
| `NetworkTransactor` | comment only | Forwards peer entries verbatim; the wire is length-prefixed JSON, so an added optional field survives untouched |
| `ClusterRepo` | none | **Not** a `GetBlockResult` producer, despite the ticket listing it. Verified: the only `GetBlockResult` references under `packages/db-p2p/src` are `client.ts`, `coordinator-repo.ts`, `storage-repo.ts` |

`StorageRepo.get` populates it on **both** content paths:
- the ordinary committed read → `blockRev.actionRev.rev`;
- the pending-overlay read (`context.actionId` set) → the revision of the **committed base**
  the pending transform was applied over, and absent when there was no base at all (a
  pending-only insert). A pending has no revision of its own, so the committed base is the
  honest answer. **This arm goes beyond the ticket's literal TODO** — flagged deliberately
  in case the reviewer disagrees that "the base's revision" is the right label for
  pending-overlaid content.

The absent/unavailable paths (`{ state: {} }`, `unavailable: 'unmaterializable'`) carry no
`materializedRev` — no content, no revision.

### Consumer

`TransactorSource.tryGet`:

```ts
const rev = materializedRev ?? state.latest?.rev ?? 0;
this.collector.record(id, rev, purpose);
this.readRevisions.set(id, rev);
```

Both sinks take the same value, as the ticket required: `CacheSource` learns the revision
via `getReadRevision` on a miss-load and re-emits it on every later cache hit, so a split
would stamp the cache differently from the collector.

## Why this is not a behaviour change on the ordinary path

`state.latest` is the **block's** latest, not the node's global latest. So `materializedRev`
and `state.latest.rev` diverge in exactly one situation: the caller pinned below the
revision at which **that specific block** last committed. Concretely:

- Unpinned read (`context` absent) → `getBlock(undefined)` targets the block's own
  `meta.latest.rev`, so the two agree.
- Pinned read of a block **unchanged** since the pin (the common case — the pin is a
  collection-wide revision, routinely above any given block's last change) → the descending
  walk lands on the block's own revision, and `state.latest.rev` is that same number. They
  agree. Covered by a dedicated test.
- Pinned read of a block that **did** commit since the pin → they differ, and the pinned
  value is what the reader actually saw. This is the bug.

Direction of the correction: previously over-reporting (recorded a revision newer than what
was read → validator's exact-equality stale check passed → wrong acceptance). Now it
reports the truth, so that case correctly stale-rejects.

## Testing

### New tests

`packages/db-p2p/test/storage-repo.spec.ts` → `describe('get')`:
- **`a revision-pinned get reports the revision its content was materialized at, not the latest`** —
  the ticket's exact probe. Commit `block-1` at rev 1 (`items: ['v1']`), rev 2 (`['v1','v2']`),
  then read unpinned and at `context: { rev: 1, committed: [] }`. Asserts the pinned read
  serves `['v1']`, reports `materializedRev === 1`, **and** that `state.latest.rev` is still
  2 — i.e. the old meaning is intact.
- **`a pinned get of a block unchanged since the pin reports that block's own revision`** —
  the regression guard for the paragraph above. Blocks A and B insert at rev 1; only A moves
  to rev 2. Reading B pinned at rev 2 must report `materializedRev === 1` (B's own revision),
  not the rev-2 pin. Without this, every unchanged block would record a dependency at a
  revision it was never committed at and stale-reject spuriously.

`packages/db-core/test/transactor-source.spec.ts`:
- **`records a pinned read at the revision it materialized, not the transactor's latest`** —
  the ticket's "pinned read records a read dependency at the pinned revision" requirement.
  Asserts `getReadDependencies() === [{ blockId, revision: 1 }]` and
  `getReadRevision(blockId) === 1` (the accessor `CacheSource` learns through), plus the
  no-over-correction half: an unpinned source over the same block still records rev 2.
- **`a CacheSource over a pinned source re-emits the pinned revision on every hit`** —
  wires a real `CacheSource` + shared `ReadDependencyCollector` over a pinned
  `TransactorSource`, does a miss then a hit, and asserts the collector holds only
  `revision: 1`. The collector is max-wins, so a single rev-2 emission from either layer
  would surface here.

All four fail against the pre-fix code (`materializedRev` did not exist, so the storage
assertions compare `undefined` to `1`; the db-core assertions see `revision: 2`).

### Suites run — all green, zero failures

`yarn build` then `yarn test` at the monorepo root (all 11 workspace suites):

```
1349 passing   (db-core)
1517 passing, 44 pending   (db-p2p)
  52 passing, 1 pending
  49 / 44 / 43 / 12 / 125 passing
 359 passing, 11 pending
   6 passing   (quereus-plugin-optimystic smoke)
 258 passing   (quereus-plugin-optimystic)
EXIT=0
```

`packages/quereus-plugin-optimystic` was run as the ticket asked, since it drives the same
read path end-to-end through `StorageRepo`. The 56 pending are pre-existing skips — none
were added, and no test was skipped, disabled, or loosened. No `.pre-existing-error.md` was
written: nothing failed.

## Known gaps — treat the tests as a floor

- **The end-to-end consequence is still not directly observed.** The ticket was honest that
  "a transaction commits on unread data" was *inferred* from reading the validator and
  collector, not seen. That is still true. This change fixes the mis-stamping (verified at
  both the storage layer and the `TransactorSource`/`CacheSource` layer) and the validator's
  exact-equality check will now reject the case — but no test drives a full pinned-read →
  pend → commit → validate cycle across two peers and watches a wrongly-accepted commit turn
  into a rejection. `tickets/backlog/debt-e2e-stale-cache-hit-read-rejected` proposes that
  harness; it should cover this case.
- **The pending-overlay arm is the least-tested edge.** No test asserts `materializedRev` on
  a `context.actionId` read, in either `StorageRepo` or `TestTransactor`. The existing suites
  exercise that path (sync reads back its own pending) and stay green, but the *value* of
  the new field there is unasserted. If the reviewer thinks the committed-base revision is
  the wrong label for pending-overlaid content, this is the arm to change.
- **No multi-peer disagreement test.** See the tripwire below.
- `read-view-pinned.spec.ts` builds pinned views with `recordReads: false` by default, so
  most of that file never reaches the changed line. The one `recordReads: true` case only
  asserts the dependency set is non-empty, not what revision it holds.

## Review findings

- **Tripwire — cross-peer disagreement on `materializedRev` is not tie-broken.** Parked as a
  `NOTE:` at `packages/db-core/src/transactor/network-transactor.ts` on `rankOf` (the
  three-way per-block ranking). `materializedRev` is not part of the ranking, so two peers
  answering the same pinned get with block-carrying entries at different materialized
  revisions resolve to whichever arrived first. Not a concern today (cohort peers share a
  block's revision log, so they agree on the highest committed rev at or below a pin) and the
  failure direction is safe — a lower recorded revision spuriously stale-rejects rather than
  wrongly accepting. The note says what to do if peers are ever seen to disagree.
- **Deviation from the ticket's TODO, deliberate:** `ClusterRepo` was listed as a
  `GetBlockResult` producer to populate. It is not one — verified by searching every
  `GetBlockResult` reference under `packages/db-p2p/src`. Nothing was changed there.
- **Scope note:** the pending-overlay arm of `StorageRepo.get` was populated even though the
  ticket's TODO named only the plain committed read. Reasoning in the "Producers" section
  above; called out here because it is the one place the implementation chose a semantic the
  ticket did not specify.
- **Pre-existing, not mine:** `packages/db-core/src/transactor/network-transactor.ts:682`
  has an unused `blockIds` parameter on `commitBlock` (TypeScript hint 6133, not a build
  error — the build exits 0). It predates this diff; my only edit to that file is a comment
  ~470 lines above it. Left alone.
