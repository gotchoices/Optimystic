----
description: Added tests covering what happens when the first storage node fails mid-save, when a remembered node is unreachable at commit time, and when several parts of one transaction commit at once — then verified those tests actually catch the bugs they claim to.
files:
  - packages/db-core/test/network-transactor.spec.ts (the "per-transaction coordinator cache (pend → commit)" describe, ~line 1107-1440)
  - packages/db-core/src/transactor/network-transactor.ts (code under test; UNCHANGED)
  - packages/db-core/src/utility/batch-coordinator.ts (the retry loop the tests drive; UNCHANGED)
  - packages/db-core/src/testing/test-transactor.ts (DelegatingTransactor; imported only, UNCHANGED)
----

# Per-transaction coordinator cache tests — implemented and reviewed

Tests-only change across both stages. One file touched in total:
`packages/db-core/test/network-transactor.spec.ts`. No production code was modified.

## What the cache is

`NetworkTransactor` remembers, per transaction, which network node coordinates each block
(`txnCoordinatorCache`, keyed by action id). `pend()` fills it from its final batch
assignment; `commit()` reads it through `resolveCoordinator()` so the commit reuses pend's
answer instead of running a fresh `findCoordinator` lookup. A cached node that a retry has
already excluded is skipped, so a retry can't loop on a dead coordinator. Before this work
two tests covered it: the happy path, and a commit under a different action id missing the
cache.

## What the implement stage delivered

File-local harness inside the existing describe:

- `CountingClusterKeyNetwork` takes a *list* of fallback coordinators and returns the first
  candidate not in `excludedPeers`, throwing once all are excluded. A new
  `findCoordinatorExclusions` log records what each lookup was told to avoid, so a test can
  assert *which* lookup went live rather than only that one did.
- `FlakyTransportTransactor extends DelegatingTransactor` — pend/commit **throw** rather than
  return `{ success: false }`, because `processBatches` hangs its retry off the `.catch` of
  the per-batch call, so only a throw retries. With its fail counts at their default of 0 it
  doubles as a pure call counter, which is how each reachable peer is instrumented.

Six new tests (8 in the describe): the retry's coordinator being cached rather than the peer
pend first tried; self-healing when a commit retry excludes the cached coordinator;
exclusion by peer id string rather than object identity; one action id shared by two
collections' commits (sequential and concurrent arms); and a read after a pend resolving its
own coordinator rather than borrowing the write's.

The implement handoff was honest about a real deviation: the plan claimed its test 2
exercised the string-vs-reference comparison, and it does not — the cache hands its own
`PeerId` object straight to the batch, so the excluded and cached objects are identical and a
reference comparison passes too. The implementer added the twin-instance test that does close
that gap, and demonstrated it fails under a reference-comparison mutation.

## Review findings

### Checked and clean

- **Full suite and lint.** `yarn test` across all workspaces exits 0; root `yarn lint`
  (eslint) clean; `yarn workspace @optimystic/db-core build` clean (tsc type-checks `test/`).
  `packages/db-core` alone: 1387 passing, the cache describe 8 passing. No pre-existing
  failures surfaced, so `tickets/.pre-existing-error.md` was not written.
- **Production code genuinely untouched.** `git diff` over both stages shows only the spec
  file. Verified by hand after the mutation runs below, since those temporarily edited
  `network-transactor.ts`.
- **The deviation claim holds.** `network-transactor.ts:824` reads
  `excludedPeers.some(p => p.toString() === cached.toString())`, and the twin-instance test
  fails (`expected 3 to equal 2`) under a reference comparison, as the handoff stated.
- **`recordCoordinator` being left undefined is the right call, not a gap.** The handoff
  flagged it as untested here; it is not untested — the hint path has its own dedicated spec
  at `packages/db-p2p/test/coordinator-cache-hint.spec.ts`, covering both the pend and
  non-tail-commit invocations. Nothing to add.
- **Out-of-scope items confirmed out of scope.** The TTL sweep needs a clock-injection seam
  and the 1000-entry size cap needs ~1000 transactions; both are memory backstops carrying no
  correctness property, so neither is worth a ticket.
- **Docs are current.** `docs/optimystic.md:263` inventories the shared `TestTransactor`
  wrappers exported from `@optimystic/db-core/test`. `FlakyTransportTransactor` is file-local
  and not exported, so that paragraph remains accurate — no doc edit needed.

### Found and fixed in this pass (minor)

