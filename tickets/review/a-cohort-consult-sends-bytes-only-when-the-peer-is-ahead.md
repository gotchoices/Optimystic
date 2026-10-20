description: When a machine checks with the other members of its group whether its copy of a block is current, it now tells them which version it holds, and a member sends the block's contents back only when it has something newer; otherwise it answers with the version and its proof alone.
prereq:
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-p2p/src/sync/protocol.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/storage/block-archive.ts (`serveConsultAnswer`, `claimFromConsultAnswer`, `readServable`, `askerHoldsServed`), packages/db-p2p/src/libp2p-node-base.ts (`clusterLatestCallback`, the `CommitLogTrustAnchor` `latestClaimFrom` adapter), packages/db-p2p/src/repo/coordinator-repo.ts (`ClusterLatestCallback`, `readRepairBlock`, `startHeldBlockConsult`, `runHeldBlockConsult`, `fetchBlockFromCluster`, `queryClusterForLatest`), packages/db-p2p/src/testing/mesh-harness.ts (`clusterLatestCallback`), packages/db-p2p/src/cluster/cluster-repo.ts (`ConsultedArchives` doc), packages/db-p2p/test/block-archive-proof.spec.ts, docs/transactions.md, docs/internals.md
----

# A cohort consult sends bytes only when the peer is ahead

