description: Intra-cohort gossip bus, k−x threshold signer, and MembershipCertV1 publish/verify (one-refetch-retry) — db-core logic over injected FRET-backed ports. Implemented and reviewed.
files:
  - packages/db-core/src/cohort-topic/ports.ts (ICohortThresholdCrypto, IMembershipPublishSink)
  - packages/db-core/src/cohort-topic/gossip/{bus,view,records}.ts
  - packages/db-core/src/cohort-topic/sig/{threshold,payloads}.ts
  - packages/db-core/src/cohort-topic/membership/{verifier,publisher,source}.ts
  - packages/db-core/src/cohort-topic/wire/{types,validate}.ts
  - packages/db-p2p/src/cohort-topic/{threshold-crypto,membership-publish-sink}.ts
  - packages/db-core/test/cohort-topic/{gossip,threshold,membership}.spec.ts
  - docs/cohort-topic.md
----

# Cohort gossip, threshold signatures, MembershipCertV1 publish + verify — COMPLETE

The replication + trust layer for the cohort-topic substrate, built as **db-core logic over injected
ports** (db-core never imports FRET; db-p2p supplies FRET-backed implementations, currently
`notWiredToFret` stubs pending `cohort-topic-core-module-fret-integration`).

## What shipped

- **Gossip bus** (`gossip/bus.ts`, `view.ts`, `records.ts`): `createCohortGossipBus` broadcasts
  outbound gossip and merges inbound — registration-record deltas into the `RegistrationStore` (LWW by
  `lastPing`; `evicted` refs deleted), willingness/load/`topicSummaries` into a per-member
  `CohortView` (LWW by gossip `timestamp`). Inbound `cohortEpoch ≠ localEpoch()` fires `onDrift` and
  suppresses foreign-epoch record merges. `CohortGossipV1` gained optional `records?`/`evicted?`.
- **Threshold signer** (`sig/threshold.ts`, `payloads.ts`): `createCohortSigner(crypto, minSigs=14)`;
  `verifyThreshold` layers the db-core membership check (distinct signers, all in `cert.members`,
  count `≥ minSigs`) over `crypto.verify`. Canonical signing images in `payloads.ts`.
- **Membership certs** (`membership/`): publisher (publish at first stabilization, on first-`k−x`
  change, and on the `T_membership_refresh` tick); verifier (cached-cert check + exactly one
  refetch-and-retry; refetched certs accepted only if self-consistent); source router (T0/T1 →
  committed tx-log, T2/T3 → FRET).

## Validation

`yarn build` green for db-core and db-p2p; `yarn test` green for db-core — **428 passing** (24 from the
implement pass + 1 added in review). No lint step exists (root `lint` script is a no-op `echo`); the
strict `tsc` build is the type gate and passes for both packages.

## Review findings

Read the implement diff (commit `8183109`) with fresh eyes before the handoff, then traced every
touched file plus the codec, registration store, byte helpers, validators, and existing ports/tickets.

### Correctness / logic
- **Record resurrection past TTL (minor — fixed inline).** `mergeRecords` ignored its `now` argument
  (`_now`) and merged any gossiped record regardless of age. A record already past its TTL
  (`now − lastPing > ttl`) would be reintroduced into a member's store even though `store.evictStale`
  uses exactly that predicate to remove it locally — replication could undo local eviction. Fixed:
  `mergeRecords` now skips records expired at merge time (same predicate), which also gives the
  previously-dead `now` parameter a purpose. Added regression test
  `does not resurrect a record already past its TTL at merge time` (gossip.spec.ts).
- **Touch-vs-eviction race (checked — acceptable).** Record merge is LWW by `lastPing`; `evicted`
  deletes unconditionally. A touch on A racing an eviction on B can converge either way across one
  round, which matches the spec's "stale ≤ one round" tolerance. No change.
