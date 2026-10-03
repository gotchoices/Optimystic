description: A machine far from a collection's log tail cannot check who is in the group that signs that collection's change announcements, so it trusts whatever group list it sees first; check that list against the signed commit record of the tail block instead, which the same group produced and any machine can verify.
prereq: reactivity-notifications-need-the-tail-cohort-to-be-the-topic-cohort
architecture: docs/reactivity.md#authentication-and-integrity
files: packages/db-core/src/cohort-topic/ports.ts, packages/db-core/src/cohort-topic/sig/threshold.ts, packages/db-core/src/cohort-topic/membership/verifier.ts, packages/db-core/src/reactivity/verify.ts, packages/db-p2p/src/cohort-topic/commit-log-trust-anchor.ts (new), packages/db-p2p/src/cohort-topic/fret-trust-anchor.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/certified-claims.ts, packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/storage/block-archive.ts, packages/db-core/test/cohort-topic/membership.spec.ts, packages/db-core/test/reactivity/ (verify spec), packages/db-p2p/test/cohort-topic/commit-log-trust-anchor.spec.ts (new), docs/reactivity.md, docs/cohort-topic.md, docs/internals.md, tickets/backlog/hardening/cohort-topic-trust-anchor-fret-stabilization-proof.md
difficulty: hard
----

# Anchor the reactivity root's membership to the tail block's commit proof

## What is wrong today

A subscriber (or forwarder) checks a change notification's signature against the root group's membership certificate (`MembershipCertV1`). The db-core trust gate (`CachingMembershipVerifier.certIsTrusted` in `packages/db-core/src/cohort-topic/membership/verifier.ts`) believes a fetched certificate only when a trust root, the direct anchor (`IMembershipTrustAnchor`), or the rotation chain vouches for it; otherwise it falls back to trust-on-first-use (TOFU).

The only direct anchor bound in production is `FretTrustAnchor` (`packages/db-p2p/src/cohort-topic/fret-trust-anchor.ts`). For a root-placed coordinate it judges against the root-group snapshot the host holds, and answers `"unknown"` whenever this node is not in that group. A subscriber is almost never in the tail's storage group, so in a network wider than one group nearly every root certificate is accepted on first use.

## What the collection's own data already proves

Since `reactivity-notifications-need-the-tail-cohort-to-be-the-topic-cohort`, the reactivity root group is the tail block's storage group, and every commit that touches the tail runs consensus on that group. The cohort persists a durable commit proof for the tail block (`BlockCommitProof`, `packages/db-p2p/src/cluster/commit-proof.ts`; `docs/internals.md` § Durable commit proof): the commit message plus the promise- and commit-round signatures of a super-majority of `proof.peerIds`, with `peerIds` bound into every signature by the membership digest. Any machine can check it offline (`certifyClaim` in `packages/db-p2p/src/cluster/certified-claims.ts`, which also caps signer count at `MAX_PROOF_SIGNERS`). Cohort peers already serve it on the latest-query wire: the node's `clusterLatestCallback` in `packages/db-p2p/src/libp2p-node-base.ts` returns a `CertifiedActionRev` (claim plus proof, read out of one archive revision entry by `latestClaimFromArchive`).

So a distant node can ask the tail's storage group for the tail's latest certified claim, verify the proof, and compare the root certificate's signers against `proof.peerIds`.

## Design (decided)

### The rule — `CommitLogTrustAnchor.directAnchor(cert, tier, placement)`

New class in `packages/db-p2p/src/cohort-topic/commit-log-trust-anchor.ts`, implementing `IMembershipTrustAnchor`:

