----
description: A node repairing or replicating a block currently trusts whatever "latest version" a single peer claims, with no proof — so one lying peer can push bogus or wrong content onto it. Make both repair paths require agreement from a quorum of peers (and matching content) before accepting.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts (queryClusterForLatest 296-326, fetchBlockFromCluster 265-293), packages/db-p2p/src/libp2p-node-base.ts (reconcileBlock 639-662, clusterLatestCallback 699-729, fetchArchiveFromPeer 614-633), packages/db-p2p/src/reputation/types.ts (PenaltyReason), packages/db-p2p/test/coordinator-repo-read-repair-trust.repro.spec.ts (repro — invert when fixed), packages/db-p2p/test/coordinator-repo-read-repair.spec.ts (existing read-repair specs)
difficulty: hard
----

# Read-repair and reconcile must verify peer claims by quorum + content agreement

## Summary

Two block-restoration paths act on a single peer's self-reported "latest
revision" with zero authentication. A reproduction (`coordinator-repo-read-repair-trust.repro.spec.ts`,
passing today) shows a lone lying peer over-reporting its revision steers
restoration even when the honest majority disagrees.

- **Read-repair** — `queryClusterForLatest` (`coordinator-repo.ts:296-326`) takes
  the **maximum** `ActionRev` any single peer reports and `fetchBlockFromCluster`
  (`:265-293`) restores against it. No signature, no quorum, no content check.
- **Reconcile** — `reconcileBlock` (`libp2p-node-base.ts:639-662`) picks
  `Math.max(revs)` across fetched cohort archives and calls `saveReplicatedBlock`
  with the block from the single highest-rev archive — no cross-peer content
  check.

## Two research findings that shape the fix

**1. `actionId` is a random nonce, not a content hash.** `Collection.syncInternal`
mints it as `randomBytes(16)` base64url (`packages/db-core/src/collection/collection.ts:260-261`).
So the ticket's suggested "content-hash validation of the fetched block against
the committed `actionId`" is **not directly possible** — you cannot recompute
`actionId` from block bytes. What `actionId` *is* good for: it is an
unforgeable-by-guessing label. An honest cohort member that committed rev N knows
the real `actionId` for rev N; a liar inventing a higher rev must fabricate one,
and no honest peer will corroborate that (rev, actionId) pair. That makes
**cross-peer agreement on the (rev, actionId) pair** the workable authenticity
signal today.

**2. Commit certificates are not fetchable at restore time.** `CommitCert`
machinery exists (`cluster/commit-cert.ts`, `buildCommitCert`, the
`onCommitCertificate` sink) but a cert is held only in an in-memory TTL cache
keyed by `actionId`, used solely for reactivity origination. `BlockArchive`
revisions carry `{ action: ActionTransform, block? }` (`storage/struct.ts:17-27`)
— **no cert** — and the sync protocol never returns one. Fully verifying a
reported latest against its commit cert would additionally require: (a)
persisting the cert alongside the revision, (b) extending the sync protocol to
serve it, and (c) resisting a Sybil cohort — the per-vote binding check in
`cluster-repo.ts` `verifySignature` proves a vote was signed by the key the
peer-id names but NOT that the peer is a legitimate cohort member (its own doc
comment: "A coordinator minting fresh keypairs ... passes this for every one").
Cohort-membership anchoring exists in part (see the completed
`cohort-topic-trust-anchor-*` tickets) but is not wired into these restore paths.

Conclusion: **ship a self-contained quorum + content-agreement gate now.** Design
it so a commit-cert check can later slot in as a stronger/earlier accept
condition. The cert-based upgrade is filed separately as backlog
(`debt-read-repair-commit-cert-verification`).

## The fix

### Read-repair — `queryClusterForLatest`

Replace "max rev wins" with "highest rev corroborated by a quorum wins".

- Collect every peer's reported `ActionRev` (keep the existing per-peer timeout).
- Group responses by the exact `(rev, actionId)` pair (a liar's fabricated pair
  will not match the honest group).
- Accept the **highest rev whose (rev, actionId) group has ≥ `quorum` distinct
  peer votes**, where `quorum` derives from the consensus policy already on the
  repo (`policy.simpleMajorityThreshold` × responder count, floored, min 2). The
  local node's own latest counts as one corroborating vote where applicable.
- If no rev meets quorum, **do not restore** (return `undefined` / keep local) —
  an uncorroborated claim must not drive restoration.

