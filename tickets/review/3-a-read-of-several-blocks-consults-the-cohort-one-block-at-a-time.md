description: When a node answers a read naming several blocks, it now checks all of them with its cohort peers at the same time instead of one after another, so a table refresh (which reads two blocks together) costs one network wait on a slow link instead of two.
architecture: docs/transactions.md#read-consistency-and-staleness
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`CoordinatorRepo.get` now fans out over `readRepairBlock`, the extracted per-block pass)
  - packages/db-p2p/test/coordinator-repo-read-repair.spec.ts (new test at the end: "consults the cohort for every block of a multi-block read at once, not one after another")
  - docs/transactions.md (§ Lazy read-repair window: new paragraph "A read naming several blocks consults for all of them at once")
----
# A read of several blocks consults the cohort concurrently

## What changed

`CoordinatorRepo.get` used to walk `blockGets.blockIds` with `for … of` and `await` each block's cohort consult (`fetchBlockFromCluster`) plus its refreshed local read, so block N+1's consult started only after block N's finished. Measured in sereus's re-attach scenario at 900 ms one-way latency, a two-block read (the header + log-tail read every live query's refresh makes, `Collection.readLogEnds`) took two consults back to back, about 7.3 s instead of about 3.6 s.

Now:

- The whole per-block body moved, unchanged apart from `continue` → `return` and `localResult` → `results`, into `private async readRepairBlock(blockId, blockGets, results, options)`. It still owns its own `try/catch`, so a thrown consult flags only its block.
- `get` deduplicates the ids (`[...new Set(blockGets.blockIds)]`) and runs `Promise.all` over `readRepairBlock`. Deduplicating keeps one block from having two passes running against its own freshness stamp and unsettled-claim memo.
- The responsibility pre-check at the top of `get` is left serial, as the ticket allowed (a cached local lookup).
- Two comments that pointed at "the mapping in the loop body" / "in `get`" now point at `readRepairBlock`.

Every per-block decision (triggers, verdicts, flags, log lines, the refreshed re-read with `lineageOf`) is the same code as before. The only observable differences are timing, and that log lines for different blocks of one read now interleave. Each line already carries `blockId`.

## Test added

- `coordinator-repo-read-repair.spec.ts`, "consults the cohort for every block of a multi-block read at once, not one after another": two blocks both present at rev 1, lazy mode with no stamp (so both consult), a two-member cohort. The remote peer's `clusterLatestCallback` stub holds each call open until both block ids have arrived, with a 250 ms fallback (under the 1000 ms default per-peer deadline) so the serial code finishes rather than hangs. It asserts both consults were in flight at once (`mostOpenAtOnce === 2`) and both entries come back. No timing assertions. I checked it both ways: with `get` temporarily switched back to a serial `for … await` it fails (`expected 1 to equal 2`, in about 550 ms), and with the concurrent code it passes.

## Validation run

- `yarn workspace @optimystic/db-p2p build`: clean (tsc).
- `yarn workspace @optimystic/db-p2p test`: 3149 passing, 63 pending (pending are the env-gated long/integration specs), 0 failing. Log: `tickets/.logs/multi-block-read-concurrent.test.log`. I made two comment-only edits after that run and re-ran the read-repair specs plus `member-leaves-and-returns.spec.ts`: all passing. (Running `--grep "read-repair"` on its own picks up only phase 4 of `member-leaves-and-returns.spec.ts`, a sequenced spec, which then fails for lack of its earlier phases. That comes from the grep filter, not from the code; the whole file passes.)
- `yarn lint:docs`: all citations resolve. `eslint` on both changed source files: clean.

## For the reviewer: gaps and things worth checking

- **Not measured end to end.** I did not re-run the sereus re-attach measurement (it lives in the sereus repo), so I can't give a number for the two-block read after this change. At about four one-way delays per consult it should drop from about 7.3 s to about 3.6 s.
- **What still runs outside `readRepairBlock`'s try:** the trigger decision (`shouldReadRepair`, `floorDemandsConsult`), the `read-repair-triggered` log, and the no-consult `flagUnconfirmedCurrency`. None of them makes an I/O call or should throw. If one did (a programming error), `get` would reject as it did before, but with `Promise.all` the other blocks' passes would keep running in the background after the rejection. Before the change they simply never started. I judged that acceptable and did not wrap it.
- **Shared state was checked by reading the class, not by a test.** Every piece of mutable instance state is either keyed by block id (`lastSeenCommitMs`, `unsettledAheadClaims`, `responsibilityCache`, `stuckReservations`) or lives outside this path. Reputation reports are per peer and are additive, so two concurrent silent consults report a peer twice, the same count the serial loop produced. Acquisition (`restoreCorroborated` → `saveReplicatedBlock`) latches per block. If a reviewer finds per-peer or per-read state in `queryClusterForLatest` or `restoreCorroborated` that I missed, it now races.
- **Streams per peer are unchanged in count, only concurrent:** one sync-service stream per block per peer. As the ticket said, batching a read's blocks into one request per peer is out of scope. It would save streams but not time.
- **Related, not done here:** sibling ticket `a-coordinator-asks-the-reader-what-the-reader-already-holds` (skip consulting the reader when the coordinator's copy is at least as current as what the reader holds).
- **No debugging.md change.** Reading the trace, `cluster-tx:read-repair-triggered` lines for the blocks of one `get` now appear together rather than each paired with its own `applied`/`noop`. `blockId` on each line is enough to pair them, so I didn't add a note. Add one if you think operators will misread it.
