description: Review intra-cohort gossip bus, k−x threshold signer, and MembershipCertV1 publish/verify (one-refetch-retry) — db-core logic over injected FRET-backed ports.
prereq: cohort-topic-registration-storage-sharding, cohort-topic-package-layering
files:
  - packages/db-core/src/cohort-topic/ports.ts (new ports: ICohortThresholdCrypto, IMembershipPublishSink)
  - packages/db-core/src/cohort-topic/gossip/bus.ts (CohortGossipBus — merge + drift)
  - packages/db-core/src/cohort-topic/gossip/view.ts (per-member CohortView)
  - packages/db-core/src/cohort-topic/gossip/records.ts (RegistrationRecord ↔ GossipRecordV1)
  - packages/db-core/src/cohort-topic/sig/threshold.ts (CohortSigner), sig/payloads.ts (signing images)
  - packages/db-core/src/cohort-topic/membership/{verifier,publisher,source}.ts
  - packages/db-core/src/cohort-topic/wire/{types,validate}.ts (CohortGossipV1 records/evicted deltas)
  - packages/db-p2p/src/cohort-topic/{threshold-crypto,membership-publish-sink}.ts (FRET stubs)
  - packages/db-core/test/cohort-topic/{gossip,threshold,membership}.spec.ts
  - docs/cohort-topic.md (§Cohort gossip, §Membership source, §Membership fetch)
----

# Review: cohort gossip, threshold signatures, MembershipCertV1 publish + verify

## What was built

The replication + trust layer for the cohort-topic substrate, all as **db-core logic over injected
ports** (db-core never imports FRET; db-p2p supplies FRET-backed implementations — currently
`notWiredToFret` stubs pending `cohort-topic-core-module-fret-integration`).

**Phase 1 — gossip (`gossip/`).** `createCohortGossipBus({ transport, store, coord, localEpoch, now? })`:
- `broadcast(g)` → `ICohortGossipTransport.broadcast(coord, encode(g))`.
- inbound (transport path or `applyInbound(g, now)` directly) **merges**: registration-record deltas
  into the `RegistrationStore` (last-writer-wins by `lastPing`; `evicted` refs deleted), and
  willingness/load/`topicSummaries` into a per-member `CohortView` (LWW by gossip `timestamp`).
- **epoch drift:** an inbound `cohortEpoch ≠ localEpoch()` fires `onDrift` handlers, and record
  deltas under a foreign epoch are **not** merged (their slot assignments belong to another snapshot).
- To carry records, `CohortGossipV1` gained optional `records?` / `evicted?` fields (wire types +
  validators + doc updated; existing round-trips unaffected since fields are optional).

**Phase 2 — threshold sig (`sig/threshold.ts`).** `createCohortSigner(crypto, minSigs=14)`:
- `thresholdSign(payload)` delegates to `ICohortThresholdCrypto.assemble(payload, minSigs)`.
- `verifyThreshold(payload, sig, signers, cert, minSigs)` = db-core membership check (distinct
  `signers`, all in `cert.members`, count `≥ minSigs`) **and** `crypto.verify(...)`. Canonical signing
  images for cert/promotion/demotion live in `sig/payloads.ts`.

**Phase 3 — membership certs (`membership/`).**
- `createMembershipCertPublisher({ signer, sink, refreshMs?, minSigs? })`: `onStabilized` publishes on
  the first call and whenever the **first `k−x` members** change; `tick` republishes after
  `T_membership_refresh` (5 min). Builds + threshold-signs the cert, emits via `IMembershipPublishSink`.
- `createMembershipVerifier({ signer, router, minSigs? })`: caches certs per coord; `verifyMessage`
  checks the cached cert, and on miss/failure does **exactly one** `fetch` refetch then retries
  (`"verified" | "untrusted"`). A refetched cert is trusted only if **self-consistent** (its own
  threshold sig is a quorum of its own members).
- `createMembershipSourceRouter({ committed, fret })`: **T0/T1 → committed (tx-log), T2/T3 → FRET**.

## How to validate (use cases the specs cover — treat as a floor)

`yarn build && yarn test` in `packages/db-core` (427 passing; 24 new). The new specs:
- **gossip.spec.ts** — a touched record on one member is visible on all after **one** `applyInbound`
  round; record-delta LWW by `lastPing`; eviction delta; per-member view merge + LWW by timestamp;
  epoch-drift fires and suppresses foreign-epoch record merge; no drift when epochs match.
- **threshold.spec.ts** — verifies with `minSigs` (= `k−x` = 14) signers, fails at `minSigs−1`, fails
  on a non-member signer, fails on a duplicated signer padding the count, fails on a bad signature,
  honours a custom `minSigs`.
- **membership.spec.ts** — direct cached-cert verify (no fetch); **stale cert → exactly one refetch →
  success**; refetch still failing → **untrusted** (no second fetch); no-cache consults `current()`
  before forcing `fetch()`; nothing available → untrusted; refetched non-self-consistent cert
  rejected; **T0/T1→committed, T2/T3→FRET** routing. Publisher: publishes at first stabilization;
  republishes on first-`k−x` change but **not** on tail-only change; refreshes only after the interval.

## Known gaps / reviewer attention

- **All FRET-backed ports are stubs** (`ICohortThresholdCrypto`, `IMembershipPublishSink`,
  `ICohortGossipTransport`, `IMembershipSource` in db-p2p throw `notWiredToFret`). The real
  convergence-within-one-round claim over an actual FRET cohort is the mock-tier e2e suite's job
  later; here it is proven over an in-memory fan-out transport / mock crypto only.
- **`verifyMessage` gained a `tier` parameter** vs the ticket's interface sketch. A coord is an
  opaque hash, so the mandated T0/T1-vs-T2/T3 dispatch cannot be derived from the coord alone; the
  caller already knows the tier (it computed the coord from the message's claimed tier/topic).
  Documented inline in `verifier.ts`. Confirm this is acceptable.
- **Cert trust is self-consistency only** (quorum of the cert's own members). Chain-to-genesis
  bootstrapping (§Bootstrapping trust) is **not** implemented — a forged but internally-consistent
  cert from an unrelated key set would pass the per-message check. Acceptable for this ticket?
- **Touch-vs-eviction race:** record merge is LWW by `lastPing`, but `evicted` deletes
  unconditionally. A touch on member A racing an eviction on member B could converge either way
  across one round; this matches "stale ≤ one round" but is worth a skeptical look.
- **Mock crypto in publisher.spec** returns signers from a global member list, not the snapshot's
  members, so the *published* cert's signers aren't necessarily its members — the publisher tests
  only assert count/sorted-members/cadence, not signer validity (that's FRET's contract).
- **`max_message_bytes`** is still the flat 1 MiB default; adding `records[]` to gossip widens the
  worst case but the exact bound from `topics_max` remains a pre-existing TODO in `wire/codec.ts`.
- The willingness-vector and load-barometer **semantics** (flip logic, bucket math, counter reset on
  epoch change) are *not* here — they are downstream tickets that consume the per-member `CohortView`
  this bus exposes.

## Done-when status
- `yarn build` green for db-core and db-p2p. ✅
- `yarn test` green for db-core incl. new specs (427 passing). ✅
- `docs/cohort-topic.md` records the resolved membership-source decision and matches the implemented
  gossip/cert/threshold surfaces. ✅
