description: A machine far from a collection's log tail used to trust whatever list it first saw of the group that signs that collection's change announcements; it now checks that list against the signed commit record of the tail block, which the same group produced. Review the check, its wiring into the node, and one ordering fix made to the trust gate along the way.
prereq: reactivity-notifications-need-the-tail-cohort-to-be-the-topic-cohort
architecture: docs/reactivity.md#authentication-and-integrity
files: packages/db-p2p/src/cohort-topic/commit-log-trust-anchor.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/fret-trust-anchor.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-core/src/cohort-topic/membership/verifier.ts, packages/db-core/src/cohort-topic/ports.ts, packages/db-core/src/cohort-topic/sig/threshold.ts, packages/db-core/src/reactivity/verify.ts, packages/db-p2p/test/cohort-topic/commit-log-trust-anchor.spec.ts, packages/db-core/test/cohort-topic/membership.spec.ts, packages/db-core/test/reactivity/verify.spec.ts, docs/reactivity.md, docs/cohort-topic.md, docs/internals.md, docs/debugging.md, tickets/backlog/hardening/cohort-topic-trust-anchor-fret-stabilization-proof.md, tickets/backlog/feat-cluster-membership-threshold-cert-anchoring.md
difficulty: hard
----

# Reactivity root membership anchored by the tail block's commit proof

## What was built

A subscriber verifies a change notification against the root group's membership certificate (`MembershipCertV1`). The only production trust anchor, `FretTrustAnchor`, can vouch only for a group the node is itself in, so a subscriber outside the tail's storage group accepted the certificate on first use. The root group is the tail block's storage group, and that group persists a commit proof for the tail (`BlockCommitProof`) that any machine can verify offline. The new anchor fetches that proof and compares the certificate's signers with the cohort the proof names.

- **`CommitLogTrustAnchor`** (`packages/db-p2p/src/cohort-topic/commit-log-trust-anchor.ts`, new). `directAnchor(cert, tier, placement)`:
  - `"unknown"` when the placement has no `rootKey`, when `ringHash(rootKey)` is not the certificate's coordinate, when no certified proof is available, on any decode failure, and on partial overlap between the certificate's signers and the proof's `peerIds`.
  - `"anchored"` when every signer is in `peerIds`; `"rejected"` when none is.
  - The anchoring set: every member of `membersAt(coord)` is asked in parallel for the tail's latest claim and proof; each proof is run through `certifyClaim` against the claim the peer made; the highest certified revision wins; two action ids at that revision log `commit-log-anchor:equivocation` and yield no set.
  - One cache entry per tail (the set or its absence) for 30 s, one in-flight fetch per tail, capped at 1024 tails. No timers.
- **Port changes (db-core).** `IMembershipTrustAnchor.directAnchor` may return a promise. `RootPlacement` gained `rootKey?`, and `createRootPlacement(quorumRatio, rootKey?)` carries it. The cache identity still compares `quorumRatio` alone, and the membership source still receives only `{ rootPlaced: true }`. `createNotificationVerifier` passes the notification's tail bytes as `rootKey` on every call.
- **Composition (db-p2p).** `CohortTopicHostOptions.trustAnchor`; `composeTrustAnchors` in `host.ts` asks the FRET anchor first and consults the injected anchor only on `"unknown"`. `createLibp2pNodeBase` builds the commit-log anchor over `rootGroupAt`, the node's `clusterLatestCallback`, `proofThresholds(consensusConfig.superMajorityThreshold)` and `createRingHash()`, inside the `cohortEnabled` block. A caller's own `cohortTopic.host.trustAnchor` replaces it.
- **No barrel export.** `FretTrustAnchor` is not exported from the db-p2p barrel, so neither is the new class.

## Where this departs from the implement ticket

**The trust gate is not one async function.** The ticket said to make `certIsTrusted` async and have `loadFrom` await it, and also required that the gate's reads of per-coordinate state and the cache write happen in one synchronous run after the anchor's `await`. Those two conflict: awaiting an async function puts a microtask between the gate's last read and `loadFrom`'s write. With two loads of one coordinate in flight, the second load's first-use check ran in that gap, missed the lock the first load was about to write, and its certificate was then written over the anchored one. I reproduced this with a failing test before changing the code. The gate is now two steps: `directVerdict` (self-consistency, trust roots, the direct anchor; reads no per-coordinate state; async) is awaited by `loadFrom`, and `certIsTrusted(cert, direct, placement)` is synchronous and runs in the same turn as the cache write. The comment at the `await` in `loadFrom` states the constraint.

**Proofs at one revision under one action id are united.** The ticket did not say what to do when two certified proofs at the top revision share an action id but list different peers. The anchor takes the union of their `peerIds`. The reasoning (module header): a half-landed write is re-sent at the same action id and revision, possibly to a group that changed between attempts. This is a judgment call the reviewer should weigh; intersection or "first" are the alternatives.

