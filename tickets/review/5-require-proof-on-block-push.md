description: A machine now refuses a record another machine hands it unless the sender also shows signed evidence that the record is genuine, closing a hole where any peer could plant made-up content that the receiver would then vouch for.
files: packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/block-transfer-push-persist.spec.ts, docs/internals.md
difficulty: medium
----

# Review: require a commit proof on a pushed block

## What the hole was

`BlockTransferService.handlePush` accepted a pushed block from **any** peer. It checked only that
the base64 payload parsed as JSON and had a `header`, then persisted it with the **pusher's own**
declared revision metadata. `saveReplicatedBlock` advances `latest` monotonically, so forged content
became the receiver's authoritative revision — after which the receiver *corroborates* the pusher in
a later read-repair vote. That is how a peer manufactures its own corroborators.

## What landed

**Wire.** `BlockTransferRequest` gains `blockProofs?: Record<string, BlockCommitProof>` beside the
existing `blockMeta`. Optional, so an un-upgraded sender still parses.

**Producer.** New `sourceBlockCertification(repo, blockId, result)` in `block-transfer-service.ts`,
beside `sourceBlockMeta`. It builds metadata and proof together from one unpinned read and returns
them as a single `PushCertification`. The proof comes from `servableProof()` — the same accessor
that decides what a peer attaches to a served repair archive — which fails closed on a repo with no
proof accessor, a throwing lookup, or a stored proof whose message names a different
`(blockId, rev, actionId)`.

`BlockTransferClient.pushBlocks`'s 4th parameter changed from `blockMeta` to that single
`certification` object, so a caller cannot pair a proof for one revision with metadata for another.
All three push call sites updated: `BlockTransferCoordinator.executePush`, `.executeConfirm`, and
`SpreadOnChurnMonitor`.

**Receiver.** `handlePush`, per block, before persisting: require a proof, require metadata beside
it, and run one `certifyContent()` call — which covers the signer cap, the vote signatures and
thresholds, the claim matching the declared `(rev, actionId)`, and the declared digest matching the
pushed bytes. A failure reports the block in `missing` (the existing failure surface senders already
handle) and logs `push:reject-uncertified` with the `ProofFailure` reason. An accepted block's proof
is persisted via `saveReplicatedBlock`'s 4th argument, so the receiver can re-prove onward what it
verified.

**Flag.** `BlockTransferServiceInit.requirePushCertificate`, default `true`, with the rationale and
migration note as a code comment. With it `false` an uncertified push falls back to the pre-proof
path and logs `push:accept-uncertified`. A push carrying a proof that *fails* verification is
rejected regardless of the flag.

**Wiring.** `BlockTransferServiceComponents.superMajorityThreshold` (required, not defaulted), fed
in `libp2p-node-base.ts` from the same resolved `consensusConfig` the member and coordinator read.

**Docs.** `docs/internals.md` gains a **Certified push** subsection; the two stale statements that
said the push path passes no proof were corrected.

## Deliberate deviations from the implement ticket — check these first

Three, all argued in code comments. If a reviewer disagrees with any, that is a finding.

1. **Metadata is still attached when no proof exists.** The ticket said "a block whose local proof
   is missing gets neither". Dropping the metadata too would regress the migration path — a
   `requirePushCertificate: false` receiver needs it to land the replica at the source revision
   instead of a fabricated rev 1 — while making the strict path no stricter, since a proof-less push
   is rejected either way. The invariant that actually matters (never a proof without its metadata,
   never a proof unpaired from its revision) is preserved by construction. Rationale is in
   `sourceBlockCertification`'s doc comment.
2. **`certifyContent` instead of `verifyBlockCommitProofContent`.** The ticket named the raw
   verifier. `certifyContent` wraps it and applies `MAX_PROOF_SIGNERS` before any signature work —
   which `commit-proof.ts` documents as a **caller obligation** precisely because verification cost
   is attacker-chosen, and this input arrives from an unauthenticated peer. Skipping the cap here
   would be the one place in the codebase that ignores that obligation on wire input.
