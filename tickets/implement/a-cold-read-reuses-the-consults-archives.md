description: When a machine reads a block it does not have, it asks another member of its group for the block and then, after deciding which version to adopt, asks the same member for the same block again; keep the first answer and restore from it, so each missing block costs one request per member instead of two.
architecture: docs/transactions.md#read-consistency-and-staleness
files: packages/db-p2p/src/repo/coordinator-repo.ts (`ClusterLatestCallback`, `ClusterLatestQuery`, `queryClusterForLatest`, `fetchBlockFromCluster`, `restoreCorroborated`, `AcquireBlockCallback`), packages/db-p2p/src/cluster/cluster-repo.ts (`ReconcileBlockCallback`), packages/db-p2p/src/cluster/reconcile-block.ts (`createReconcileBlock`, `fetchAnswer`), packages/db-p2p/src/libp2p-node-base.ts (`clusterLatestCallback`, `fetchArchiveFromPeer` and its NOTE), packages/db-p2p/src/testing/mesh-harness.ts (`clusterLatestCallback`, `makeFetchArchive`), packages/db-p2p/src/cohort-topic/commit-log-trust-anchor.ts (the `latestClaimFrom` adapter in `libp2p-node-base.ts`), packages/db-p2p/test/coordinator-repo-read-repair-content.spec.ts, docs/transactions.md, docs/internals.md
----
# A cold read reuses the consult's archives

