----
description: Let a machine prove a record really was updated by checking a signature the group produced when it committed, instead of having to reach two other machines that say the same thing. Without that proof, a machine that cannot reach enough peers can never catch up, and small or partly-connected deployments get stuck permanently.
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/cluster/commit-cert.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/peer-key-binding.ts, packages/db-p2p/src/storage/struct.ts, packages/db-p2p/src/storage/block-archive.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/sync/protocol.ts, packages/db-core/src/cluster/membership.ts, packages/db-core/src/cluster/structs.ts, packages/db-core/src/network/repo-protocol.ts, packages/db-core/src/network/struct.ts, packages/db-core/src/network/i-repo.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/test/block-transfer-push-persist.spec.ts
difficulty: hard
severity: wrong-result
likelihood: normal-use
repro: verified
----

# Verify restored blocks against a commit certificate

<!-- resume-note -->
**A prior plan run (2026-08-27) was cut short by a token budget warning.** It completed the
architecture research and settled every major design question except ONE (named under *The one open
question* below). No code was changed. This file replaces the original ticket and carries everything
that run established, so the next planner does **not** need to re-derive any of it. Read
*Verified facts* before opening any file; each line there was read out of the tree, not inferred.

The next run's job: answer the one open question, then emit the five prereq-chained implement
tickets sketched under *Ticket split*. Do not re-open the settled decisions.

---

## What this is for, in one paragraph

When a node needs to repair or acquire a block, it asks the block's cohort peers what they hold and
only believes an answer that at least two *distinct peers* corroborate. That rule has two measured
failures. (1) **Availability:** a block held by exactly one reachable peer can never be repaired, so
a deployment's earliest data — written while it was one node — becomes permanently unreadable as the
deployment grows. (2) **It is bypassable anyway:** a peer that can dial two cohort members can push
forged content to them and manufacture its own corroborators. Replacing "N peers agree now" with
"one peer carries a signature the cohort produced at commit time" fixes both: the signature set *is*
the corroboration, so origin stops mattering and a lone honest holder is sufficient.

---

## Verified facts (read out of the tree 2026-08-27 — do not re-derive)

**Cluster consensus shape**

- A transaction is TWO independent cluster records: a `pend` record and a `commit` record
  (`ClusterMember.applyConsensusOperation`, `cluster-repo.ts:1349`). Each runs a promise round then a
  commit round, and each ends with a `commits: Record<peerId, Signature>` map of per-member Ed25519
  approve votes.
- The commit record's message is `{ operations: [{ commit: CommitRequest }], expiration }`, built in
  `CoordinatorRepo.commit` (`coordinator-repo.ts:1395`). `CommitRequest` / `RepoCommitRequest` is
  `{ blockIds, actionId, rev, tailId? }` (`db-core/src/network/i-repo.ts:26`) — **no transforms and
  no content**. So today's commit signatures bind `(blockIds, actionId, rev)` and nothing about bytes.
- `computeClusterMessageHash(message, digest)` hashes `canonicalJson(message) + digest`
  (`db-core/src/cluster/membership.ts:58`); `computeClusterCommitHash` hashes
  `messageHash + canonicalJson(message) + digest + canonicalJson(promises)`. Both canonicalise the
  **whole** message generically, so **adding a field inside the commit op is automatically covered by
  every hash and every existing signature, and an older peer recomputes the changed preimage
  correctly.** This property is what makes the chosen design wire-safe.
- `clusterVoteSigningPayload(hash, type, extra)` (`db-core/src/cluster/structs.ts:35`) is
  `utf8(hash + ':' + type + [':' + extra])`; `clusterVoteVerificationPayload` reads a variant's extra
  off the vote. An `approve` carries no extra today.
- `membershipVersion: 2` folds `membershipDigest` — `base64url(SHA256(canonicalJson(sorted peer-id
  list)))`, ids only, no multiaddrs or keys (`membership.ts:33`) — into all three hashes, making the
  declared peer set tamper-evident. A v1 / unversioned record binds no peer set at all.
- `peerIdBindsPublicKey` (`cluster/peer-key-binding.ts`) proves a key is the one an Ed25519 peer id
  names, by reading `peerIdFromString(id).publicKey.raw`. **A verifier can therefore recover every
  signer's public key from its peer id alone — a stored proof never needs to carry public keys.** The
  same file states plainly that this does NOT establish cohort membership.
- `buildCommitCert` (`cluster/commit-cert.ts`) already assembles
  `{ thresholdSig, signers, minSigs, signedPayload }` from `record.commits`, but hands it to an
  in-memory store with `DEFAULT_COMMIT_CERT_TTL_MS = 60_000`. `signedPayload` is
  `utf8(commitHash + ":approve")` — an opaque hash, so a receiver holding only a `CommitCert`
  **cannot tell what claim it certifies**. A durable proof must carry enough of the record to
  recompute `commitHash` from the claim.

