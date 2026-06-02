description: Cohort gossip of records/willingness/load, k-x threshold-signed notices, MembershipCertV1 publish + participant verification with one-fetch-retry.
prereq: cohort-topic-registration-storage-sharding
files:
  - docs/cohort-topic.md (§Cohort gossip wire L563-585, §Membership snapshots L317-343, §Failure modes L424-428, §FRET integration L432-460)
  - C:/projects/Fret/packages/fret/src/service/fret-service.ts (cohort assembly, gossip, minSigs)
  - packages/db-core/src/cohort-topic
effort: high
----

# Intra-cohort gossip, threshold signatures, and MembershipCertV1 verification

This ticket gives the substrate its replication and trust layer: intra-cohort gossip that
spreads registration records / willingness / load, the threshold-signing of cohort
decisions, and the `MembershipCertV1` mechanism that lets any participant verify those
signatures. It folds two coupled concerns (gossip protocol; membership-and-signature
verification) because gossip is how members converge on the `cohortEpoch`/membership that
the certificate attests, and the certificate is how the gossiped threshold sigs are
checked.

## Cohort gossip

Per `docs/cohort-topic.md` §Cohort gossip (wire L563-585) and the various references to
"standard FRET cohort gossip". The substrate replicates, intra-cohort:

- `RegistrationRecord`s (so any member can serve / fail-over — feeds the handoff in the
  storage ticket).
- The per-member willingness vector (1 bit/tier — consumed by the willingness ticket).
- The per-tier load barometer buckets (consumed by the barometer ticket).
- Per-topic summaries (`directParticipants`, `arrivalsPerMin`, `queriesPerMin`, etc.).

The wire message is `CohortGossipV1` (already defined in the wire-formats ticket). Gossip
is timestamp-signed for authenticity (`signature` field over the envelope). `cohortEpoch`
on each gossip lets members detect membership drift. Gossip rides FRET's existing
intra-cohort gossip primitive — do not build a new transport; adapt FRET's cohort gossip
(`fret-service.ts`).

```ts
export interface CohortGossipBus {
	broadcast(g: CohortGossipV1): void;
	onGossip(handler: (g: CohortGossipV1) => void): () => void;
	applyInbound(g: CohortGossipV1, now: number): void;  // merge records/willingness/load, drift-check epoch
}
```

Convergence target: a single gossip round spreads a new/touched record (and willingness
flip) to all members. Stale gossip is acceptable (≤ one round) per doc.

## Threshold signatures

Per §FRET integration (L452) and §Promotion lifecycle: the cohort threshold-signs
`PromotionNoticeV1`, `DemotionNoticeV1`, and `MembershipCertV1` with `k − x` signers
(`minSigs`, default 14). Reuse FRET's `minSigs` cohort-signature assembly — do not
implement a new threshold scheme.

```ts
export interface CohortSigner {
	thresholdSign(payload: Uint8Array): Promise<{ thresholdSig: Uint8Array; signers: PeerId[] }>;
	verifyThreshold(payload: Uint8Array, sig: Uint8Array, signers: PeerId[],
		cert: MembershipCertV1, minSigs: number): boolean;
}
```

`verifyThreshold` checks the `signers` are a `≥ minSigs` subset of `cert.members` and the
sig is valid.

## MembershipCertV1 publish + verification

Per §Membership snapshots and signature verification (L317-343):

- The cohort publishes `MembershipCertV1` (already in wire ticket) at stabilization and on
  any change to the first `k − x` members; refreshed every `T_membership_refresh` (default
  5 min).
- Participants cache the latest cert per coord and verify threshold-signed messages
  against it (extract signers → compute expected coord → look up cert → verify subset).
- **One fetch-and-retry on stale (per §Failure modes L427):** if verification fails
  against a cached/stale cert, re-fetch the cert from any cohort member and retry exactly
  once; if still failing, treat the message as untrusted.

```ts
export interface MembershipVerifier {
	cache(cert: MembershipCertV1): void;
	verifyMessage(signers: PeerId[], expectedCoord: RingCoord, payload: Uint8Array,
		sig: Uint8Array): Promise<"verified" | "untrusted">;  // performs the single refetch+retry internally
}
```

### Resolved open question (GROUNDING): membership source

Document and implement the chosen path for how T0/T1 *committed* membership is obtained.
Per §Membership source (L321-327): T0/T1 cohort membership is anchored in the transaction
log (commit certificate), while T2/T3 derive membership from current FRET state and verify
against FRET's signed `MembershipCertV1` advertisements. **Chosen path:** the verifier
reads committed membership from the transaction log for T0/T1 coords (it never writes), and
uses FRET-published `MembershipCertV1` for T2/T3. Make this explicit in the doc and in the
verifier's coord→source dispatch.

### Bootstrapping trust

Initial trust roots (genesis-related cohorts) come from any dialed peer, validated against
the out-of-band genesis block hash; from there certs form a chain of attestations
(§Bootstrapping trust L340-342).

## Simulator note

No new simulator-tuned parameters here (`minSigs`/`T_membership_refresh` are structural),
but gossip convergence-within-one-round is a claim the mock-tier e2e suite later checks
against simulator-derived expectations.

## Constraints

ES modules, no inline `import()`, no `any`, tabs, cross-platform. Reuse FRET cohort
gossip + `minSigs` assembly; treat FRET read-only. Don't break existing tests.

## TODO

### Phase 1 — gossip
- Implement `CohortGossipBus` in `packages/db-core/src/cohort-topic/gossip/bus.ts` adapting FRET's cohort gossip; merge inbound records/willingness/load into the registration store and willingness/load state; epoch drift detection.

### Phase 2 — threshold sig
- Implement `CohortSigner` (`thresholdSign`/`verifyThreshold`) wrapping FRET `minSigs` assembly in `cohort-topic/sig/threshold.ts`.

### Phase 3 — membership certs
- Implement cohort-side `MembershipCertV1` publication (at stabilization, on first-`k−x` change, every `T_membership_refresh`).
- Implement participant-side `MembershipVerifier` with the single fetch-and-retry, and the T0/T1-log vs T2/T3-FRET membership-source dispatch.

### Phase 4 — tests + docs
- `packages/db-core/test/cohort-topic/gossip.spec.ts`: gossip converges within one round (a touch on one member is visible on all after one `applyInbound` cycle); epoch drift detected.
- `threshold.spec.ts`: threshold sig verifies with `x+1` (= `minSigs`) signers and fails below; verify fails when signers aren't a cert subset.
- `membership.spec.ts`: stale cert triggers exactly one refetch then succeeds; second failure → untrusted.
- Doc-sync `docs/cohort-topic.md`: in §Membership source, state the resolved path (T0/T1 read from tx-log; T2/T3 from FRET certs) as decided rather than open; confirm §Cohort gossip and §Membership snapshots match the implementation.

## Done when
- `yarn build` green for `db-core`.
- `yarn test` green for `db-core` including the new specs.
- `docs/cohort-topic.md` records the resolved membership-source decision and matches the implemented gossip/cert/threshold surfaces.
