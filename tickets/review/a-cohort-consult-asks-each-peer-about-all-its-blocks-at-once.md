description: When a machine checks several blocks with the other members of its group in one read, it now asks each member about all of that read's blocks in a single request instead of one request per block, so a read of a table's header and log tail costs one request per member rather than two.
prereq: a-cohort-consult-sends-bytes-only-when-the-peer-is-ahead
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-p2p/src/repo/consult-round.ts (new), packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/sync/protocol.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/storage/block-archive.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/protocol-limits.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/test/consult-round.spec.ts (new), packages/db-p2p/test/block-archive-proof.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, docs/transactions.md, docs/internals.md, docs/debugging.md
----

# A cohort consult asks each peer about all its blocks at once — review handoff

GitHub [#29](https://github.com/gotchoices/Optimystic/issues/29) question 3 and [#43](https://github.com/gotchoices/Optimystic/issues/43) arm 1. Built on the wire shape of `a-cohort-consult-sends-bytes-only-when-the-peer-is-ahead` (`SyncRequest.held`, `SyncResponse.answers`, `serveConsultAnswer`).

## What was built

**The round (`ConsultRound`, `packages/db-p2p/src/repo/consult-round.ts`).** Each `CoordinatorRepo.get` that consults opens one round. Every per-block pass that consults — the blocking path in `readRepairBlock`, and the background path only when `startHeldBlockConsult` actually starts a pass — `join()`s a seat synchronously, before the pass's first await. `get` calls `round.close()` right after the `blockIds.map(...)` that starts the passes. `queryClusterForLatest` registers each per-peer question through `seat.ask` (inside the existing `withDeadline`, asker stand-in exclusion unchanged) and calls `seat.ready()` before awaiting `Promise.allSettled`. `leavingSeat(seat, pass)` readies the seat when `fetchBlockFromCluster` returns or throws, so exits that ask nobody (empty cohort, solo-self, thrown `findCluster`) release the barrier. When the round is closed and every seat is ready it sends, per peer, one `batch` call per chunk of `MAX_CONSULT_BATCH_BLOCKS` (32) distinct blocks in registration order. Self goes through `single`. Rules: batch rejects → every question in that chunk rejects (silence); a block missing from `answers` → only that question rejects; `unbatched` → first block settles from the reply, the rest go through `single` in parallel, logged `cluster-fetch:consult-unbatched`; `ask` after `ready()` or after send, and `join` after `close`, throw. Duplicate (peer, block) registrations share one ask.

**Wiring.** New optional `clusterLatestBatchCallback` on `CoordinatorRepoComponents`, passed by the factory as a new last positional constructor parameter. Absent → no round, behaviour exactly as before (every hand-built spec double keeps its path). `openConsultRound` builds the round only when both callbacks exist.

**Wire.** `SyncRequest.blockIds?` (first element MUST equal `blockId`; requires `held`), `SyncContentOmitted` gained `'size'`. No protocol version bump: an older server answers `{ success, archive }` for `blockId` alone, which the batch callback reports as `unbatched`.

**Serving.** `SyncService.answerConsult` now answers every id of `blockIds` (or `blockId` alone), distinct, first 32, sequentially, each through the existing per-block caught `buildConsultAnswer`, then `fitConsultContent` (new, `storage/block-archive.ts`) applies the budget: in request order, an answer carrying bytes keeps them if it is the first carrying bytes or the running JSON-encoded byte total stays within `CONSULT_RESPONSE_CONTENT_BUDGET_BYTES` (4 MiB, half of `MAX_BLOCK_MESSAGE_BYTES`); otherwise it is reduced to claim + proof with `contentOmitted: 'size'`. `claimFromConsultAnswer` already dropped the archive for any reason other than `'held'`, so a `'size'` peer is left out of `ConsultedArchives` and the acquisition asks it again via `fetchArchiveFromPeer`; its comment now names `'size'`.

**Node (`libp2p-node-base.ts`).** `clusterLatestBatchCallback` sends `{ blockId: blockIds[0], blockIds, held, rev: undefined }` under the same `withinRequestBudget(…, cohortQueryTimeoutMs, …)`. Both callbacks project through `claimFromConsultAnswer`, and both read an older peer's single-archive response through the new shared `answerFromArchiveResponse`, which replaced the single callback's inline `latestClaimFromArchive` branch (behaviour unchanged).

**Harness.** `createMesh` supplies a batch callback that serves each block via the shared `consultAnswerOf` (reads under the asker's context first, then `serveConsultAnswer`, as the single callback always did), applies `fitConsultContent` for parity, honours `silentPeers`, and counts requests per (asker, target) — `Mesh.consultRequests(asker, target)`. The single callback is kept; it now counts too, but never counts a node asking itself.

**Exports.** `consult-round.js` is exported from both `src/index.ts` and `src/rn.ts` (the entry-parity spec requires both).

**Docs.** `docs/transactions.md` § Lazy read-repair window: the "Batching … is not done" sentence is replaced by a paragraph on the round; the *A consult says what this node holds* paragraph gains the size budget; step 2 of the repair says a `'size'` peer is asked by the acquisition. `docs/internals.md` gains "batched per peer within one read". `docs/debugging.md` gains a `cluster-fetch:consult-unbatched` section.

## Tests added

- `packages/db-p2p/test/consult-round.spec.ts` (new), against fake batch/single callbacks:
  - two seats, blocks with different cohorts → one batch per peer, each naming only its registered blocks, nothing sent while a seat is still registering;
  - a seat that leaves without asking does not hold the send;
  - batch rejection → every question in the request rejects;
  - a block missing from `answers` → only it rejects, the other's "holds nothing" resolves;
  - `unbatched` → first block from the reply, the rest through `single` with their `held`;
  - self → `single`, never `batch`;
  - cap + 1 blocks → two batch calls (32, 1).
- `packages/db-p2p/test/block-archive-proof.spec.ts` › `fitConsultContent`: the first block keeps its bytes whatever the budget, a later one past it comes back `'size'` with its proof and its own revision and no bytes, `claimFromConsultAnswer` returns its claim without the archive, holds-nothing passes through, and a generous budget leaves everything intact.
- `packages/db-p2p/test/coordinator-repo-read-repair.spec.ts` › "asks each cohort peer about every block of a read in one request": 3-node mesh, two blocks held by the other two nodes, a two-block `get` on the reader sends exactly one request to each peer and acquires both blocks from the answers. Mutation-checked: with the harness's batch callback removed it fails (2 per peer).

## Validation run

- `tsc --noEmit` for db-p2p (src + test): clean. `yarn lint`, `yarn lint:docs`: clean. `yarn check:rn`: passed.
- db-p2p full suite: 3499 passing, 73 pending; the one failure (entry parity: new module missing from `rn.ts`) was fixed and that spec re-run green.
- `yarn test:integration` from root: db-p2p 50 passing, quereus-plugin-optimystic 1060 passing (its integration script runs its whole suite).
- `@optimystic/upgrade-check` 115 passing, `@optimystic/reference-peer` 6 passing.

## Known gaps and choices for the reviewer

- **The immediately previous build reads `held` but not `blockIds`.** Such a server answers `answers` with only the first block, which the round reads as silence for the rest (not `unbatched`). That build is unreleased — `v1.16.0` (2026-10-19) predates `held` — so no deployed peer can be on it; I did not add a heuristic for it. If a build from between the two tickets is running anywhere, it would cost a silent-flagged consult per extra block until upgraded.
- **Deadline starts at registration, not at send** (tripwire `NOTE:` in `queryClusterForLatest`). One seat's slow `findCluster` (the bounded bootstrap-contact wait) is spent out of every other question in the round.
- **One seat's lookup delays the round.** A block whose `findCluster` is slow holds back the other blocks' requests of the same read; previously they were independent. Same root as the previous bullet.
- **Server serves sequentially**, no bounded concurrency. Each block is a local read and a read names a handful; fine unless a 32-block consult shows up in profiles.
- **Measuring cost.** `fitConsultContent` JSON-encodes every byte-carrying archive once to measure it, including the only answer of a one-block consult where nothing later could need the total. Accepted by the plan; skipping the measure for the last carrying answer would remove it if it ever matters.
- **No cross-read coalescing**, by design: concurrent `get`s each open their own round.
- **Not changed:** `CommitLogTrustAnchor` still uses the single callback (and still gets bytes, per the prereq's `NOTE:`); `fetchArchiveFromPeer` is unchanged.
- The `unbatched` path is covered only by the round unit spec; the mesh harness never plays an older peer.
