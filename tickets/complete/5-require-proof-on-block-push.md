description: A machine now refuses a record another machine hands it unless the sender also shows signed evidence that the record is genuine, closing a hole where any peer could plant made-up content that the receiver would then vouch for.
files: packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/block-transfer-push-persist.spec.ts, packages/db-p2p/test/block-transfer-roundtrip.spec.ts, docs/internals.md, docs/arachnode-ring-handoff.md
----

# Complete: require a commit proof on a pushed block

## What shipped

`BlockTransferService.handlePush` used to accept a pushed block from any peer on the sender's word
alone, then persist it through `saveReplicatedBlock` — which advances `latest` monotonically, so the
forged content became the receiver's authoritative revision and the receiver then *corroborated* the
pusher in a later read-repair vote.

Now, per block and before anything is persisted, the receiver requires the cohort's
`BlockCommitProof` for the revision the push declares and runs one `certifyContent()` call over it
(signer cap, vote signatures and thresholds, claim matching the declared `(rev, actionId)`, declared
digest matching the pushed bytes). A failure reports the block in `missing` and logs
`push:reject-uncertified`. An accepted block's proof is retained, so the receiver can re-prove
onward what it verified rather than becoming a corroboration-only holder.

Wire: `BlockTransferRequest.blockProofs` beside `blockMeta`. Producer: `sourceBlockCertification()`
builds metadata and proof together from one unpinned read, via the same `servableProof()` accessor
that decides what a repair archive carries — so a proof can never be paired with metadata for a
different revision. All three push sites (`executePush`, `executeConfirm`, `SpreadOnChurnMonitor`)
send that single value. Migration escape hatch: `requirePushCertificate` (default `true`).

## Review findings

Reviewed the implement diff (`ebd5b1b0`) before the handoff summary, then the surrounding call
chain, the proof/certification layer it leans on, the docs it touches, and the specs.

### Deliberate deviations the handoff asked to be checked — all three upheld

- **Metadata still attached when no proof exists.** Correct. Dropping it would regress the migration
  path (a `requirePushCertificate: false` receiver needs the metadata to land the replica at the
  source revision) while making the strict path no stricter, because a proof-less push is rejected
  either way. The invariant that matters — never a proof without its metadata — holds by
  construction.
- **`certifyContent` rather than the raw `verifyBlockCommitProofContent`.** Correct, and the raw
  verifier would have been a defect: `MAX_PROOF_SIGNERS` is documented as a *caller obligation*
  precisely because verification cost is attacker-chosen, and this input arrives from an
  unauthenticated peer.
- **Only `superMajorityThreshold` threaded.** Correct. `proofThresholds()` hardcodes the
  simple-majority term to 0.5 because that is what `ClusterMember.hasMajority` enforces; verifying
  against the configured 0.51 would reject proofs real cohorts produce.

### Fixed in this pass

- **The migration flag was unreachable in production.** `requirePushCertificate` existed on
  `BlockTransferServiceInit`, but `createLibp2pNodeBase` built the service init inline with only
  `protocolPrefix` and the authorization hook — so no deployment could actually set it, and the
  documented migration story was fiction. Exposed as the `blockTransfer` node option and threaded
  through (`libp2p-node-base.ts`).
- **The strict default's failure mode is wider than "no new holders", and nothing said so.** A push
  a receiver refuses never *confirms*: `BlockTransferCoordinator.confirmReplicated` counts no holder
  for it, so a rebalance keeps the block `retained` instead of releasing it, and
  `RingShiftCoordinator`'s Phase B — which requires **every** block in the shed range to reach the
  floor — aborts the whole shift on a single pre-proof block. The remedy lives on the *receivers*,
  not on the node that cannot shed. Documented in `docs/internals.md` § *Certified push* and
  `docs/arachnode-ring-handoff.md` § Phase B.