GitHub [#39](https://github.com/gotchoices/Optimystic/issues/39), arm 1. Arm 2 (open a collection's log ends once, open a table's trees concurrently) is the separate implement ticket `a-collection-open-reads-its-log-ends-once`; the two are independent.

## What happens today

A coordinator reading a block it lacks (or holds at an older revision than the cohort) runs one read-repair pass (`CoordinatorRepo.fetchBlockFromCluster`):

1. **Consult.** `queryClusterForLatest` calls `clusterLatestCallback` once per cohort peer. On a real node that is `SyncClient.requestBlock({ blockId, rev: undefined })` — the peer's whole archive for the block, block bytes included — and the callback keeps only the claim projected out of it (`latestClaimFromArchive`: revision, action id, proof). The archive is dropped.
2. **Acquire.** When the cohort corroborates a revision ahead of what this node holds, `restoreCorroborated` runs `acquireBlockFromCohort`, which is the commit path's `createReconcileBlock` callback. Its `fetchAnswer` calls `fetchArchiveFromPeer` for every cohort peer: the identical `requestBlock({ blockId, rev: undefined })` request. The NOTE above `fetchArchiveFromPeer` in `libp2p-node-base.ts` already records this and names the remedy: carry the consult's archive through to the acquisition.

Measured in #39 (two relay-only parties, Optimystic 1.15.0): a joiner attaching a two-table strand made 16 sequential `sync` requests — 8 distinct blocks, each fetched exactly twice, `cluster-fetch:certified-selected` then `reconcile:certified-selected` for each — about 1.6 s of a ~2.4 s attach on relay.sereus.org.

## The change

The consult hands the acquisition every answer it already has. The acquisition asks a peer only when the consult has no answer from it that can stand in.

**Callback result.** `ClusterLatestCallback` resolves to a claim that may carry the archive it was projected from:

```ts
/** One cohort peer's consult answer: its claim, and the archive the claim was read out of when the
 *  transport fetched one. The archive lets an acquisition that follows restore from this answer
 *  instead of asking the peer again (see `restoreCorroborated`). */
export type ClusterLatestAnswer = CertifiedActionRev & { readonly archive?: BlockArchive };
export type ClusterLatestCallback = (peerId: PeerId, blockId: BlockId, context?: ActionContext) => Promise<ClusterLatestAnswer | undefined>;
```

The three-way contract is unchanged (a claim; `undefined` for "holds nothing"; a rejection for silence). The field is optional, so every test double that returns a bare `CertifiedActionRev` still compiles and keeps today's behaviour (its acquisition fetches).

**What the consult records.** `queryClusterForLatest` returns, alongside its current fields, the consult's answers in the form the acquisition consumes:

```ts
/** Per cohort peer, what the consult already learned that an acquisition can use instead of asking
 *  again: the archive it served, or `undefined` when it served none. A peer ABSENT from the map is
 *  one the acquisition must still ask. */
export type ConsultedArchives = ReadonlyMap<string, BlockArchive | undefined>;
```

Filled per peer as follows:

| consult outcome for the peer | in the map | acquisition |
|---|---|---|
| claim carrying `archive` | `archive` | reuses it |
| resolved `undefined` ("holds nothing") | `undefined` | treats as `no-archive`, does not ask |
| silent (rejected, or past the per-peer deadline) | `undefined` | treats as `no-archive`, does not ask |
| claim with no `archive` (the asker's stand-in statement from `askerStandIn`, a test double) | absent | asks, as today |
| this node | absent | excluded already (reconcile drops self from its targets) |

**Plumbing.** `fetchBlockFromCluster` passes the map to `restoreCorroborated`, which passes it to `acquireBlockFromCohort` as a new optional fourth argument. `ReconcileBlockCallback` (and so `AcquireBlockCallback`) gains `consulted?: ConsultedArchives`. In `createReconcileBlock`, `fetchAnswer` takes the map and, for a peer present in it, builds the `PeerAnswer` from the map's value (`undefined` → `no-archive`; an archive → `toCandidate` exactly as for a fetched one) without calling `deps.fetchArchive`. The commit path (`ClusterMember`'s reconcile after a behind-shaped commit, including `reconcileRefusedCommit`) passes nothing and is unchanged.

**Producers.** The real `clusterLatestCallback` in `libp2p-node-base.ts` returns `{ ...claim, archive: response.archive }`. The self short-circuit returns no archive. The `latestClaimFrom` adapter handed to the commit-log trust anchor maps the answer down to the claim, so the anchor does not hold archives it never reads. The mesh harness's `clusterLatestCallback` attaches the archive `makeFetchArchive` would have served for the same peer — `serveBlockArchive(target.storageRepo, blockId)`, unpinned, as production's consult is — so mesh-tier specs exercise the reuse path.

**Docs and notes.** Remove the NOTE above `fetchArchiveFromPeer` (its remedy is now done) and the "re-fetches an archive on every read of that block" sentence in the NOTE inside `fetchBlockFromCluster` (a persistently failing acquisition of a missing block now costs the consult only). Update `docs/transactions.md` § Read Consistency and Staleness (step 2, "Acquire the bytes from the cohort", currently names `fetchArchiveFromPeer`) and the `cohortQueryTimeoutMs` row of its table, which says the per-peer budget covers "the archive fetch the acquisition runs" — that fetch now runs only for a peer the consult did not answer for.

## Decisions settled here

**The second request adds no corroboration, so dropping it loses none.** The acquisition re-asked the same peers the same question within milliseconds. Its rev quorum (`selectQuorumRev` over the archives' top revisions) and the consult's (`selectQuorumRev` over the claims projected from the same archives) are computed from the same answers, so they select the same revision; the content gate (`selectQuorumBlock`) and the content certification (`certifyContent` on each carrier's bytes, with `digest-mismatch` rejection and penalties) still run, now on the bytes the consult received. With a single claimant — #39's case, a founder's one-signer certified proof in a two-member group — the second request was that same peer's word read twice. The one thing the old re-fetch could add was a peer that was silent in the consult answering the acquisition; that is given up deliberately (next point).

**A peer silent in the consult is not asked again by the acquisition.** The consult already reached its corroboration without that peer, and re-asking it made every acquisition behind a silent peer wait up to one more `cohortQueryTimeoutMs` for an answer that rarely comes. A peer that recovers is heard by the next consult. This narrows nothing on the commit path, which passes no map.

**The restored revision is the one the consult corroborated.** Re-fetching could return a newer revision than the consult saw, which then had to win its own quorum or the pass declined. Reusing the consult's archives restores exactly what was corroborated.

**Compatible with a later revision-only consult.** Plan ticket `feat-a-cohort-consult-batches-blocks-per-peer` (arm 2) proposes a consult that returns bytes only when the peer is ahead of the asker. That is exactly when an acquisition runs, so the reuse keeps working; a consult answer without bytes falls back to the fetch, correct at two requests. A note to this effect is appended to that ticket.

## Edge cases & interactions

- **Stand-in asker** (`askerStandIn`: the cohort member that sent the read stated what it holds, so it was not consulted). It is absent from the map and is asked by the acquisition — the first request to it for this block. Verified by inspection.
- **Held block behind the cohort** (`readRepairMode: 'paranoid'`, a floor above the local copy, or a background held-block consult): same pass, same reuse; the archive is the peer's latest, which is what the old fetch served. Covered by the existing specs in `coordinator-repo-read-repair-content.spec.ts` ("selects the peer's newer revision…", "converges the block content…") staying green with the production-shaped callback.
- **Promotion succeeds first** (`promoteCorroborated` advances locally): the map is simply unused. By inspection.
- **Certified claim, uncertified or mismatching bytes**: the content certification and `reconcile:content-rejected` penalty run on the reused bytes exactly as on fetched ones. Covered by the reconcile specs over `createReconcileBlock` (`packages/db-p2p/test/reconcile-block.spec.ts`, `packages/db-p2p/test/mesh-reconcile-quorum.spec.ts`), which call it without a map and must stay green; no new test.
- **Archive whose top revision is below the corroborated one** (a peer that answered with an older revision than the quorum chose): `toCandidate` returns `behind`, as for a fetched archive. By inspection.
- **Memory**: archives now live until `restoreCorroborated` returns instead of being dropped after projection — one archive per cohort peer per block pass in flight, bounded by cohort size and by the held-block consult concurrency cap. By inspection.
- **Absence verdicts and the doubt memo** read only claims, `silent` and `answered`; the map is additive and changes none of them. By inspection.
- **Commit-path reconcile** passes no map: behaviour unchanged. The existing commit-path reconcile specs stay green.
- **Mixed versions**: nothing on the wire changes.

## Test

One test, in `packages/db-p2p/test/coordinator-repo-read-repair-content.spec.ts` (two real `StorageRepo`s, B acquiring from A through the real `createReconcileBlock`). Make the spec's `clusterLatestCallback` production-shaped — for peer A return `{ ...latestFromArchive(archive), archive }` from one `serveArchive(aRepo, blockId)` — count A's consult calls beside the existing `archiveFetches` counter, and add:

- `it('a block it has never seen costs one request to the peer that holds it')`: `buildDivergedPair({ seedB: false })`, `bCoordinator.get({ blockIds: [BLOCK_ID] })` serves `v2`, B's storage holds rev 2, and consults-to-A + archive-fetches-to-A === **1** (today 2 — the issue's "each exactly twice").

The existing "never fetches an archive for a block no peer claims" stays as the boundary.

## TODO

- Add `ClusterLatestAnswer` and `ConsultedArchives` to `coordinator-repo.ts`; widen `ClusterLatestCallback`'s result.
- Build the map in `queryClusterForLatest` per the table above; return it on `ClusterLatestQuery`.
- Thread it through `fetchBlockFromCluster` → `restoreCorroborated` → `acquireBlockFromCohort`.
- Add the optional `consulted` argument to `ReconcileBlockCallback`; use it in `createReconcileBlock` / `fetchAnswer`.
- `libp2p-node-base.ts`: return the archive from the remote branch of `clusterLatestCallback`; strip it in the trust anchor's `latestClaimFrom` adapter; remove the NOTE above `fetchArchiveFromPeer`.
- Mesh harness: attach the archive in its `clusterLatestCallback`.
- Update the NOTE in `fetchBlockFromCluster`, `docs/transactions.md` § Read Consistency and Staleness (step 2 and the `cohortQueryTimeoutMs` row), and the read-path sentence in `docs/internals.md` *A behind member actively reconciles* if it implies the read path re-fetches.
- Add the test above; run `yarn test` in `packages/db-p2p` and `yarn lint:docs` from the root.
