description: Close the spine gap (gap 1) — assemble a real k−x cohort threshold signature by collecting per-member Ed25519 signatures over a new intra-cohort sign RPC, and wire the membership-cert publisher so a real, verifiable MembershipCertV1 is produced and served. Replaces the interim single-signer sha256 ICohortThresholdCrypto.
prereq: cohort-topic-peer-key-signing
files:
  - packages/db-p2p/src/cohort-topic/threshold-crypto.ts (real assemble/verify — coord-scoped)
  - packages/db-p2p/src/cohort-topic/host.ts (sign protocol handler; per-coord threshold crypto; cert publisher tick)
  - packages/db-p2p/src/cohort-topic/protocols.ts (NEW fifth protocol: sign)
  - packages/db-p2p/src/cohort-topic/peer-sig.ts (signPeer/verifyPeerSig from prereq)
  - packages/db-p2p/src/cohort-topic/stream-util.ts (requestResponse / handleRequestResponse)
  - packages/db-core/src/cohort-topic/sig/threshold.ts (CohortSigner.verifyThreshold — distinct-member rule)
  - packages/db-core/src/cohort-topic/sig/payloads.ts (canonical signing payloads)
  - packages/db-core/src/cohort-topic/membership/publisher.ts (createMembershipCertPublisher — onStabilized/tick)
  - packages/db-core/src/cohort-topic/wire/types.ts (MembershipCertV1; SignRequest/SignReply — NEW)
----

# Cohort-topic: real k−x threshold-signature assembly + membership-cert publishing

The interim `FretCohortThresholdCrypto.assemble` returns `{ thresholdSig: sha256(payload),
signers: [self] }` — a single signer that can never satisfy `CohortSigner.verifyThreshold`'s
`≥ minSigs` distinct-member rule at `minSigs = 14`. FRET has **no** built-in cohort-signature
primitive (its `signature` fields are empty placeholders); the "two-sided cohort-signature
machinery" the docs refer to is just `assembleCohort`. So the real binding is built on top of
libp2p: a member that needs a threshold-signed artifact polls its cohort over a new intra-cohort
**sign** RPC and assembles the collected per-member signatures.

## Design

### Scheme: collected Ed25519 multi-signature

`thresholdSig` = concatenation of fixed-width (64-byte) Ed25519 signatures, one per entry of
`signers`, each signature produced by that signer's libp2p peer key over the **exact** canonical
payload (`sig/payloads.ts` ordered-array UTF-8). `verify(payload, thresholdSig, signers)` splits the
blob into `signers.length` 64-byte chunks and `verifyPeerSig`-checks each chunk against the
corresponding signer's embedded Ed25519 public key (the sync primitive from the prereq). The db-core
`CohortSigner.verifyThreshold` layer already enforces, on top of this: distinct signers, all signers
∈ `cert.members`, `signers.length ≥ minSigs`.

Rationale vs. alternatives (documented tradeoff): a collected multisig is O(k) in size (≤ ~14×64 =
896 bytes at production minSigs) — negligible for k ≤ 16 — and requires **no trusted setup, no new
crypto dependency, and no aggregation round**, unlike BLS (O(1) size but a new pairing lib + DKG) or
FROST (multi-round Schnorr). It maps exactly onto the existing `(thresholdSig, signers)` contract and
the per-member peer-key signing the codebase already uses (`cluster-repo.ts` commit signatures are
the same shape: a map of per-peer sigs). If signature size ever matters at larger k, the scheme can
be swapped behind the unchanged `ICohortThresholdCrypto` port later.

### Intra-cohort sign RPC (new fifth protocol)

