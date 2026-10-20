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

## Review findings

Reviewed the diff of `ticket(implement): a-cohort-consult-sends-bytes-only-when-the-peer-is-ahead` before the handoff, then the handoff's "known gaps" one by one.

**Checked, and correct:**
- **Safety of reusing an omitted-bytes archive.** Traced end to end: a peer omits bytes only when its served revision ≤ `held.rev`; the acquisition baseline is `local?.rev ?? held.rev`, and the self answer reads storage `state.latest` after `held` was read, which only moves forward, so baseline ≥ `held.rev`; acquisition runs only for `corroborated.rev > baselineRev`; `reconcile-block.ts` `answerFrom` → `toCandidate` therefore classifies every omitted peer as `behind` (its max revision is below `committedRev`), so it never enters the revision or content quorum at the acquired revision. Same weight it had when it sent bytes.
- **`held` is `state.latest`, not `materialized`** — right: the consult is unpinned and the acquisition baseline is the node's newest revision, so a read pinned below latest does not change what the peer should compare against.
- **Unmaterializable local copy** (`latest` present, no bytes): peers at the same revision now omit bytes, but the read path never acquired at an equal revision before either (`local-current` exit), so no regression.
- **Wire robustness** on both ends: `held` as `null`, a non-object, a `__proto__` block id, a missing/`NaN`/string `rev` — every shape either gets the bytes or reads as "holds nothing", never loses a claim it should keep. A malformed `answers` entry reads as "holds nothing"; a missing one rejects (silence). A `contentOmitted` of `null` or an unknown value drops the archive so the acquisition re-asks — conservative.
- **No new trust.** A peer that is ahead and lies with `contentOmitted: 'held'` gets no more than it could before by serving an archive with no `block` (the deleted-block shape).
- **Mixed versions** by inspection: older server ignores `held` → no `answers` → old path; older asker sends no `held` → `answerArchive` unchanged.
- **Mesh harness** answers through `serveConsultAnswer` + `claimFromConsultAnswer`, so mesh specs exercise the production rule; the extra context read it keeps is test-only cost.
- **Docs**: `docs/transactions.md` (new *A consult says what this node holds* paragraph and step 2), `docs/internals.md` (*A behind member actively reconciles*), the `ConsultedArchives` and `servableProof` doc comments — all match the code. Also checked `docs/debugging.md` and `packages/db-p2p/docs/*.md`: neither describes the sync request shape, so nothing stale there.

**Tests.** The one added test (`block-archive-proof.spec.ts` › `serveConsultAnswer`) is a table over the serving rule's branches — real branching on a named contract; kept. Nothing cut. The untested "any omission reason other than `'held'` drops the archive" branch in `claimFromConsultAnswer` is unreachable until the sibling `a-cohort-consult-asks-each-peer-about-all-its-blocks-at-once` adds `'size'`, whose ticket already specifies a test for that path; no test added here.

**Runs:** `yarn workspace @optimystic/db-p2p test` — 3491 passing, 73 pending. db-p2p `test:integration` — 50 passing, 2 pending (real TCP `sync` requests, so the `answers` path ran). `tsc --noEmit` (db-p2p), `eslint` on every changed file, `yarn lint:docs` — clean. The quereus-plugin integration suite was not re-run (the implementer ran it green; nothing in it depends on code this review changed, since none was changed).

**Found, not acted on (minor, considered):**
- The proof lookup now runs before `serveBlockArchive`'s pinned-read refusal (shared `readServable`). One extra proof read on an arm a `StorageRepo` never reaches; not worth splitting the shared read.
- `SyncService` logs a consult answer as "Fulfilled" even when this node holds nothing (the consult path always returns `success: true`). Debug-level wording only; left.
- `coordinator-repo.ts` is 3950 lines (`wc -l`) and `libp2p-node-base.ts` 2535; this change added a few lines to each. Structure debt is already tracked in `debt-freshness-state-scattered-across-coordinator-repo`; nothing new filed.

**Tripwires:** the two `NOTE:`s the implementer added stand as the record — the `CommitLogTrustAnchor` adapter that still gets bytes it discards (`libp2p-node-base.ts`), and the block riding twice in `singleRevisionArchive` (`storage/block-archive.ts`). No new tripwires.

**Not measured:** bytes saved per consult. The motivation figure is Sereus's; no test counts response bytes.

**Tickets filed:** none — no finding met the filing bar.