**Repair paths**

- `BlockArchive` (`storage/struct.ts:19`) is `{ blockId, revisions, range, pending? }` where
  `ArchiveRevisions = Record<number, { action: ActionTransform, block?: IBlock }>`. No signature field
  anywhere.
- `singleRevisionArchive` (`storage/block-archive.ts:23`) **fabricates** the action as
  `{ actionId, transform: { insert: block } }`. The repair wire therefore carries *materialized state*
  with a synthetic transform, never the real transform chain. This is what makes verify-by-replay
  expensive — see *Rejected*.
- `clusterLatestCallback` (`libp2p-node-base.ts:864`) fetches the whole archive over the sync
  protocol and **discards everything except `(actionId, maxRev)`**. Widening its return type is cheap,
  and is what lets a certificate help at the latest-query stage rather than only at acquisition.
- `CoordinatorRepo.queryClusterForLatest` → `selectQuorumRev` picks the target revision;
  `restoreCorroborated` → `acquireBlockFromCohort` (wired to the same `createReconcileBlock` the
  commit path uses, `libp2p-node-base.ts:909`) fetches archives and runs `selectQuorumBlock` on
  content. **Both stages must accept a certificate, or the lone-holder case dies at the first stage.**
- `corroboratorCapacity(cohortPeerCount, repairCorroborationClusterSize)` is deliberately the MAX of
  the two so a shrunken cohort view cannot talk the floor down (`quorum-restore.ts:88`). Do not touch
  it; the certificate path goes *around* it, it does not relax it.
- `BlockTransferService.handlePush` (`block-transfer-service.ts:230`) accepts a pushed block from any
  peer, checks only that the payload parses and has a `header`, and persists it via
  `saveReplicatedBlock` using the **pusher's own** `blockMeta` rev/actionId. `saveReplicatedBlock`
  (`storage-repo.ts:822`) advances `latest` monotonically. Acceptance is pinned green in
  `test/block-transfer-push-persist.spec.ts:48,65`.
- `MAX_CONTROL_MESSAGE_BYTES = 1 MiB` bounds sync responses (`protocol-limits.ts`), which already
  carry whole blocks — a few KB of proof is not a concern there.

**Precedent for shipping at partial strength**

- `verifyInvalidationCertificate` (`dispute/invalidation.ts`) verifies a challenger-bound signer set +
  membership + dedup (layer 1), takes an optional injected layer-2 recompute capability, and reports
  `{ reason: 'no-recompute-capability' | 'recompute-infeasible' }` through an `onUnanchored` callback
  rather than blocking on the unlanded anchor. `libp2p-node-base.ts:820` documents why layer 2 is
  deliberately not wired yet. **Mirror this shape exactly.**

---

## Settled design

### Bind block content by declaring a digest inside the commit operation

Add an optional `blockDigests?: Record<BlockId, string>` to the commit request — the canonical
SHA-256 (base64url) of the block each id will materialize to at this revision. Because
`canonicalJson(message)` covers it, `messageHash`, `promiseHash` and `commitHash` all bind it with
**zero changes to the hashing helpers**, and the cohort's existing commit approve signatures become
signatures over the content digest. No new signature type, no new consensus round.

A signature only *means* something if signers check what they sign, so: before casting its commit
approve vote, a member that can materialize the block locally recomputes the digest and **rejects on
mismatch**. A member that cannot materialize (cohort drift — the case `reconcileDivergentCommit`
exists for) approves as it does today and simply contributes no content attestation.

**Residual — state it in the implement ticket and in code:** a false digest requires the declarer to
lie AND at least a super-majority of the cohort to be simultaneously unable to check. Any single
current honest member rejects, and the transaction fails. This is strictly stronger than today, where
the commit signatures bind no content at all.

### The durable artifact: `BlockCommitProof`

`CommitCert` as it exists cannot be verified against a claim (its `signedPayload` is an opaque hash),
so persist a self-contained proof per committed `(blockId, rev)`:

```ts
export type BlockCommitProof = {
  v: 1;
  messageHash: string;
  /** The commit RepoMessage exactly as hashed — carries the commit op incl. blockDigests. */
  message: RepoMessage;
  promises: Record<string, Signature>;   // needed verbatim: commitHash's preimage includes it
  commits: Record<string, Signature>;    // approve votes only
  membershipVersion: 2;                  // v1 records bind no peer set → never certifiable
  membershipDigest: string;
  /** The record's full sorted peer-id list — the threshold denominator, bound by membershipDigest. */
  peerIds: string[];
};
```

No public keys: every signer's key is recovered from its Ed25519 peer id (`peerIdBindsPublicKey`'s
mechanism). Rough size at a cohort of 10 is a few KB — two signature maps plus the id list. Measure
it in the implement ticket rather than quoting a figure from here.

