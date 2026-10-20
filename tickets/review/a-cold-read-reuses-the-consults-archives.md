description: When a machine reads a block it does not have, it used to ask a member of its group for the block twice (once to decide which version to adopt, then again for the bytes); it now keeps the first answer and restores from it, so each missing block costs one request per member instead of two.
architecture: docs/transactions.md#read-consistency-and-staleness
files: packages/db-p2p/src/repo/coordinator-repo.ts (`ClusterLatestAnswer`, `ClusterLatestCallback`, `ClusterLatestQuery.consulted`, `queryClusterForLatest`, `fetchBlockFromCluster`, `restoreCorroborated`), packages/db-p2p/src/cluster/cluster-repo.ts (`ReconcileBlockCallback`, `ConsultedArchives`), packages/db-p2p/src/cluster/reconcile-block.ts (`fetchAnswer`, `answerFrom`, `createReconcileBlock`), packages/db-p2p/src/libp2p-node-base.ts (`clusterLatestCallback`, `fetchArchiveFromPeer`, the `latestClaimFrom` adapter for `CommitLogTrustAnchor`), packages/db-p2p/src/testing/mesh-harness.ts (`clusterLatestCallback`), packages/db-p2p/test/coordinator-repo-read-repair-content.spec.ts, docs/transactions.md, docs/internals.md, docs/debugging.md, packages/db-p2p/docs/cluster.md
----
# A cold read reuses the consult's archives

