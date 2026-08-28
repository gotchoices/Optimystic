----
description: Stop a machine from accepting a record another machine simply hands it without evidence — today any peer can push made-up content and have it stored and later served as genuine.
prereq: accept-certified-claims-in-repair
files: packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/block-transfer-push-persist.spec.ts
difficulty: medium
----

# Require a commit proof on a pushed block

## The measured hole

`BlockTransferService.handlePush` (`packages/db-p2p/src/cluster/block-transfer-service.ts:231`)
accepts a pushed block from **any** peer. It checks only that the base64 payload parses as JSON and
has a `header`, then persists it via `saveReplicatedBlock` using the **pusher's own** `blockMeta`
rev/actionId. `saveReplicatedBlock` (`storage-repo.ts:822`) advances `latest` monotonically, so the
forged content becomes this node's authoritative revision and it will then *corroborate* the pusher
in a later read-repair vote — which is precisely how a peer manufactures its own corroborators.

Acceptance is currently pinned green by `test/block-transfer-push-persist.spec.ts:48,65`.

## The change

`BlockTransferRequest` gains an optional per-block proof map, alongside the existing `blockMeta`:

```ts
/** For push: the cohort's commit proof for each block's revision. Verified against the pushed
 *  bytes AND against the declared blockMeta before anything is persisted. */
blockProofs?: Record<string, BlockCommitProof>;
```

`handlePush`, per block, after the existing parse and structural checks:

- Look up `blockProofs?.[blockId]` and `blockMeta?.[blockId]`.
- Require both, and require `verifyBlockCommitProofContent(proof, { blockId, rev: meta.rev,
  actionId: meta.actionId }, block, thresholds)` to succeed. That single call covers everything:
  the signatures and thresholds, the claim matching the declared `(rev, actionId)`, and the declared
  digest matching the pushed bytes.
- On failure, report the block as `missing` — the existing failure surface, which the sender already
  handles by falling back or retrying — and log `push:reject-uncertified` with the `ProofFailure`
  reason.

Every push producer must attach proofs: `BlockTransferClient.pushBlocks` (`:333-341`) and its callers
(rebalance confirm/push, spread-on-churn). Build the map beside `sourceBlockMeta` (`:56`) so the two
stay paired — a block whose local proof is missing gets neither, and is simply not pushed as
certified. Follow that function's existing warning: the source must be read **unpinned**, so `block`,
`blockMeta` and the proof all describe the same revision.

`handlePush` needs the cohort thresholds; thread `consensusConfig`'s `superMajorityThreshold` and
`simpleMajorityThreshold` into `BlockTransferServiceComponents` from `libp2p-node-base.ts`, from the
**same `consensusConfig` reference** every other consumer reads — that file already asserts
coupling between the member and the coordinator on exactly this value, and a third divergent copy
would defeat it.

## Migration flag — decided, do not re-litigate

Pre-proof blocks can never be certified: the signatures no longer exist. So:

```ts
/** Reject a pushed block that carries no verifying commit proof. Default true.
 *  A deployment holding pre-proof data sets this false during migration. */
requirePushCertificate?: boolean;   // default true
```

Rationale for the strict default: the forgery is measured and currently unmitigated. The failure mode
of `true` is "legacy blocks stop gaining new holders via push" — visible in a
`push:reject-uncertified` log line, and those blocks stay readable while two or more holders remain.
The failure mode of `false` is silent acceptance of forged content. Mitigation worth stating in the
code comment: any block written again under the new code gets a proof, so only cold, never-updated
blocks stay uncertified.

With the flag `false`, an uncertified push falls back to today's behaviour but must still log that it
was accepted uncertified. A push that carries a proof which **fails** verification is rejected
regardless of the flag — that is not a legacy block, it is a bad one.

## Edge cases & interactions

- **Flip the pinned test.** `test/block-transfer-push-persist.spec.ts` currently asserts that an
  unadorned push is accepted and persisted. Under the default it must now assert **rejection**
  (reported `missing`, nothing persisted), with the acceptance cases rebuilt to carry a valid proof.
  Keep a case with `requirePushCertificate: false` pinning the legacy path.
- **Proof/meta disagreement.** A valid proof for rev 5 pushed with `blockMeta` claiming rev 9 must be
  rejected — the claim match inside content verification is what catches it. Pin it.
- **Proof/bytes disagreement.** A valid proof paired with tampered bytes must be rejected.
- **Proof present, `blockMeta` absent.** Reject: without the declared `(rev, actionId)` there is no
  claim to verify the proof against, and `saveReplica` would fabricate a rev-1 replica.
- **`saveReplicatedBlock` monotonic no-op.** A certified push for a revision the receiver already
  holds must not regress or duplicate stored state (`storage-repo.ts:822-850`). Decide and pin
  whether it back-fills a missing local proof for that revision — preferred, it is strictly additive
  and turns a corroboration-only holder into a certified one.
- **Persist the proof.** A block accepted on a proof should store that proof, or the receiver becomes
  a holder that cannot re-prove what it just verified. Route it through the same
  `saveBlockProof(rev, proof)` the commit path uses.
- **Mixed-version push.** An upgraded sender pushing to an un-upgraded receiver: the extra field is
  ignored and the push behaves as today. An un-upgraded sender pushing to an upgraded receiver: the
  push is rejected under the strict default — this is exactly the documented migration case, and the
  log line must make it diagnosable.
- **Multi-block push** where one block verifies and another does not: the verifying one is accepted,
  the other reported `missing`. Per-block, never all-or-nothing.
- **Pull is unchanged.** `handlePull` serves from local storage; this ticket touches only the push
  direction.

## TODO

- Add `blockProofs?` to `BlockTransferRequest`; add a builder beside `sourceBlockMeta` that pairs a
  block's proof with its meta from one unpinned read.
- Attach proofs in `BlockTransferClient.pushBlocks` and every push caller (rebalance, spread-on-churn).
- Thread `superMajorityThreshold` / `simpleMajorityThreshold` into `BlockTransferServiceComponents`
  from the single shared `consensusConfig` in `libp2p-node-base.ts`.
- Add `requirePushCertificate` (default `true`) to `BlockTransferServiceInit`, with the rationale and
  migration note as a code comment.
- Verify in `handlePush` before persisting; report failures as `missing`; log
  `push:reject-uncertified` with the reason.
- Persist the verified proof alongside the replica.
- Rewrite `test/block-transfer-push-persist.spec.ts`: uncertified push rejected by default; certified
  push accepted and persisted with its proof; proof/meta mismatch rejected; tampered bytes rejected;
  proof without meta rejected; `requirePushCertificate: false` accepts uncertified and logs;
  a failing proof rejected even with the flag off; multi-block partial acceptance; idempotent
  re-push.
- Document the flag and the migration path in `docs/internals.md`.
- Run `yarn build && yarn typecheck && yarn test` from the root.