- No `placement`, or a placement with no `rootKey` → `"unknown"` (not a root-placed cert this anchor can locate).
- `ringHash(placement.rootKey)` ≠ the bytes of `cert.cohortCoord` → `"unknown"` (the key does not name this coordinate; never judge one against the other).
- Decode `rootKey` as the tail block id (UTF-8; `routingKeyForBlock` is the raw UTF-8 of the id — `packages/db-core/src/network/routing-key.ts`).
- Obtain the **anchoring set** for that tail (below). None available → `"unknown"`.
- Decode `cert.signers` to peer-id strings (`bytesToPeerIdString(b64urlToBytes(s))`, as `FretTrustAnchor` does). Empty → `"unknown"`.
  - every signer ∈ anchoring set → `"anchored"`;
  - no signer ∈ anchoring set → `"rejected"`;
  - partial overlap → `"unknown"` (membership churned between the tail's last commit and the cert; do not over-reject — the chain or a later commit settles it).
- Any decode failure on attacker-supplied bytes → `"unknown"`. Total; never throws.

Compare against the cert's `signers` (the quorum that actually signed), not `members`, for the same reason `FretTrustAnchor` does: a forger cannot list real members as signers without their keys.

### The anchoring set

`peerIds` of the highest-revision **certified** tail proof the tail's storage group returns:

- Ask every member of `membersAt(coord)` — the node's existing `rootGroupAt` binding over `keyNetwork.servingCohortAt` — in parallel through an injected `latestClaimFrom(peerId: string, blockId): Promise<CertifiedActionRev | undefined>`. In node-base this adapts the existing `clusterLatestCallback` (`peerIdFromString`; it already short-circuits self to local storage and applies the per-peer `cohortQueryTimeoutMs` budget). A rejection is silence: skip that peer. Settle all, then decide.
- For each answer carrying a proof, `certifyClaim(proof, { blockId: tail, rev, actionId }, thresholds)` with `thresholds = proofThresholds(consensusConfig.superMajorityThreshold)`. The claim binding is what stops a valid proof for another block or revision being replayed. Uncertified proofs are ignored (logged at debug with the failure reason), never penalized here.
- Pick the highest certified `rev`. Two certified proofs at that rev under different `actionId`s → no anchoring set (`"unknown"`) and a log line `commit-log-anchor:equivocation` naming tail, rev and both action ids.
- No certified proof (pre-proof tail revision, no peer answered, all proofs failed) → no anchoring set.

Why `peerIds` rather than only the proof's verified signers: `peerIds` is the whole committing cohort, attested by the super-majority that signed over its digest; a cert signer who was in the cohort but did not happen to vote in that one commit is still a legitimate member.

### Caching and flood bound

Per tail block id: one entry `{ peerIds | undefined, rev, fetchedAt }` (absence cached too), reused for `ttlMs` (default 30 000, the renewal cadence); one in-flight query per tail (concurrent calls share its promise); `LruMap` cap `maxTails` (default 1024). The anchor is consulted only when the membership source has returned a self-consistent cert for exactly that coordinate (`loadFrom` checks `cohortCoord` before the gate), so an attacker spraying fake tail ids gets no proof queries from honest groups; the TTL bounds the rest to one group query per tail per 30 s.

### Composing with the FRET anchor

`CohortTopicHostOptions` gains `trustAnchor?: IMembershipTrustAnchor`. The host's verifier gets an anchor that asks `FretTrustAnchor` first and uses its verdict when it is `"anchored"` or `"rejected"` (this node is in the group and holds the snapshot: local authority, no network); only on `"unknown"` does it consult the injected anchor. A small local function in `host.ts` is enough. Node-base passes a `CommitLogTrustAnchor` built over `rootGroupAt`, the adapted `clusterLatestCallback`, the proof thresholds and the db-core ring hash, only in the `cohortEnabled` block.

### Port changes in db-core

- **The anchor may be asynchronous.** `IMembershipTrustAnchor.directAnchor` returns `TrustAnchorVerdict | Promise<TrustAnchorVerdict>`. `certIsTrusted` becomes async and awaits it; `loadFrom` (already async) awaits `certIsTrusted`. `noAuthorityTrustAnchor` and `FretTrustAnchor` stay synchronous (their declared return type stays `TrustAnchorVerdict`, which satisfies the union, so `fret-trust-anchor.spec.ts` is untouched). Rejected alternative: keep the port synchronous and have the watch service pre-fill a proof snapshot, as `rootGroupAt` is pre-filled — it misses forwarders, races the first notification, and a missed fill leaves the cert TOFU-cached.
- **The placement names its key.** `RootPlacement` gains `rootKey?: Uint8Array` — the routing key whose ring position is the root coordinate, when the caller knows it. `createRootPlacement(quorumRatio, rootKey?)`. It does not take part in cache identity: `heldUnder` and `lockedUnderAnotherRule` keep comparing `quorumRatio` only (a coordinate is the hash of its key, so one coordinate has one key). The membership source keeps receiving only `{ rootPlaced: true }`.
- `createNotificationVerifier` (`packages/db-core/src/reactivity/verify.ts`) passes a placement carrying `rootKey = b64urlToBytes(n.tailId)` — the same bytes it already derives `expectedCoord` from — on every `verifyMessage` call. Validate the ratio once at construction and spread per call.

### Limits to state in the docs (not solved here)

- A verified proof says the listed signers signed, not that they are the tail's legitimate cohort (`feat-cluster-membership-threshold-cert-anchoring`). The proof is fetched from the group this node's own key network names for the tail — the same group its reads and writes of that block are routed to — so this anchor ties reactivity trust to the trust the node already places in the collection's data, and no further.
- A transient `"unknown"` (no group member answered in budget, a tail revision with no retained proof) still lets the cert in on first use, and it stays TOFU-cached until a verify-miss refetches it. Record as a `NOTE:` tripwire at the composition in `host.ts`: if first-use acceptance after an anchor timeout shows up, re-run the gate on a TOFU-cached root cert at the next renewal tick.

## Edge cases & interactions

- **Concurrent verifies of one coordinate across the new `await`.** All reads of `byCoord` / `staleGapStrikes` in the gate (chain, fallback, stale-gap recovery, `lockedUnderAnotherRule`) and the cache write must happen after the anchor's `await`, in one synchronous run, so two in-flight loads cannot interleave a state read with another's write. Verified by inspection; say so in a comment at the `await`.
- **Async `"rejected"` is fatal**, overriding TOFU, exactly as a synchronous one. Test (db-core, below).
- **Placement without `rootKey`** (host engines' own root-placed verification, harnesses, older callers) → commit-log anchor `"unknown"`; behaviour unchanged. Inspection.
- **`rootKey` that does not hash to the cert's coordinate** → `"unknown"`. Test.
- **This node is in the root group**: FRET verdict wins; no proof query. Inspection of the composition.
- **Partition** (`detectPartition`): FRET says `"unknown"`, the commit-log anchor runs; its queries fail or answer — either is correct. Inspection.
- **Tail rotation**: a notification from the old tail checks against the old tail's latest proof (the rollover commit's rewrite of `nextId`, run on the old tail's group), which matches the old root's cert; the new tail's first proof is its insert commit on the new group. Inspection.
- **Mixed versions / pre-proof data**: a peer serving no proof, or a `legacy-record` proof, yields no anchoring set → `"unknown"` → today's TOFU. No regression. Test the no-proof case.
- **Proof for another block or revision replayed** → `certifyClaim` fails `claim-not-in-message` → ignored. Covered by `certifyClaim`'s own tests; no new test.
- **Equivocation at the top revision** → `"unknown"` plus the log line. Test.
- **Lagging peer** returning an older certified revision alongside a current one → highest rev wins. Test.
- **Cache**: second call inside TTL issues no query; concurrent first calls issue one. Test (one case covering both).
- **Group of one / `clusterSize: 1`** never announces (accepted tradeoff at `captureCommitCert`), so nothing reaches the anchor. Inspection.
- **Teardown**: the anchor holds no timers; nothing to stop. Inspection.

## Tests (only these)

- `packages/db-p2p/test/cohort-topic/commit-log-trust-anchor.spec.ts` (new), with real multi-peer proofs (reuse the proof-building helpers in `packages/db-p2p/test/commit-proof.spec.ts` or `mintSoloCommitProof` for a one-peer stand-in) and a stub `latestClaimFrom` / `membersAt`: anchored (signers ⊆ `peerIds`); rejected (disjoint); unknown on partial overlap; unknown with no proof served; unknown when `rootKey` does not hash to the coordinate; highest certified revision wins over a lagging peer; equivocation at the top revision → unknown; cache + single-flight.
- `packages/db-core/test/cohort-topic/membership.spec.ts`: one case — an anchor returning `Promise<"rejected">` makes the cert untrusted despite self-consistency, and `Promise<"anchored">` makes it trusted (a later un-anchored cert for the coordinate is rejected — the lock engages).
- db-core reactivity verify spec: one case — the anchor receives a placement whose `rootKey` equals the notification's tail bytes. This is wiring, kept deliberately: if the key is dropped the whole feature silently degrades to TOFU with no other symptom.

## Docs

- `docs/reactivity.md` § Authentication and integrity: replace the closing "trusts … on first use; anchoring it … is `feat-…`" sentence with what now happens (commit-log anchor, the rule, the two limits above).
- `docs/cohort-topic.md` § Bootstrapping trust: the direct-anchor bullet (anchors compose: FRET first, then the injected anchor; the port may be async), and the TOFU-limits bullet ("Distant first-sight T2/T3 … remain TOFU") — reactivity roots are now anchored by the tail's commit proof; other distant coordinates remain TOFU. § Root placement at a routing key implementation note: `RootPlacement.rootKey`.
- `docs/internals.md` § Durable commit proof: add the reactivity root anchor to the consumers of proofs, one sentence.
- Header comments: `fret-trust-anchor.ts` (the "future tx-log anchor" remark and the "Synchronous on purpose" note on `rootGroupAt`), `verifier.ts` module header (which bindings close the TOFU gap), `IMembershipTrustAnchor` doc in `ports.ts`.
- Append one line to `tickets/backlog/hardening/cohort-topic-trust-anchor-fret-stabilization-proof.md`: its headline case (a distant reactivity subscriber) is now covered by this anchor for reactivity roots; it still matters for other distant T2/T3 coordinates.
- Run `yarn lint:docs`.

## TODO

- db-core: `RootPlacement.rootKey`, `createRootPlacement(quorumRatio, rootKey?)`; async-capable `directAnchor`; async `certIsTrusted` with the await-ordering comment; notification verifier passes the tail bytes.
- db-p2p: `CommitLogTrustAnchor` (rule, anchoring set, cache, single-flight, equivocation log on the existing `cohort-topic` logger); `CohortTopicHostOptions.trustAnchor` and the FRET-first composition with the tripwire `NOTE:`; node-base construction over `rootGroupAt`, adapted `clusterLatestCallback`, `proofThresholds(consensusConfig.superMajorityThreshold)`, `createRingHash()`; export the class from the package barrel beside `FretTrustAnchor` if that one is exported.
- Tests listed above.
- Docs and comments listed above.
- Validate: `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs`, db-core and db-p2p `yarn test`, and db-p2p `yarn test:integration` (the reactivity integration cases exercise the verifier end to end).