GitHub [#43](https://github.com/gotchoices/Optimystic/issues/43), arm 2. Sibling tickets: `a-cohort-consult-asks-each-peer-about-all-its-blocks-at-once` (builds on this wire shape) and `a-member-that-applied-a-commit-counts-its-copy-checked` (independent).

## What changed

**Wire** (`sync/protocol.ts`). `SyncRequest.held?: Record<BlockId, ActionRev>` — what the asker holds of each asked block; a block missing from the map is held as nothing. `SyncResponse.answers?: Record<BlockId, SyncBlockAnswer>`, present whenever the request carried `held`. `SyncBlockAnswer = { archive?, contentOmitted?: SyncContentOmitted }`, with `SyncContentOmitted = 'held'` (a union of one on purpose; the batching sibling adds `'size'`). No protocol version bump.

**Serving rule** (`storage/block-archive.ts`). `serveConsultAnswer(repo, blockId, held)`:
- repo holds nothing → `{}`;
- asker holds nothing, served revision above `held.rev`, or equal revision under a different action id → full archive;
- served below `held.rev`, or equal revision and action → archive with proof but no `block` and no `action.transform.insert`, `contentOmitted: 'held'`.

`serveBlockArchive` and `serveConsultAnswer` share one read (`readServable`: unpinned/pinned `repo.get` with `skipClusterFetch`, the `materialized ?? latest` label, `servableProof`). The pinned-read refusal stays in `serveBlockArchive` only. `askerHoldsServed` is written positively so a `held` with a missing/`null`/`NaN` revision gets the bytes.

**Projection** (`claimFromConsultAnswer`, same file). Answer → claim plus archive. An omitted-as-`'held'` archive is still attached, so the acquisition reuses it (`ConsultedArchives`) and does not re-ask that peer — safe because such a peer is at or below the asker's revision, and the acquisition only takes a corroborated revision strictly above it (`createReconcileBlock` reads it as `behind`). Any other omission reason (one a newer peer could send) returns the claim WITHOUT the archive, so the acquisition asks that peer for bytes. The reasoning is the doc comment there; the callback points to it.

**Server** (`SyncService`). A request with `held` gets `{ success: true, answers: { [blockId]: … }, responderId }`; a serve fault for the block is logged and answered `{}` (same as `buildArchive`'s existing fault → "holds nothing"). A request without `held` takes the old path unchanged.

**Asking side.** `ClusterLatestCallback` gains a 4th parameter `held?: ActionRev`. `readRepairBlock` takes it from `localEntry.state.latest` and threads it through `startHeldBlockConsult` / `runHeldBlockConsult` / `fetchBlockFromCluster` / `queryClusterForLatest`; in all four, the old `localRev` parameter is replaced by `held` and `localRev = held?.rev` is derived inside, so the two cannot disagree. The production callback always sends `held: held ? { [blockId]: held } : {}`; on a response with `answers` it projects through `claimFromConsultAnswer`, and an `answers` map that lacks the asked block **rejects** (counted as silence, never as "holds nothing"). A response without `answers` (older server) takes the old code path exactly. The self short-circuit is unchanged.

**Mesh harness.** Its callback still does the sibling read under the asker's context first (kept: it is how the harness has always let a sibling promote a pending the context proves committed), then answers through `serveConsultAnswer` + `claimFromConsultAnswer`, so mesh specs see the omitted shape.

**NOTEs (tripwires) added.** At the `CommitLogTrustAnchor` `latestClaimFrom` adapter: it passes no `held`, so it still gets bytes it discards; fine at once per distant root certificate, revisit if anchor lookups show in request accounting. At `singleRevisionArchive`: the block rides twice when sent; the restore wire needs the transform copy; revisit if acquisition/restore traffic dominates.

**Docs.** `docs/transactions.md` § Lazy read-repair window gains the paragraph *A consult says what this node holds, so a peer that is not ahead sends no bytes*; step 2 of the repair (the `ConsultedArchives` sentence) now says an omitted-bytes answer is reused as a claim only. `docs/internals.md` (*A behind member actively reconciles*) says the same. `ConsultedArchives` and `servableProof` doc comments updated (the harness no longer calls `servableProof` directly; its remaining direct caller is the node's self short-circuit).

## Tests

- Added — `test/block-archive-proof.spec.ts` › `serveConsultAnswer` › "sends the block's bytes only when the asker holds nothing, or something older or forked": table over asker-holds-nothing / served-above-held / same-rev-different-action → bytes; same rev+action / served-below-held → no block, no transform insert, `contentOmitted: 'held'`; proof present in every shape; repo holds nothing → `{}`.
- Nothing else new: the existing read-repair, acquisition and mesh specs cover the asking side now that the harness serves by the same rule.

Run and green:
- `yarn workspace @optimystic/db-p2p test` — 3491 passing, 73 pending.
- `yarn test:integration` from root — db-p2p integration 50 passing / 2 pending; quereus-plugin-optimystic (whole suite with `OPTIMYSTIC_INTEGRATION=1`) 1060 passing / 8 pending. These send real `sync` requests, so the `answers` path ran over TCP.
- `tsc --noEmit` (db-p2p), `eslint` on every changed file, `yarn lint:docs` — clean.
- Note for the reviewer: running db-p2p with `--grep "read-repair"` makes `member-leaves-and-returns.spec.ts` phase 4 fail with `Cannot read properties of undefined (reading 'blockIds')` — the grep selects phase 4 without the earlier phases that set its state. The file passes whole (10 passing). Not related to this change.

## Known gaps — please probe

- **Mixed versions are verified by inspection only.** No fixture runs two builds in one cohort (`debt-no-scenario-runs-two-builds-in-one-cohort`). Older server → no `answers` → old path; older asker → no `held` → `serveBlockArchive` unchanged.
- **`claimFromConsultAnswer`'s "other omission reason → no archive" branch has no test.** The ticket asked for no new tests beyond the serving table; it is three lines and only reachable from a newer peer today.
- **`held` is `state.latest`, not `materialized`.** For a read pinned below the block's latest, `held` is still the node's newest revision. That is the right comparison (the consult asks for the peer's latest, and the acquisition baseline is the node's latest), but worth a second look.
- **Safety argument depends on the baseline.** Omitted ⇒ peer rev ≤ `held.rev` ≤ `baselineRev` (`local?.rev ?? held.rev`; the self answer is read after `held` and storage `latest` only moves forward), and acquisition runs only for `corroborated.rev > baselineRev`. If anything ever lets the self answer report a lower revision than `held`, an omitted archive could be reused for a revision that needs bytes.
- **Proof lookup now runs before the pinned-read refusal** in `serveBlockArchive` (the shared read includes it). That refusal is unreachable for a `StorageRepo` (it always reports `materialized`), so it costs one extra proof read on a path production does not take.
- **Bytes saved were not measured.** The motivation figure (103–134 `sync` requests/minute between two idle machines) is Sereus's; no test counts response bytes.
- `fetchArchiveFromPeer` (acquisition and commit-path reconcile) still sends the old request with no `held`, so it always gets bytes — intended, since it is fetching content.