Add `PROTOCOL_COHORT_SIGN = "/optimystic/cohort-topic/1.0.0/sign"` to `protocols.ts` and the
`CohortTopicProtocols` set (update `cohortTopicProtocolList`, the namespaced builder, and the
handshake test's expected set). Wire format:

```
SignRequestV1 { v:1, kind: "membership"|"promotion"|"demotion", coord: b64url, cohortEpoch: b64url, payload: b64url }
SignReplyV1   { v:1, signer: b64url(peerIdBytes), signature: b64url } | { v:1, refused: true, reason: string }
```

`payload` is the already-canonicalized signing bytes (the requester built it via the matching
`sig/payloads.ts` builder), so a signer endorses the **exact** bytes it will be checked against — no
re-canonicalization drift.

**Signer endorsement policy** (the member's decision to sign):
- It is itself a member of the cohort at `coord` under the current epoch
  (`assembleCohort(coord)` includes self; `cohortEpoch` matches its local epoch within tolerance —
  accept a one-rotation-stale epoch, reject otherwise).
- The requester is also a member of that cohort.
- `kind`-specific check:
  - `membership` — the requester's claimed member set (recovered by the signer independently as
    `assembleCohort(coord)` sorted) matches the signer's own assembly on the first `k − x` members
    (near-unanimous by construction; tolerate tail churn).
  - `promotion` — the signer's **own replicated** `directParticipants(topicId)` is ≥ a promotion
    threshold (`cap_promote_fast`), i.e. it independently agrees the topic is hot. Gossip replicates
    records (last-writer-wins on `lastPing`), so a quorum converges within a round; the requester
    retries collection across rounds until `≥ minSigs` endorse (bounded timeout).
  - `demotion` — symmetric: the signer's own count is ≤ `cap_demote` and it sees no live children.
- Otherwise reply `{ refused, reason }`.

### Coord-scoped threshold crypto

`assemble(payload, minSigs)` only receives the payload + minSigs — it has no coord. So the threshold
crypto adapter is **constructed per `CoordEngine`** (depends on the per-coord-scoping ticket): each
gets a `FretCohortThresholdCrypto` bound to `kind` is inferred by the caller (promotion/membership),
`coord = servedCoord`, a `cohortMembers: () => string[]` closure (`assembleCohort(servedCoord)`), a
`dialSign(peerIdStr, SignRequestV1): Promise<SignReplyV1>` over the sign protocol, the node's
`PrivateKey` (to add self's own signature without an RPC), `selfMemberBytes`, and `cohortEpoch()`.

`assemble`:
1. Sign `payload` locally (self is always a signer) via `signPeer`.
2. Concurrently `dialSign` the other cohort members (exclude self), collecting `SignReplyV1`s, until
   `≥ minSigs` distinct valid signatures are gathered or the cohort is exhausted / a deadline passes.
3. Verify each returned signature (`verifyPeerSig`) before counting it — a member must not be able to
   poison the blob with a bad sig.
4. Order `signers` deterministically (ascending by peer id) and build `thresholdSig` as the aligned
   concatenation. Return `{ thresholdSig, signers }`. If fewer than `minSigs` were collected, throw
   (the promotion/cert path treats this as "no notice this round" and re-fires next tick).

`verify` is the pure split-and-check described above (sync).

### Wire the membership-cert publisher

The host composes a `verifier` and a `publishSink` but **never** drives a `MembershipCertPublisher`.
Per `CoordEngine`, construct `createMembershipCertPublisher({ signer, sink: publishSink, minSigs })`
and call `onStabilized(snapshot, now)` (on cohort-membership change) and `tick(snapshot, now)` (on
the periodic driver — the gossip-cadence ticket owns the timer; expose a `pumpMembership(now)` hook
here that that ticket calls). The published `MembershipCertV1` is now threshold-signed for real, so
`FretMembershipPublishSink.latest()` serves a cert a remote `MembershipVerifier` can actually verify.

## Edge cases & interactions

- **Sync verify contract:** `ICohortThresholdCrypto.verify` is synchronous and called from
  `CohortSigner.verifyThreshold`; the noble-Ed25519 verify keeps it sync. Do **not** introduce an
  async verify (would ripple into the whole verifier path). Confirm with a unit test that
  `verifyThreshold` over a real assembled sig returns true and a tampered chunk returns false.
- **Quorum unreachable / liveness:** if `< minSigs` members are reachable/willing, `assemble` throws
  → the promotion notice / cert is simply not produced this round and retries on the next
  count-change/tick. It must **never** fabricate a single-signer sig (the interim bug). Test the
  short-quorum path.
- **Malicious/garbage SignReply:** an invalid signature, a signer not in `assembleCohort(coord)`, or
  a duplicate signer is dropped before counting; collection continues. Test a poisoned reply.
- **Epoch rotation mid-collection:** if the cohort epoch rotates while collecting, signatures over
  the old epoch's payload still verify against the old member set; the cert/notice carries the epoch
  it was signed under (`cohortEpoch` field), and the verifier checks signers ⊆ the cert for **that**
  epoch. Accept a one-rotation-stale endorsement (matches the verifier's stale-cert tolerance,
  §Stale membership cache); reject older.
- **Self not in own assembly:** if `assembleCohort(coord)` (stale table) omits self, self still signs
  (it is the acting member) and is included in `signers`; the verifier checks against the published
  cert's member set, which the publisher derives from the same assembly — keep them consistent.
- **`cohortMembers` ordering vs sharding:** `signers` ordering is independent of the
  primary/backup sharding order; only the cert's `members` must be sorted ascending (publisher
  already does this). Keep `signers` deterministic for reproducible `thresholdSig`.
- **minSigs > cohort size:** if `assembleCohort` returns `< minSigs` peers (tiny network),
  `assemble` cannot succeed; document that the live-tier milestone requires a network of
  `≥ minSigs` nodes (the e2e ticket stands up exactly that).
- **Sign-RPC abuse (anti-DoS):** the sign handler should only sign for cohort members and recognized
  kinds; it does no expensive work beyond one Ed25519 sign. Note the interaction with the anti-DoS
  ticket (rate-limit sign requests per peer if needed) but keep the endorsement-policy gate here.

## TODO

- Add `PROTOCOL_COHORT_SIGN` to `protocols.ts`, the `CohortTopicProtocols` interface,
  `DEFAULT_*`/`makeCohortTopicProtocols`/`cohortTopicProtocolList`, and the handshake test set.
- Define `SignRequestV1` / `SignReplyV1` wire types + validators + codec entries in db-core `wire/`.
- Rewrite `FretCohortThresholdCrypto` as coord-scoped: real `assemble` (local sign + concurrent
  `dialSign` collection to `minSigs`, verify-before-count, deterministic concat) and sync `verify`
  (split + `verifyPeerSig` per chunk).
- Register the `sign` protocol handler in the host; implement the endorsement policy
  (membership/promotion/demotion) against the serving `CoordEngine`'s cohort + store.
- Construct a per-`CoordEngine` `FretCohortThresholdCrypto` with its `cohortMembers`/`dialSign`/
  `privateKey`/`cohortEpoch` deps; feed it into that engine's `CohortSigner`.
- Construct a per-`CoordEngine` `MembershipCertPublisher`; expose `pumpMembership(now)` /
  `onStabilized(now)` hooks for the periodic-driver ticket; publish through the existing sink.
- Tests: assemble a real ≥minSigs sig across in-process nodes (mesh-harness style) and verify it;
  tampered-chunk rejected; short-quorum throws (no single-signer fabrication); poisoned SignReply
  dropped; a published `MembershipCertV1` verifies via `MembershipVerifier`.
- Run `yarn test:db-core`, `yarn test:db-p2p` (stream with `tee`), and the type-check before handoff.