**Verification splits in two, because the two repair stages hold different information:**

- *Claim verification* (no block bytes needed — used at the latest-query stage): recompute
  `membershipDigest` from `peerIds` and compare; recompute `messageHash` and compare; recompute
  `commitHash`; verify each approve signature over `clusterVoteVerificationPayload(commitHash, sig)`
  with the key its peer id names, counting only signers present in `peerIds`, deduped; require
  `count >= ceil(simpleMajorityThreshold * peerIds.length)`; then confirm the message's commit op
  names this `blockId` at this `(actionId, rev)`. Result: the claim `(rev, actionId)` is **proven**.
- *Content verification* (needs the bytes — used at acquisition and on push): additionally require
  `blockDigests[blockId] === canonicalBlockHash(receivedBlock)`.

### Anchoring: layer 1 now, log the gap

A proof's signers are proven to be *some* set of Ed25519 identities that jointly signed; nothing yet
proves they are the block's legitimate cohort. Follow `verifyInvalidationCertificate` exactly: verify
at layer 1, take an **optional** injected capability that re-derives the block's cohort
(`keyNetwork.findCluster`, the same source `deriveExpectedCluster` uses at `libp2p-node-base.ts:790`)
and reports overlap, and when that capability is absent or reports infeasible, **accept and log the
residual** rather than declining. Historic cohort rotation means overlap can legitimately be zero for
old data, so overlap must never be a hard gate at this layer — making it one would re-create the
read-dead defect this ticket exists to fix.

Write this honestly in the ticket: the immediate, complete win is **availability** — one holder's
proof replaces N reachable corroborators, which is the reproduced defect. Sybil resistance improves
from "any two ids answering now" to "at least a super-majority of the committing cohort's keys,
checkable offline", and completes when `feat-cluster-membership-threshold-cert-anchoring` lands.

### `handlePush` requires a proof

A push must carry a `BlockCommitProof` that content-verifies against the pushed bytes and matches the
declared `blockMeta`; otherwise the block is reported `missing` (the existing failure surface — the
sender falls back or retries). This is what closes the measured forgery, and per the promotion
decision it belongs in this work, not a follow-on.

**Migration, decided:** pre-certificate blocks can never be certified — the signatures no longer
exist. So expose `requirePushCertificate`, default **`true`**, and document that a deployment holding
pre-certificate data sets it to `false` during migration. Rationale for the strict default: the
forgery is measured and currently unmitigated; the failure mode of `true` is "legacy blocks stop
gaining holders via push", which is visible in a `push:reject-uncertified` log and still readable
while two or more holders remain, whereas the failure mode of `false` is silent acceptance of forged
content. Mitigation worth stating: any block written again under the new code gets a proof, so only
cold, never-updated blocks stay uncertified. Do not re-litigate this; record it and move on.

### Fold the sibling penalty ticket

`backlog/debt-read-repair-penalty-provable-only`'s cheap arm falls out of this work: drop the
`rev > selected.rev` reputation penalty in `penalizeContradictingRevClaims` — an honest peer that is
ahead on a legacy uncertified revision would otherwise be punished — and replace it with genuinely
provable misbehavior: a peer serving a proof that fails verification, or content contradicting a
verified proof's digest. Update `test/coordinator-repo-read-repair-trust.spec.ts` accordingly, and
delete that backlog ticket when the arm lands.

---

## Rejected, with reasons (do not revisit)

- **Verify by replay** — replicate signed transforms and replay from a trusted base. The repair wire
  carries materialized state with a *synthetic* `{ insert: block }` transform
  (`block-archive.ts:23`), and the receiver in the case that matters holds **nothing**, so replay
  would have to reach genesis over a transform chain no node is guaranteed to retain — and each link
  would still need its own certificate. That is the digest design plus a chain walk, not an
  alternative to it.
- **Per-signer digest folded into the commit vote's `extra`.** Stronger — each signer would attest
  only what it computed itself — but an upgraded member's `approve` fails verification on an
  un-upgraded member, because `clusterVoteVerificationPayload`'s `default:` branch rebuilds
  `hash + ':approve'`, so the whole record is rejected. A hard mixed-version break, for a
  strengthening the residual above already bounds.
- **A separate per-member content attestation merged into the record.** Wire-safe and stronger, but
  roughly triples the surface — new record field, merge rules, a speculative-materialization API on
  the vote path, digest grouping, a second threshold — for the same practical guarantee. Revisit only
  if the residual above is ever measured to matter.
- **Collecting attestations in a new post-commit round.** Costs an extra protocol round per commit to
  buy what the existing commit round already provides for free.

---

## The one open question the next run must answer

**Who declares `blockDigests`, and can they?** The design needs a declarer that reliably knows the
block each id will materialize to.