3. **Only `superMajorityThreshold` is threaded, not `simpleMajorityThreshold`.** The service builds
   its thresholds with `proofThresholds(superMajorityThreshold)`, the shared helper both other
   proof-verifying paths use. That helper hardcodes the simple-majority term to **0.5** on purpose:
   members enforce `count > total / 2`, not the configured 0.51, so verifying against the configured
   value would reject proofs real cohorts produce. Threading the second value would have been dead
   weight at best and a wrong verification at worst. `reconcile-block.ts` takes both only because it
   needs the configured value for its corroboration quorum; this service has no such quorum.

## Known gaps — do not re-file these

- **Proof back-fill on the monotonic no-op is NOT implemented.** The implement ticket asked to
  decide and pin it. A certified push for a revision the receiver already holds proof-lessly is
  accepted, but `saveForwardRevision`'s early return drops the verified proof, so the node stays a
  corroboration-only holder for that revision. Filed with its design (including the divergence trap
  that makes the naive fix harmful) as `implement/backfill-proof-on-held-revision`. Deliberately NOT
  a `prereq:` of this review — reviewing what landed does not wait on it.
- **Two specs downgraded to `requirePushCertificate: false`** to keep passing:
  `cohort-growth-heals-single-holder.spec.ts` (its `writeRevision` commits with no digests or proof)
  and `block-transfer-roundtrip.spec.ts` (pins the stream path, not certification). Neither now
  exercises the production default. Arm 2 of the same continuation ticket.
- **`sourceBlockCertification` has no direct unit coverage.** Arm 3 of the same ticket. It is
  exercised only indirectly, through the producers.

## Testing / validation

`packages/db-p2p/test/block-transfer-push-persist.spec.ts` rewritten. Proofs are **real** —
fully-signed Ed25519 four-peer cohort records from `support/commit-proof-fixtures.ts`, the same
recipe coordinators and members use — so an acceptance there is one production would also make.

Strict default:
- uncertified push rejected, nothing persisted (the flipped pin — this exact request used to be
  accepted);
- uncertified push with no metadata at all rejected;
- certified push accepted, replica persisted at the source revision, **and the proof retained**;
- valid proof for rev 5 with metadata claiming rev 9 → rejected;
- valid proof with tampered bytes → rejected;
- proof with no metadata → rejected;
- multi-block push: the verifying block accepted, the uncertified one refused **alone**;
- certified re-push idempotent; older certified revision does not downgrade `latest`;
- persist failure still reports `missing`; unparseable payload and `null` payload still rejected
  without poisoning storage.

Migration flag:
- uncertified push accepted and persisted at the source revision, retaining no proof;
- uncertified push with no metadata falls back to a deterministic rev-1 replica;
- a **failing** proof still rejected with the flag off;
- a proof with no metadata still rejected with the flag off;
- a certified push behaves exactly as under the strict default.

**Where the floor is low.** Everything above drives `handlePush` directly. Nothing tests the new
producer→wire→receiver chain end to end: no test builds a real proof, pushes it through
`BlockTransferClient` over the stream path, and asserts the receiver accepted it. The roundtrip spec
could have been that test and instead runs the migration flag. That is the largest coverage gap in
this change, and a reviewer should weigh whether it belongs here rather than in the continuation
ticket.

Also untested: that the node factory actually passes `superMajorityThreshold` through (compile-time
only — the field is required, so omission is a type error, but a *wrong* value is not), and the
`push:reject-uncertified` / `push:accept-uncertified` log lines the migration story depends on for
diagnosability.

## Results

`yarn build && yarn typecheck && yarn test` from the root: clean. `packages/db-p2p` suite: **2196
passing, 0 failing**. Six other specs construct `BlockTransferService` and were updated for the now-
required `superMajorityThreshold`; two of those also took `requirePushCertificate: false` as noted
above.

No pre-existing failures were observed.
