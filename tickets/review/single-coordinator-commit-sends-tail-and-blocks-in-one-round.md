description: Saving a change used to commit the collection's log entry in one consensus round and the rest of the changed data in a second. When one machine coordinates every block of the change, which is always the case in small groups, both now go in a single round, and every machine stores the log entry before anything else, so a write costs one fewer round of network calls.
prereq: cluster-commit-round-carries-the-coordinators-commit-vote
architecture: docs/internals.md#commit-path-distributed-consensus
files:
  - packages/db-core/src/transactor/network-transactor.ts (`commit`, `commitInOneRound`, `soleCommitCoordinator`, `commitTailThenSweep`, `sendCommit`, `commitBlocks`, `staleFromBatches`, module function `refusalFrom`)
  - packages/db-p2p/src/storage/storage-repo.ts (`commit`: tail-first order; module function `tailFirst`)
  - packages/db-core/src/collection/collection.ts (comments only: `inFlightActionId`, `bootstrapContext`)
  - packages/db-core/src/network/struct.ts (comments only: `CommitRequest.headerId`, `CommitRequest.tailId`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (comment only: the durability-gate NOTE in `commit`)
  - packages/db-core/test/network-transactor.spec.ts, packages/db-p2p/test/storage-repo.spec.ts (new tests)
  - packages/db-p2p/test/torn-commit-cancels-abandoned-blocks.spec.ts, member-leaves-and-returns.spec.ts, member-missed-commit-heals-at-commit.spec.ts, rival-superseded-only-by-a-writer-that-built-on-it.spec.ts, superseded-own-write-is-saved.spec.ts, half-landed-write-is-finished.spec.ts, concurrent-diary-append-acknowledgement.spec.ts (updated)
  - docs/internals.md (Commit Path diagram, new §"One commit round when one coordinator covers every block", Key Invariants bullets on torn actions and the writer's retry), docs/correctness.md §2 "Commit durability reporting", docs/repository.md (pending-record lifetime paragraph), packages/db-core/docs/network.md (log-first ordering)
----
# One commit round for the log tail and the rest of the blocks, when one coordinator covers them all

## What changed

**`NetworkTransactor.commit`** now has two paths.

- **One round** (`commitInOneRound`): resolve a coordinator for every block of the action (tail first, then the rest), reusing the pend's cached resolution exactly as `commitBlocks` does. If one coordinator covers them all, send ONE `commit` to it with `blockIds` ordered tail first. A returned success is the answer (`mergeDurability` of the one report, never torn). A returned refusal is normalized through `refusalFrom` (the same rebuild `staleFromBatches` used to do inline, now shared) and returned, as a refused tail is. A throw is logged and NOT retried through `processBatches`.
- **Two steps** (`commitTailThenSweep`, the old body of `commit`, unchanged in behaviour): the tail round, then the sweep. Taken when the blocks need more than one coordinator, when a coordinator lookup failed while planning (logged, then the two-step path repeats the lookups and reports whatever they report), when the action touches only its tail (so single-block commits behave exactly as before, retries included), and when the one-round commit threw.
- `sendCommit` is now the single place a commit request is built (digest narrowing, `tailId`, `expiration`, `dialTimeoutMs`), used by both paths.

**`StorageRepo.commit`** orders the deduplicated block ids with `request.tailId` first (`tailFirst`, a stable reorder and a no-op when the tail is absent or already first). Together with the existing rules (the apply loop stops at the first failure; the stale partition and the missing-pend throw both return before anything is applied), this makes "no member commits a non-tail block of an action without its tail" hold on every member, whatever order a request lists. The comment at the site states the invariant.

Comments in `Collection` (`inFlightActionId`, `bootstrapContext`), `CommitRequest` (`headerId`, `tailId`) and the `CoordinatorRepo.commit` durability-gate NOTE now state the guarantee as "tail applied first on every member" rather than "tail round before sweep round". The docs listed in `files:` are updated, and `yarn lint:docs` is clean.

## Measured saving

With a throwaway spec (run once, then deleted), a two-block write (`pend` then `commit`) through `NetworkTransactor` on a two-member mesh (`createMesh(2, { responsibilityK: 2, clusterSize: 2 })`) made **4** `/cluster` deliveries to the other member: pend promise and commit rounds, then one commit's promise and commit rounds. Tail plus sweep would be 6. This is recorded in the new docs/internals.md subsection.

## Tests

Added:
- `network-transactor.spec.ts` › "commit in one round" › "sends the tail and the other block as one request, tail first". The caller lists the tail LAST; exactly one repo `commit` call is made, carrying `[tail, other]`; both blocks are committed and nothing is torn.
- Same describe › "falls back to the tail, then the rest, when the one-round request throws". Calls observed: `[tail, other]` (throws), then `[tail]`, then `[other]`; the result is success and not torn.
- `storage-repo.spec.ts` › mixed batch › "applies the log tail first whatever order the request lists, so no block lands without it". Arm 1: `[OK, BLOCK]` with BLOCK as a tail that has no base → refused, and OK (listed ahead of it) is NOT committed. Arm 2: both committable, tail listed last → the change event lists `[TAIL, OK]`. Negative control: with the reorder disabled, arm 1 fails ("sibling not reached ahead of its tail").

Updated, each still testing what its title says:
- `network-transactor.spec.ts` › "excludes a cached coordinator by peer id…": the dead peer is now dialed 3 times (one round, tail round, sweep), not 2; the live-lookup count (3) is unchanged. "commit non-tail conflict surfacing" is untouched: its mocks route each block to its own coordinator, so it exercises the two-step path (comment added saying so).
- `storage-repo.spec.ts` mixed-batch tests that listed a non-tail block first and expected it applied first now name that block as the tail (`commitMixedBatch` takes the tail, defaulting to the first listed; the genuine-fault test uses `tailId: FAULT`).
- `torn-commit-cancels-abandoned-blocks.spec.ts`: the production-path arm now fails every commit carrying a non-tail block (`carriesNonTail`), so the one round throws, the fallback commits the tail, and the sweep throws → torn, cancelled. It asserts the injection fired at least twice. The conflict arm is retitled "on a non-tail block"; which path it takes depends on ring placement (a3 never pended S, so S's coordinator is looked up live and may differ from T's), and the comment says so.
- `member-leaves-and-returns.spec.ts`: C now drops on the commit step carrying non-tail blocks (the one round). **The long arm changed substance** (see gaps): C misses the tail too, so phase 4 now waits out C's read-repair window (10 s, written out as `READ_REPAIR_WINDOW_MS`) before C reads. Observed under debug logging: C's first read consults the cohort and restores the tail (`cluster-tx:read-repair-applied`), then its pending records for the data blocks are promoted by the read context. The header says this.
- `member-missed-commit-heals-at-commit.spec.ts`: prose only. The hook already matched the one round (it carries the tail); it passed unchanged.
- `rival-superseded-only-by-a-writer-that-built-on-it.spec.ts`: the scenario needs R's tail landed while R's data commit is held, which only the two-step path produces. The writer-side wrapper now throws R's one-round commit before it reaches anyone, forcing the fallback; the data stage is held as before.
- `superseded-own-write-is-saved.spec.ts`: `missTheNextDataCommit` now applies the tail part of the commit for real and fake-refuses the rest, reproducing the "member holds the tail, not the data" state cases 2 and 3 are built on.
- `half-landed-write-is-finished.spec.ts`, `concurrent-diary-append-acknowledgement.spec.ts`: prose only (they construct a tail-only landing at the transactor level, now described as the two-step path's shape).

## Validation run

- `yarn test` in `packages/db-core`: 1834 passing.
- `yarn test` in `packages/db-p2p`: 3108 passing, 63 pending, 0 failing.
- `yarn test:integration` from the root: db-p2p 44 passing, 2 pending; quereus-plugin-optimystic 1002 passing, 8 pending (same counts as the prereq's run).
- `yarn test` in `packages/reference-peer`: 6 passing.
- `tsc --noEmit` in db-core and db-p2p clean; `eslint` on every changed `.ts` file clean; `yarn lint:docs` clean.

## Known gaps and things to weigh

- **A member that misses the commit round now misses the log tail too.** Before, a member dropping during the sweep still held the tail, and its first read promoted the rest at once. Now it lacks the tail, and its reads serve its own older copy until its read-repair window (10 s default) lapses, then read repair fixes it. That is the documented lazy-window staleness bound, and a member dropping during the old tail round was already in this state. But the instant-heal case is gone, and `member-leaves-and-returns`' long arm now costs about 10 s more wall-clock. If this matters: a member holding a pending record for a block it serves without context could consult early. That is a read-path design change, not made here.
- **Mesh coverage of the two-step path now comes only through the thrown-one-round fallback** (torn-commit production arm, rival-superseded phase 2). The genuine multi-batch plan (two coordinators) is exercised only by db-core mocks. The mesh fixture is still backlog `debt-no-mesh-fixture-forces-two-coordinator-batches`, and the `cancelAbandonedSweepBlocks` NOTE is still accurate.
- **Commit planning does not use cluster intersection.** For blocks with no pend-cache entry (a commit of blocks this transactor never pended), `findCoordinator` may pick different peers even when one peer covers all, and the commit goes two-step. In the normal pend→commit flow every block is cached. Seen only in the torn-commit conflict arm's odd shape.
- **Costs of a thrown one round**: the fallback starts from the same cached coordinator, so a dead coordinator is dialed once more, and a round that hangs to its deadline adds one `timeoutMs` before the fallback starts. Both are stated in `commitInOneRound`'s doc. On a lookup failure during planning, the two-step path repeats the lookups.
- **Own-durable tail plus rival-held block** (a completion re-send after a rival took a data block): `confirmCommitRivalAgainstLocal` bails as `own-durable` on the first own-held block, so the one round's validator rejection is rethrown rather than classified. The fallback then gets the classified conflict from the sweep. That is one extra round, with the correct answer. Inferred from reading; the own-entry mesh specs pass, but none pins this exact shape.
- **One round is refused whole where two rounds tore**: a returned refusal (a rival holding any block, or `commit-not-durable`) now stops the tail from committing anywhere the refusal came before apply. This is strictly fewer torn actions, and `completeOwnEntry` handles both "entry found, blocks missing" and "entry found, everything present" on a minority.
- **Reactivity**: the combined apply emits one `CollectionChangeEvent` per collection covering every block, instead of one for the tail and one for the sweep. Watchers invalidate coarsely, so this was checked by reading only.
- Pre-existing, not touched: `packages/db-core/docs/network.md` still claims "Commit failures: Cannot occur after tail commit succeeds" and "Commit Conflict → Cannot happen after tail commit", which were already wrong (a sweep block can conflict). I only added the one-round paragraph there.
