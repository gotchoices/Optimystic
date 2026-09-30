description: When a node answers a read naming several blocks, it now checks all of them with its cohort peers at the same time instead of one after another, so a table refresh (which reads two blocks together) costs one network wait on a slow link instead of two.
architecture: docs/transactions.md#read-consistency-and-staleness
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`CoordinatorRepo.get` fans out over `readRepairBlock`, the extracted per-block pass)
  - packages/db-p2p/test/coordinator-repo-read-repair.spec.ts ("consults the cohort for every block of a multi-block read at once, not one after another")
  - docs/transactions.md (§ Lazy read-repair window: "A read naming several blocks consults for all of them at once")
  - docs/debugging.md (§ `cluster-tx:read-repair-triggered`: pair trigger and outcome lines by `blockId`)
----
# A read of several blocks consults the cohort concurrently

## What landed

`CoordinatorRepo.get` used to walk the requested block ids with `for … of`, awaiting each block's cohort consult (`fetchBlockFromCluster`) and refreshed local read before starting the next. A two-block read (the collection header plus the log tail that every live query's refresh makes, `Collection.readLogEnds`) therefore cost two consults back to back, about 7.3 s instead of about 3.6 s at 900 ms one-way latency in sereus's re-attach scenario.

The per-block body now lives in `private async readRepairBlock(blockId, blockGets, results, options)`, unchanged apart from `continue` → `return`. `get` removes duplicate ids and runs `Promise.all` over it. Each pass keeps its own `try/catch`, so a consult that throws flags only its block. The responsibility pre-check at the top of `get` stays serial (a cached local lookup). Behaviour is otherwise identical; only timing changes, and log lines for different blocks of one read now interleave.

Implement commit: `ticket(implement): a-read-of-several-blocks-consults-the-cohort-one-block-at-a-time`.

## Review findings

**Checked**
- The diff, read before the handoff: the extracted body matches the old loop body line for line apart from the loop-control and variable renames; `options` and `lineageOf` still reach the refreshed read; dedup happens after `storageRepo.get` so the result map still has an entry for every requested id.
- Shared mutable state across concurrent passes, by reading the class: `lastSeenCommitMs`, `unsettledAheadClaims`, `responsibilityCache`, `stuckReservations` and the deadlock-report suppression all key by block id; `queryClusterForLatest` keeps everything (claims, silent, answered, proof verdicts) in locals; reputation reports are per peer and additive, same totals as the serial loop; acquisition (`restoreCorroborated` → `acquireBlockFromCohort` → `saveReplicatedBlock`) latches per block, so two different blocks never contend. No per-read or per-peer state was found that now races.
- Determinism of the lazy window's sampling: `shouldReadRepair` (which calls `this.rand()`) runs before the first `await` in each pass, and `map` starts the passes synchronously in order, so the sequence of random draws per block is the same as before.
- Error paths: a thrown consult is still caught per block. The trigger-decision code outside the `try` makes no I/O call; if a programming error threw there, `get` rejects as before, with other passes finishing in the background. Accepted as the implementer described; not wrapped.
- The new test: holds each remote consult open until both blocks' consults have arrived, with a 250 ms fallback under the 1000 ms per-peer deadline. It pins the one behaviour the ticket changes (both consults in flight at once), has no timing assertions, and the implementer confirmed it fails against the serial loop. Kept.
- Docs: read the new transactions.md paragraph (accurate), and every doc/comment that described the old serial walk.

**Found and fixed inline (minor)**
- Stale comment in `restoreCorroborated`: its `NOTE:` said "`get` walks its block ids sequentially … a multi-block read that is missing N blocks against a wholly stalled cohort waits N × this", and recommended making the repair concurrent if that ever mattered. That is now what `get` does, so the note was wrong. Rewritten to say the bound is per block, passes run concurrently, and the bound should not be shortened.
- docs/debugging.md § `cluster-tx:read-repair-triggered` described reading a trigger "followed by" its outcome line. With concurrent passes, a multi-block read's triggers can all appear before any outcome, so added one sentence: pair triggers with `read-repair-applied` / `read-repair-noop` by `blockId`, not by adjacency. (The implementer had left this out and asked the reviewer to judge.)

**Major findings / tickets filed**: none. Nothing found that needs work beyond this ticket.

**Tripwires recorded**: none new. The pre-existing size of `coordinator-repo.ts` (3210 lines, `wc -l`) is not changed materially by this ticket and is not re-filed here.

**Not verified**: the end-to-end sereus re-attach measurement (it lives in the sereus repository); the expected drop from about 7.3 s to about 3.6 s for the two-block read is inferred, not measured.

**Validation**
- `yarn workspace @optimystic/db-p2p build`: clean.
- `eslint packages/db-p2p/src/repo/coordinator-repo.ts`: clean.
- `yarn lint:docs`: all citations resolve.
- `yarn workspace @optimystic/db-p2p test`: 3149 passing, 63 pending (env-gated), 0 failing.