- **The docs overstated what the gate buys.** The section read as though requiring a proof closes
  the manufacture-your-own-corroborators hole outright. It does not: a verified proof says the
  listed signers signed, not that they are *this block's* cohort — the standing caller obligation
  already stated under *Durable commit proof*, unclosed until proof anchoring lands
  (`feat-cluster-membership-threshold-cert-anchoring`). Push is on exactly the same footing as the
  two repair paths. Added that paragraph rather than leaving the stronger claim standing.
- **Type-level: the push producers took a plain `IRepo`.** `getBlockProof` is optional on
  `ArchiveServingRepo`, so a repo without it compiles fine and makes `sourceBlockCertification`
  return metadata-only for every block — every push then refused by every default-configured
  receiver, silently and with no type error. This is the exact failure `ProofRetainingRepo` was
  introduced for (`createServedRepoProxy`'s rationale). Tightened `BlockTransferCoordinator`'s repo
  and `SpreadOnChurnDeps.repo` to `ProofRetainingRepo`; the two affected test mocks gained an
  explicit accessor with a comment saying what they retain and why that is fine there.
- **The largest coverage gap the handoff named — closed.** Nothing tested the producer → wire →
  receiver chain: every certification test handed `handlePush` a proof object in process, which
  cannot catch a proof that a real sender builds correctly and the JSON wire then mangles. Added two
  tests to `block-transfer-roundtrip.spec.ts` driving a real source repo's retained proof through
  `sourceBlockCertification` → `BlockTransferClient.pushBlocks` → the real stream into a
  **strict-default** receiver: one asserting acceptance, persistence at the source revision, and
  proof retention; and its control, identical but with the source holding no proof, asserting
  refusal. The control is what stops the acceptance test from silently passing on a mis-set flag.

### Recorded as tripwires, not tickets (both `NOTE:` at the `certifyContent` call site)

- **Anchoring is not threadable here.** `ReconcileBlockDeps` and `CoordinatorRepo` both accept an
  optional `ProofAnchoring`; this service hardcodes none. Nothing wires anchoring in production
  today, so all three behave identically — but when it lands, push would become the one path whose
  unanchored residual is neither compared nor surfaced. Conditional on that work, so a note, not a
  ticket.
- **Per-request verification cost.** Per-proof cost is capped (≤ 256 signers), but one inbound push
  frame is capped at `MAX_BLOCK_MESSAGE_BYTES` (8 MiB — not the 1 MiB control cap the
  `MAX_PROOF_SIGNERS` note reasons about) and may carry one proof per block id, so the *number* of
  proofs is the sender's choice. Acceptable today because the pre-proof path already did per-block
  parse plus a disk write on the same frame; the note names the bound to add if inbound push CPU
  ever shows up in a profile.

### Checked and found nothing

- **Wiring.** Both push producers and the receiving service are constructed with `storageRepo`,
  which does implement `getBlockProof` — so the production path really is certified, not silently
  degraded. `superMajorityThreshold` comes from the same resolved `consensusConfig`
  `assertSuperMajorityCoupling` binds the member and coordinator to.
- **Hostile input.** `certifyContent` is total on hostile shapes by contract and by its own guarded
  cap check, so the un-try/caught call in the push loop cannot throw the request away; malformed
  metadata (`rev` as a string, an absent claim) fails the claim match and rejects closed.
- **Known gaps left open by design.** Proof back-fill on the monotonic no-op is filed with its
  design as `implement/backfill-proof-on-held-revision` (with the two spec downgrades and the
  missing `sourceBlockCertification` unit coverage as its other arms) — not re-filed here. The two
  downgraded specs (`cohort-growth-heals-single-holder`, and `block-transfer-roundtrip`'s original
  tests) still run the migration flag; the roundtrip spec now also carries strict-default coverage,
  which was the sharper half of that concern.
- **Accepted tradeoffs.** No `NOTE:`-tagged accepted tradeoff sits at any site touched here, so
  nothing was re-litigated.

## Validation

`packages/db-p2p`: `tsc --noEmit` clean, `eslint` clean on every changed file, full suite
**2198 passing, 0 failing** (up from 2196 — the two new end-to-end tests). No pre-existing failures
observed.