**Do not fail-close on honest divergence.** Guard the small-cluster / low-response
cases so a legitimate lagging peer still restores honest blocks:
- Solo/2-node clusters (already short-circuited for solo-self) and clusters where
  only one honest peer can respond must still work — when the responder count is
  below what a quorum needs, fall back to the existing single-value behavior
  **only if all responders agree** on one (rev, actionId); otherwise decline.
- A block that is genuinely present on just one honest peer (others lagging) is an
  expected state — declining restoration there is safe (local keeps its data);
  never treat "couldn't corroborate" as data loss.

### Reconcile — `reconcileBlock`

- Fetch archives from the cohort as today, but pick the target rev by the **same
  quorum-corroboration** rule over the archives' `(maxRev, actionId)` pairs
  (`archive.revisions[maxRev].action.actionId`) rather than raw `Math.max`.
- Before `saveReplicatedBlock`, require the chosen revision's **block content to
  be byte-identical across the corroborating archives**: hash each candidate
  block canonically (reuse the `sha256` + canonical-JSON pattern already in
  `cluster/cluster-repo.ts:12,564`) and only persist a block whose hash matches
  the quorum. A cohort member serving content that does not match the agreed
  `actionId`'s content is rejected.
- If no rev+content quorum is reached, skip `saveReplicatedBlock` (leave the block
  as-is; churn/rebalance will retry later).

### Optional but cheap: penalize provable liars

When a peer reports a (rev, actionId) that is contradicted by the quorum (or
serves content whose hash disagrees with the quorum), call
`reputation.reportPeer(peerId, PenaltyReason.ProtocolViolation, ...)`. The
reputation service is already threaded into both `CoordinatorRepo` and the node
base. Consider adding a dedicated `PenaltyReason` (e.g. `InvalidRestoration`) to
`reputation/types.ts` rather than overloading `ProtocolViolation`. Keep this
best-effort — never let a reputation write block or throw in the restore path.

## Interactions to cover (from the original ticket)

- A minority of lying peers reporting an inflated `ActionRev` → outvoted, no
  restore against the lie.
- A cohort member serving content whose block hash disagrees with the cohort →
  rejected in `reconcileBlock`.
- Legitimate late/lagging peers must still restore honest blocks — do NOT
  fail-close on honest divergence (small clusters, single responder).

## Notes for the reviewer / tripwires

- `NOTE:` at the new quorum sites: the quorum here is corroboration-of-a-claim,
  NOT Sybil-resistant cohort membership — a peer minting fresh keypairs is out of
  scope until commit-cert + membership anchoring lands (see backlog
  `debt-read-repair-commit-cert-verification`). Parked as a code comment at the
  site, indexed here.
- The repro spec pins the *vulnerable* behavior. When the fix lands, invert it to
  assert the liar is rejected and the honest rev-1 (or "no restore") wins; add a
  positive spec proving an honest lagging peer still restores a quorum-backed rev.

## TODO

- Read `queryClusterForLatest` / `fetchBlockFromCluster` and confirm the policy
  (`this.readRepairMode`, cluster/responder counts) reachable for a quorum calc.
- Implement quorum-by-(rev,actionId) selection in `queryClusterForLatest`;
  return `undefined` when no rev meets quorum; keep the small-cluster fallback
  (all-responders-agree) so honest lagging peers still restore.
- Implement the same quorum selection + cross-archive content-hash agreement in
  `reconcileBlock` before `saveReplicatedBlock`; skip persist when unmet.
- Add a canonical block-hash helper (reuse `sha256` + canonical-JSON from
  `cluster-repo.ts`) or extract the existing one for reuse.
- (Optional) add `PenaltyReason.InvalidRestoration` and report contradicted peers
  best-effort in both paths.
- Add a `NOTE:` code comment at each quorum site re: the Sybil-membership gap.
- Update `coordinator-repo-read-repair-trust.repro.spec.ts` to assert the liar is
  rejected; add a positive spec (quorum-backed honest restore still works) and a
  reconcile content-mismatch-rejected spec.
- Verify existing `coordinator-repo-read-repair.spec.ts` still passes (the
  paranoid/lazy/off mode + window/sample-rate behavior must be unchanged for the
  honest-agreement cases).
- Run: `cd packages/db-p2p && yarn test 2>&1 | tee /tmp/db-p2p-test.log`.