- The **coordinator** cannot: `CoordinatorRepo.commit` forwards the caller's `CommitRequest` without
  materializing, and the code at `coordinator-repo.ts:1406-1418` explicitly handles a coordinator that
  was picked for commit after missing the pend phase.
- The **client / transactor** is the strong candidate — it authored the transforms, so it materialized
  the result locally to build them — but this was **not finished being verified**. Resume at
  `NetworkTransactor.commit` (`db-core/src/transactor/network-transactor.ts:681`) and `commitBlocks`
  (`:750`), which today pass only `{ actionId, blockIds, rev, tailId }` per batch. Establish whether
  the transactor (or its `TransactorSource` / cache layer) holds the post-transform block for every id
  in `blockIds` at commit time, including header and tail blocks and the multi-collection path. If
  some ids cannot be digested, the field stays per-id optional and those blocks fall back to
  corroboration — acceptable, but the ticket must then say which ids are expected to carry a digest so
  the implementer is not guessing.
- If the transactor turns out **not** to hold them, note that a member-side speculative
  materialization cannot serve as the declarer — the message must be fixed before it is hashed. In
  that case re-open the per-member-attestation option above rather than inventing a third mechanism.

`StorageRepo.previewCommitDigest(blockId, actionId, rev)` — reusing `readCommitBase` + `applyTransform`
+ `canonicalBlockHash` — is needed **regardless**, for the member-side verify-before-vote check. Only
the *declarer* is open.

---

## Ticket split to emit (five, prereq-chained, in this order)

Each is sized to one agent run; the chain is strictly linear because each stage consumes the previous
stage's type.

- **`commit-cert-bind-block-content-digest`** — the open question resolved; `blockDigests` on the
  commit request threaded from the declarer; `canonicalBlockHash` promoted into db-core (it lives in
  db-p2p `quorum-restore.ts:162` today and both packages will need it);
  `StorageRepo.previewCommitDigest`; member-side verify-before-vote with reject-on-mismatch.
- **`persist-block-commit-proof`** — the `BlockCommitProof` type and a pure `verifyBlockCommitProof`
  (claim half and content half); `membershipDigestFromIds` in db-core with `membershipDigest`
  delegating to it; `IRawStorage.getBlockCert` / `saveBlockCert`; write the proof alongside the
  revision on the commit path. Retention: the proof lives and dies with the revision record it belongs
  to, which is what makes it outlive the 60-second reactivity TTL.
- **`serve-block-commit-proof`** — `ArchiveRevisions` gains `proof?`; `singleRevisionArchive` and
  `serveBlockArchive` carry it; `ClusterLatestCallback` widens from `ActionRev` to a certified rev so
  the latest-query stage can use a proof.
- **`accept-certified-claims-in-repair`** — `selectQuorumRev` / `selectQuorumBlock` gain a certified
  short-circuit: a verifying proof accepts a lone claim outright, highest certified rev wins, and
  corroboration stays as the fallback for uncertified claims. Plus the optional cohort-overlap
  capability with its `onUnanchored`-shaped logging, and the folded penalty arm from
  `debt-read-repair-penalty-provable-only`.
- **`require-proof-on-block-push`** — `blockCerts` on the push wire; `handlePush` content-verifies;
  `requirePushCertificate` default `true` with the documented migration flag; flip
  `test/block-transfer-push-persist.spec.ts` from pinning acceptance to pinning rejection.

## Edge cases the implement tickets must name

- A v1 / unversioned record is never certifiable, because its peer set is unbound — it must fall back
  cleanly, never half-verify.
- Duplicate signer ids, a signer absent from `peerIds`, a non-Ed25519 signer id, a malformed
  base64url signature: reject the proof, and take care never to penalise a peer whose identity was not
  proven (the `VerifyOutcome.penalize` distinction at `cluster-repo.ts:63`).
- Replay: a genuine proof for rev 5 presented for rev 9, or presented for a different block id. The
  commit-op match is what stops both; test it explicitly.
- A cohort whose membership has fully rotated since commit: overlap zero must still accept and log.
- Multi-block commits: one proof certifies several block ids, and each id's digest is checked
  separately.
- A block whose commit materializes nothing — a tombstone; `internalCommit` allows an absent
  `newBlock` when a prior `latest` exists. Decide and pin what digest, if any, is declared.
- Mixed-version cohorts in both directions, and a proof-bearing push to an un-upgraded receiver.
- `saveReplicatedBlock`'s monotonic no-op: a proof arriving for a revision already held must not
  regress or duplicate stored state.

## Out of scope, already covered elsewhere

`replicate-owned-blocks-when-the-cohort-grows` and `name-the-single-holder-deadlock`, both landed from
the earlier single-holder investigation, stop *creating* singly-held blocks and make the deadlock
legible. Neither covers a block whose sole holder is offline or gone; this ticket is what covers that.