- **Verifier refetch / cache logic (checked — correct).** Confirmed: cached hit → no fetch; no cache →
  `current()` then at most one `fetch()`; stale cache → straight to one `fetch()` (no `current()`);
  failure after refetch → `untrusted` with no second fetch. Self-consistency gate on refetched certs
  verified. Threshold edge cases (below-threshold, non-member, duplicate-padding, bad sig, custom
  minSigs) all covered. No change.

### Type safety / robustness
- **Misleading comment in `verifier.ts:certIsSelfConsistent` (minor — fixed inline).** The comment
  claimed the validating codec guarantees the cert's byte fields are base64url, but
  `validateMembershipCertV1` validates `members`/`signers` only as a string array (`reqStringArray`,
  not `b64urlField`). `b64urlToBytes(signer)` therefore *can* throw `CohortWireError`; the actual
  safety net is `loadFrom`'s try/catch (which correctly treats it as "no cert"). Corrected the comment
  to state the real invariant. Behavior was already safe — comment-only fix.
- **`onGossip` asymmetry (checked — acceptable).** `onGossip` handlers fire only on the
  transport-delivered path (`onInbound`), not on direct `applyInbound` calls. `applyInbound` is the
  lower-level merge primitive and `onInbound = applyInbound + notify`; defensible. Noted, no change.

### Security (major → filed)
- **Cert trust is self-consistency only — no trust anchoring (major — filed
  `tickets/backlog/cohort-topic-membership-cert-trust-anchoring.md`).** The verifier accepts any
  refetched cert whose own threshold signature is a quorum of its own `members`; nothing binds that
  key set to a network trust root. A forged-but-internally-consistent cert from an unrelated `k−x`
  key set passes the per-message check. This was a documented out-of-scope item (the per-message
  verifier was the ticket's scope; `docs/cohort-topic.md` §Bootstrapping trust describes the intended
  chain-to-genesis design but it is unimplemented). Filed as backlog, gated behind FRET integration.
- **Gossip `signature` never verified (checked — deferred, no new ticket).** The bus merges records
  and view from inbound gossip without verifying the per-member `signature` field. This is consistent
  with the whole substrate — no participant-signature verification exists anywhere yet, there is no
  injected port for it on the bus, and authentication of intra-cohort gossip is FRET-transport's
  responsibility, landing with `cohort-topic-core-module-fret-integration`. Abuse/DoS hardening is
  already covered by `cohort-topic-antiflood-antidos` (anti-replay, rate limits) and the backlog
  `gossip-reputation-blacklisting`. No new ticket.

### Deviations confirmed acceptable
- **`verifyMessage` gained a `tier` parameter** vs the ticket sketch. A coord is an opaque hash, so
  the mandated T0/T1-vs-T2/T3 source dispatch cannot be derived from the coord alone; the caller
  already knows the tier (it computed the coord). Documented inline. Accepted.

### Out of scope / pre-existing (unchanged)
- `max_message_bytes` is still the flat 1 MiB default; the exact bound from `topics_max` remains a
  pre-existing `TODO(cohort-topic)` in `wire/codec.ts`. Adding `records[]` widens the worst case but
  does not change the cap. Left as-is.
- Willingness/barometer/traffic semantics (flip logic, bucket math, epoch-reset) are downstream
  (`cohort-topic-willingness-barometer-traffic`) and consume the `CohortView` this bus exposes.
- FRET-backed ports remain `notWiredToFret` stubs; the convergence-in-one-round claim over a real
  FRET cohort is the mock-tier e2e suite's job (`cohort-topic-e2e-mock-tier`).

### Docs
- `docs/cohort-topic.md` was checked against the implemented surfaces (§Cohort gossip record/evicted
  deltas, §Membership source resolution, §Membership fetch publish/verify/one-refetch). Accurate. The
  §Bootstrapping trust gap is now tracked by the filed backlog ticket. No doc changes needed.

## Disposition summary
- Minor, fixed inline: record-resurrection TTL guard (+ regression test); inaccurate self-consistency
  comment.
- Major, filed: `cohort-topic-membership-cert-trust-anchoring` (backlog).
- Verified-clean categories stated above with reasons. db-core build + 428 tests green; db-p2p build
  green.