GitHub [#39](https://github.com/gotchoices/Optimystic/issues/39), arm 1. Measured there: a joiner attaching a two-table strand made 16 sequential `sync` requests for 8 distinct blocks, each fetched twice (`cluster-fetch:certified-selected` then `reconcile:certified-selected`), about 1.6 s of a ~2.4 s attach over a relay. Arm 2 (`a-collection-open-reads-its-log-ends-once`) is independent.

## What changed

A read-repair pass (`CoordinatorRepo.fetchBlockFromCluster`) is a consult followed, when the cohort corroborates a revision ahead of this node, by an acquisition. Both used to send each cohort peer the identical `requestBlock({ blockId, rev: undefined })`, whose reply is the peer's whole archive, block bytes included. The consult kept only the claim.

- `ClusterLatestCallback` now resolves `ClusterLatestAnswer` = `CertifiedActionRev & { archive?: BlockArchive }`. The three-way contract (claim / `undefined` = holds nothing / rejection = silent) is unchanged; the field is optional, so doubles that return a bare claim compile and keep the old behaviour (their acquisition fetches).
- `queryClusterForLatest` returns `consulted: ConsultedArchives` (`ReadonlyMap<string, BlockArchive | undefined>`), filled per peer: archive-carrying claim → the archive; resolved `undefined` → `undefined`; silent (rejected or past deadline) → `undefined`; claim without an archive → absent; self → absent.
- `fetchBlockFromCluster` → `restoreCorroborated` → `acquireBlockFromCohort(blockId, corroborated, cohortPeerIds, consulted)`. `ReconcileBlockCallback` gained the optional fourth argument.
- `createReconcileBlock`'s `fetchAnswer` builds a peer's `PeerAnswer` from the map when the peer is in it (`undefined` → `no-archive`, archive → `toCandidate` as for a fetched one, via the shared `answerFrom`) and only calls `deps.fetchArchive` for a peer absent from it. The commit path passes no map and is unchanged.
- Producers: the real `clusterLatestCallback` returns `{ ...claim, archive: response.archive }` (the self short-circuit returns none). The `latestClaimFrom` adapter for `CommitLogTrustAnchor` strips the archive so the anchor does not hold it. The mesh harness attaches `serveBlockArchive(target.storageRepo, blockId)` (unpinned — the same archive `makeFetchArchive` serves), so mesh-tier specs run the reuse path.
- Removed the NOTE above `fetchArchiveFromPeer` (its remedy is now done) and rewrote the "re-fetches an archive on every read" sentence in the NOTE inside `fetchBlockFromCluster`.
- Docs: `docs/transactions.md` § Read Consistency and Staleness step 2, the `cohortQueryTimeoutMs` table row and the "never reaches the acquisition" sentence; `docs/internals.md` *A behind member actively reconciles*; `packages/db-p2p/docs/cluster.md` (the `cohortQueryTimeoutMs` bullets); `docs/debugging.md` (the `noArchive` field of `reconcile:no-rev-quorum`, which on the read path now also counts a peer silent in that read's consult).

## Deviations from the plan

- `ConsultedArchives` lives in `cluster/cluster-repo.ts` beside `ReconcileBlockCallback` (the type that consumes it), not in `coordinator-repo.ts`. `cluster-repo.ts` would otherwise have to import a type from the repo layer above it. `coordinator-repo.ts` imports it from there.
- The boundary spec "never fetches an archive for a block no peer claims" could not stay as it was: its control asserted a corroborated block reaches `fetchArchive`, which it no longer does. It is now "never runs the acquisition for a block no peer claims", counting acquisition passes (zero for the absent id, plus one request to A, the consult) with the same corroborated-block control on the acquisition counter.
- An asker whose stand-in statement was "holds nothing" lands in the map as `undefined` and is not asked (the plan's table only covered a stand-in that holds something, which stays absent and is asked). It has nothing to supply, so asking would buy nothing.

## Tests

- `coordinator-repo-read-repair-content.spec.ts` — the spec's consult double is now production-shaped (A answers `{ ...claim, archive }` from one `serveArchive`), and one counter covers every request B makes of A, consult or fetch.
  - added `a block it has never seen costs one request to the peer that holds it`: `seedB: false`, the read serves `v2`, B holds rev 2, requests to A === 1. Mutation-checked: with `fetchAnswer` ignoring the map it fails at 2.
  - reworked `never runs the acquisition for a block no peer claims` (see deviations).
- The other specs in that file (a stale block selected and converged, the promotion and step-over paths) now run through the reuse path and stay green. The `createReconcileBlock` specs (`reconcile-block.spec.ts`, `mesh-reconcile-quorum.spec.ts`) call it without a map and stay green, so the commit path, certification, `digest-mismatch` rejection and penalties are unchanged.

## Validation run

- `tsc --noEmit` in `packages/db-p2p` (covers `src` and `test`): clean. eslint on the changed files: clean. `yarn lint:docs`: all citations resolve.
- Full `packages/db-p2p` suite: 3485 passing, 73 pending, 0 failing. Run with `OPTIMYSTIC_SKIP_BUILD_CHECK=1` for one reason: the sibling `p2p-fret` repository (`C:\projects\Fret`) has another agent's uncommitted, in-progress source edits, which make its `dist` read as stale. I did not rebuild it, since that would compile their unfinished work into what these tests load; its `dist` matches its committed source, and this ticket does not touch FRET. `@optimystic/db-core`'s `dist` was also flagged stale with no source edits (mtimes only) and was rebuilt clean.
- Not run: `yarn test:integration` (real TCP meshes) and the other packages' suites. Nothing outside `db-p2p` implements or calls the changed types (grep across `packages/`).

## For the reviewer

- **Given up on purpose:** a peer silent in the consult is never asked by the acquisition, so a peer that recovers between the two steps is not heard until the next consult. Before, the acquisition re-asked it and could wait out one more `cohortQueryTimeoutMs`.
- **The restored revision is the one the consult saw.** Re-fetching could return a newer revision than the consult corroborated, which then had to win its own quorum. Reusing the archives restores exactly what was corroborated.
- **Memory:** archives now live until `restoreCorroborated` returns, one per cohort peer per block pass in flight. That is bounded by cohort size and by `MAX_HELD_BLOCK_CONSULTS` for background held-block consults; foreground reads of missing blocks are bounded by the read's own block count. Checked by reading the code only.
- **The mesh harness** now runs one extra in-memory `serveBlockArchive` per consult call, even when no acquisition follows. It is cheap, and it keeps the harness's consult answer shaped like production's.
- Checked by reading the code, no test: a stand-in asker that holds the block is asked by the acquisition; a promotion that succeeds first leaves the map unused; an archive whose top revision is below the corroborated one gives `behind`; absence and currency verdicts read only `claims`, `silent` and `answered`, so the map changes neither.
- `MAX_HELD_BLOCK_CONSULTS`'s comment still mentions "the archive fetches that acquisition runs over the same protocol". It is still true for peers the consult has no archive from, so I left it.