**Two small additions.**
- A callback that throws synchronously for one peer (an unparseable peer id reaching `peerIdFromString`) counts as that peer's silence instead of failing the whole fetch.
- `commit-log-anchor:set tail=… rev=… peers=…` is logged once per fetch. Without it a root that fell back to first use is indistinguishable from an anchored one. `docs/debugging.md` lists the anchor's log lines.

## Tests added

`packages/db-p2p/test/cohort-topic/commit-log-trust-anchor.spec.ts` (new; real multi-peer proofs from `test/support/commit-proof-fixtures.ts`, stub group and latest-claim wire):

- signers inside the committing cohort → `"anchored"`, and every group member is asked once
- signers disjoint from the cohort → `"rejected"`
- partial overlap → `"unknown"`
- no proof served (a claim with no proof, a peer holding nothing, a silent peer) → `"unknown"`
- a root key that does not hash to the certificate's coordinate → `"unknown"`, with no query issued
- a lagging peer's older certified proof loses to the current revision (current cohort anchored, superseded cohort rejected)
- two certified actions at the top revision → `"unknown"`
- two concurrent first calls issue one round of queries; a call inside the window issues none; a call past it asks again

`packages/db-core/test/cohort-topic/membership.spec.ts`:

- a promised `"rejected"` overrides first-use acceptance; a promised `"anchored"` trusts the certificate and a later un-anchored one for that coordinate is refused
- **not in the ticket's list:** an un-anchored load in flight beside an anchored one sees the lock the anchored load established. This is the reproduction of the ordering defect above; it failed against the ticket's literal structure and passes now.

`packages/db-core/test/reactivity/verify.spec.ts` (new):

- the anchor receives a placement whose `rootKey` equals the notification's tail bytes. This is a wiring test, kept on the ticket's instruction: dropping the key degrades every distant subscriber to first-use trust with no other symptom.

## Validation run

- `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs`: all pass on the final tree.
- db-core `yarn test`: 1855 passing.
- db-p2p `yarn test`: 3197 passing, 65 pending (env-gated).
- db-p2p `yarn test:integration`: 46 passing, 2 pending (both pending cases predate this ticket).
- The two full db-p2p runs happened before the last two edits to the anchor (the `commit-log-anchor:set` log line and a comment). After those edits I re-ran the anchor, FRET anchor and logger specs (34 passing) and the wide-mesh watch integration case.
- **End-to-end evidence.** The wide-mesh watch case (six machines, `clusterSize` 3, a watcher outside the tail's group) run with `DEBUG=optimystic:db-p2p:cohort-topic` printed `commit-log-anchor:set tail=… rev=2 peers=3` on the watcher at the moment of the wake. So on a real mesh the anchor finds a certified proof and takes the tail's three-member group as its set.
- Not run: `quereus-plugin-optimystic` suites, `yarn check:rn`, root `yarn test`. None was on the ticket's list; the anchor uses the same lazy `TextDecoder` idiom as `peer-codec.ts`.

## Known gaps and things to probe

- **No automated test asserts the end-to-end verdict.** The integration case passes whether the anchor answers `"anchored"` or falls back to first use; the evidence above is a manual run reading a debug line. There is no outward handle on the verdict to assert against.
- **One group member can control the set.** A proof verifies when the peers it lists signed it, whoever they are. A machine in the tail's storage group can sign a proof with made-up keys at a revision above the real one; a distant subscriber then rejects the real group's certificate for as long as that machine keeps serving it, and learns of changes only from the watch's periodic tail read. Before this ticket the real certificate would have displaced a forged one on the next verify miss, so for this adversary push delivery is worse than before. The ticket names this limit (`feat-cluster-membership-threshold-cert-anchoring`); I appended the concrete consequence to that backlog ticket. A cheaper partial check — requiring the proof's `peerIds` to overlap `membersAt(coord)` — was not built because the design was marked decided and one member can list itself.
- **A held set can be one commit behind** (tripwire `NOTE:` at `anchoringSetFor`). After the tail's group changes, a new certificate is judged against the older cohort until the 30 s window ends. Refetching on mismatch was not done because forged notifications could then drive group queries.
- **A transient `"unknown"` still admits the certificate on first use** (tripwire `NOTE:` at `composeTrustAnchors`), and absence is cached for the full window, so one unanswered fetch means 30 s of first-use trust for that tail.
- **Inspection-only edge cases** from the ticket, not tested: placement without `rootKey`; this node inside the root group (FRET verdict wins, no query); partition; tail rotation; `clusterSize: 1` never announcing; no teardown needed.
- **`verifyMessage` has other awaits** (`source.current`, `source.fetch`) across which two calls interleave. Those predate this ticket and I did not audit them beyond the load path.