- **Two tests were vacuous with respect to the cache itself — the main finding.** The handoff
  admitted only the twin-instance test had been mutation-verified. Running the missing
  mutations showed that both `self-heals when a commit retry excludes the cached coordinator`
  and `excludes a cached coordinator by peer id, not by object identity` **passed with the
  cache read disabled entirely**. Neither pinned that the commit's *first* resolution came
  from the cache: `findCoordinatorCalls` was asserted `greaterThan(0)`, and a commit that
  ignored the cache and resolved every round live also satisfies that. Fixed by pinning the
  exact counts — `equal(1)` for the single-block self-heal (the retry's lookup only) and
  `equal(3)` for the twin test (one for the tail's retry, two for the remainder's). With the
  cache read disabled, 6 of 8 tests now fail where 4 did before; the 2 that still pass are the
  two cache-*miss* tests, which correctly should.
- **DRY: `insertPend` was declared after two earlier tests that inlined the identical
  literal.** Moved it above the first test and used it in the different-action-id test, whose
  hand-rolled request was character-for-character the same. The first test builds a two-block
  insert so it legitimately stays inline; the helper's doc comment was reworded off "every
  test below".

### Mutation results (the coverage floor the handoff asked to be raised)

Each mutation was applied to `network-transactor.ts`, run, and reverted; the file is back to
its committed state.

| Mutation | Caught by |
| --- | --- |
| Cache seeded from the pre-retry batch roots instead of `completed` | `caches the RETRY's coordinator` fails |
| Cache entry deleted at the end of `commit()` | shared-action-id **sequential** arm fails |
| `resolveCoordinator` ignores `excludedPeers` | self-heal **and** twin-instance tests fail |
| Cache read disabled outright | 6 of 8 fail (see above) |

### Recorded as a tripwire, not a ticket

- **`FlakyTransportTransactor` placement** — the handoff explicitly asked the reviewer to rule
  on this. Keeping it file-local is right: it matches `PartialLossTransactor` /
  `MixedPendTransactor` in `transaction.spec.ts`, and only this spec needs a *throwing*
  wrapper. It does read as a near-duplicate of the shared `FlakyCommitTransactor`, which
  *returns* a stale failure, so a `NOTE:` at the class explains why both exist and says to
  promote it into `src/testing/test-transactor.ts` alongside its twin if a third spec ever
  wants it — rather than copying it a third time. Conditional on a future third caller, so not
  a queued task.

### Deliberately not filed

- **The concurrent arm of the shared-action-id pair is weaker than its sequential sibling.**
  It survives the entry-deleted-at-commit-end mutation, because both commits resolve before
  either finishes and deletes. It still discriminates a cache that is never populated or never
  shared across siblings, which is the property it is named for, and the sequential arm covers
  the deletion case. Not worth a ticket, and not worth deleting the arm.
- **Retry exhaustion on the cache path stays untested.** When every candidate is excluded,
  `findCoordinator` throws and `processBatches` swallows the retry-setup error, rethrowing the
  original. Reaching that state deliberately would test `processBatches`' error precedence,
  not the cache, and that precedence already carries its own comment at
  `batch-coordinator.ts:128-131`. No correctness property of the cache is uncovered.
- **The cache-miss arm keeps `greaterThan`, not an exact count.** `get()` has its own
  second-chance retry logic; pinning a number there would couple the cache test to unrelated
  behavior. The claim under test is only "a miss falls through to live resolution", and the
  mutation run confirms that arm behaves as intended.
- **The harness's `findCoordinator` is key-blind** (it returns the first non-excluded
  candidate regardless of block). This makes the multi-collection tests *stricter* than their
  comments suggest — a cache miss there resolves to the wrong peer, so the commit fails
  outright rather than merely burning a lookup. Strictness in the right direction; left alone.
- **`network-transactor.ts:560` records `recordCoordinator` hints over `allBatches`, which
  includes failed batches, and only for each batch's anchor `blockId` rather than every block
  it coordinates** — unlike the cache population 80 lines below, which uses `completed` and
  every block in the payload. Traced it: `allBatches` yields a root before its retries, so
  last-write-wins leaves the *surviving* peer in the hint cache, and the hint is advisory
  anyway. No defect demonstrated, pre-existing, and outside a tests-only diff. Noted here so
  the next reader of that asymmetry does not have to re-derive it.

### Size

`packages/db-core/test/network-transactor.spec.ts` is 1786 lines
(`wc -l`). Large, but it is a flat spec file whose describes are independent, and the
nested describe for the shared-action-id arms earns its nesting by sharing a two-collection
setup helper between them. No split proposed.
