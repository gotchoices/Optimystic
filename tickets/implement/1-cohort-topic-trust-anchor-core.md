description: A membership certificate is currently trusted just for being internally consistent, so a forged one signed by the wrong keys still passes — add the rule that a certificate must trace back to a known-good trust root before it is believed.
prereq:
files:
  - packages/db-core/src/cohort-topic/membership/verifier.ts
  - packages/db-core/src/cohort-topic/ports.ts
  - packages/db-core/src/cohort-topic/sig/threshold.ts
  - packages/db-core/src/cohort-topic/sig/payloads.ts
  - packages/db-core/src/cohort-topic/wire/types.ts
  - packages/db-core/src/cohort-topic/wire/validate.ts
  - packages/db-core/src/cohort-topic/wire/codec.ts
  - packages/db-core/src/cohort-topic/membership/publisher.ts
  - packages/db-core/src/cohort-topic/index.ts
  - docs/cohort-topic.md (§Bootstrapping trust)
difficulty: hard
----

# Trust-anchor framework for MembershipCertV1 (db-core)

## Problem

`CachingMembershipVerifier.loadFrom` (`membership/verifier.ts`) accepts a refetched
`MembershipCertV1` purely on **self-consistency** (`certIsSelfConsistent`: its own threshold signature
is a `≥ minSigs` quorum over its own `members`). Self-consistency proves internal well-formedness, not
that the attesting key set is the legitimate cohort for `cohortCoord`. An adversary controlling any
`k − x` keys can mint a self-consistent cert over a coord they do not own — it then passes
`verifyMessage` for any message its keys sign. There is no binding from the cert's key set back to a
network-rooted trust anchor (`docs/cohort-topic.md` §Bootstrapping trust, currently a one-paragraph
sketch and unimplemented).

This ticket builds the **db-core half** of the fix: a trust-anchor gate and a chain-of-attestations
mechanism, with the tier/transport-specific *direct* anchor abstracted behind an injected port (FRET /
tx-log bindings land in the prereq-chained db-p2p tickets). db-core never imports FRET; it owns the
chain logic, the trust-root set, and the wire format.

## Design

### Anchoring model (resolved)

Three ways a cert's `(cohortCoord → members)` binding earns trust. The verifier accepts a cert iff it
is **self-consistent AND anchored by at least one** of:

1. **Trust root** — `(cohortCoord, cohortEpoch)` is in the out-of-band-seeded trust-root set (the
   genesis-block-related cohorts, validated against the genesis block hash by the caller before
   seeding). Base case of every chain.

2. **Direct anchor** — an injected `IMembershipTrustAnchor` judges, from a source the node *directly*
   trusts, whether `members` is the authoritative cohort for `cohortCoord` at `tier`. Three-valued:
   - `"anchored"` → vouched (e.g. matches FRET `assembleCohort(coord)`, or the tx-log commit cert);
   - `"rejected"` → contradicted (a known-different keyset owns the coord) → **forgery, fatal even if
     self-consistent**;
   - `"unknown"` → this node has no local authority for the coord → fall through.

3. **Attestation chain (epoch rotation)** — a cert may carry a *rotation attestation*: the predecessor
   cohort's threshold signature over **this** cert's signing payload. If the verifier already holds a
   **trusted** cert for the same `cohortCoord` whose `cohortEpoch === cert.prevEpoch`, and that
   predecessor's members form a `≥ minSigs` quorum over the successor payload via `rotationSig`, the
   successor inherits trust. This is what distinguishes a legitimate epoch rotation (key set changed,
   prior cohort signed off) from a forgery (no valid predecessor signature).

If none apply, the cert falls to the **interim TOFU fallback** (accept self-consistent), which
preserves today's behavior on coords the node cannot anchor — see *Interim fallback & rollout* below.
A `"rejected"` direct-anchor verdict **always** overrides the fallback.

> **Why no monotonic-epoch / rollback gate.** `cohortEpoch = H(sorted members)` (db-p2p
> `host.ts:520-526`) is content-derived, not an ordered counter, so epochs are unorderable hash ids.
> Replaying an *older legitimately-signed* cert is therefore a **freshness** concern (stale membership),
> already covered by `stabilizedAt` + the existing one-refetch tolerance — not a trust-gate concern. The
> chain is a hash-linked attestation DAG (`prevEpoch` is a hash pointer), not a height-ordered ledger.

### New port — `IMembershipTrustAnchor` (`ports.ts`)

```ts
/** Verdict on whether a cert's coord→keyset binding is vouched by a directly-trusted source. */
export type TrustAnchorVerdict = "anchored" | "rejected" | "unknown";

/**
 * Direct (base-case) trust anchor for a MembershipCertV1's coord→keyset binding. db-core owns the
 * chain-of-attestations and trust-root logic; the *direct* anchor is tier/transport-specific (FRET ring
 * agreement for T2/T3, tx-log commit certificate for T0/T1) and is therefore delegated. db-p2p binds it;
 * db-core never imports FRET. A node with no local authority for the coord returns "unknown" so the
 * verifier falls through to the chain / interim fallback instead of breaking.
 */
export interface IMembershipTrustAnchor {
  directAnchor(cert: MembershipCertV1, tier: number): TrustAnchorVerdict;
}
```

A default no-authority anchor (`() => "unknown"` for every coord) ships in db-core so existing callers
that inject nothing keep working (see fallback below).

### Wire-format extension — rotation attestation (`wire/types.ts`, `validate.ts`, `codec.ts`)

Add three **optional, backward-compatible** fields to `MembershipCertV1` (decoding a cert without them
must still succeed — existing certs and the publisher's non-rotation path emit none):

```ts
  /** Predecessor cohort epoch this cert rotates from (32 bytes, base64url). Present only on a rotation. */
  prevEpoch?: string;
  /** Predecessor cohort's threshold signature over THIS cert's membershipCertSigningPayload, base64url. */
  rotationSig?: string;
  /** Predecessor cohort signers (PeerIds, base64url) that produced rotationSig; `>= minSigs`. */
  rotationSigners?: string[];
```

`validateMembershipCertV1` validates them as a group: either **all three present** (and well-formed
base64url / string-array) or **all absent**; a partial set is a `CohortWireError`. The rotation
attestation is **not** part of `membershipCertSigningPayload` (it signs *over* that payload, so it
cannot be self-referential) — `sig/payloads.ts` stays unchanged; the signed image remains
`["MembershipCertV1", cohortCoord, cohortEpoch, members, stabilizedAt]`.

### Verifier integration (`membership/verifier.ts`)

- Constructor gains `anchor?: IMembershipTrustAnchor` and `trustRoots?: readonly TrustRoot[]`
  (`TrustRoot = { coord: Uint8Array; epoch: Uint8Array; members: readonly Uint8Array[] }`), plus the
  existing `signer`/`router`/`minSigs`. Default `anchor` = the no-authority anchor; default
  `trustRoots` = `[]`.
- Replace the bare `certIsSelfConsistent` gate in `loadFrom` with `certIsTrusted(cert, tier)`:
  1. `certIsSelfConsistent(cert)` — unchanged precondition; fail → reject.
  2. trust-root match (`coord`+`epoch` present, `members` set-equal) → trusted.
  3. `anchor.directAnchor(cert, tier)`: `"anchored"` → trusted; `"rejected"` → **reject (fatal)**;
     `"unknown"` → continue.
  4. chain: if `cert.prevEpoch`/`rotationSig`/`rotationSigners` present and a **trusted** predecessor is
     cached for `cohortCoord` with `cohortEpoch === cert.prevEpoch`, verify
     `signer.verifyThreshold(membershipCertSigningPayload(cert), rotationSig, rotationSigners, predecessor, minSigs)`
     → trusted on success.
  5. interim TOFU fallback (see below).
- `tier` must reach `loadFrom`/`certIsTrusted` — thread it from `verifyMessage` (it already has `tier`).
  Both `source.current(...)` and `source.fetch(...)` loads must run through the same gate with the same
  tier.
- **Trusted-cache invariant.** Only certs that passed `certIsTrusted` may serve as chain predecessors.
  Track a per-coord *trusted* epoch alongside the cached cert (e.g. cache stores `{ cert, trusted: true }`
  or a parallel `Set` of trusted `coord|epoch`). The public `cache(cert)` (the host feeding its **own**
  freshly published cert) marks it trusted — a node trusts a cert it itself published. A cert that only
  reached the cache via a non-trusted path must never anchor a successor.

### Interim fallback & rollout (resolved — do not break the live network)

`directAnchor` returns `"unknown"` for any coord the node lacks local authority over. For those coords
(e.g. a distant reactivity subscriber verifying a tail cohort it is nowhere near) there is **no**
sound, network-verifiable base anchor available today — FRET emits no transferable stabilization proof
(p2p-fret 0.5.0 has no membership-cert/attestation API; `assembleCohort` needs the *local* routing
table), and the T0/T1 committed index does not exist yet. Rejecting those certs would break legitimate
verification, so the verifier falls back to **TOFU on self-consistency** there — identical to today's
behavior, i.e. strictly no regression. The security win is:

- **FRET-covered coords** (the host / `promote`-handler path, which verifies against `servedCoord`):
  the db-p2p binding returns `"anchored"`/`"rejected"`, so a forged cert from an unrelated keyset is
  **rejected** — this closes the amplification-exposed attack the source ticket names.
- **Epoch rotations**: protected by the attestation chain once any cert for the coord is trusted.
- **Distant first-sight T2/T3** and **T0/T1**: remain TOFU, tracked forward in
  `cohort-topic-trust-anchor-fret-stabilization-proof` (backlog) and
  `cohort-topic-trust-anchor-txlog-committed-binding` (backlog).

Do **not** add a hard `requireAnchor` reject-on-unknown mode in this ticket: the three-valued verdict
already gives FRET-covered nodes their teeth (`"rejected"`) without a global flag that would break
distant verifiers. Document the limit in the verifier header and `docs/cohort-topic.md` §Bootstrapping
trust.

### Freshness composition (unchanged)

The trust gate is an **additional** filter inside `loadFrom`; the one-refetch-and-retry, the
`RefetchBound` rate limit, and stale-cert tolerance in `verifyMessage` are untouched. A cert that fails
the trust gate is treated exactly like a malformed/absent cert (return `undefined`), so the existing
single refetch still fires.

## Edge cases & interactions

- **Partial rotation fields** — any one or two of `prevEpoch`/`rotationSig`/`rotationSigners` present
  without the others → `CohortWireError` (treated as no cert by `loadFrom`'s try/catch). All-absent and
  all-present are the only valid shapes.
- **`"rejected"` overrides TOFU** — a self-consistent cert whose direct anchor says `"rejected"` is
  rejected; the fallback must not resurrect it. (Test this explicitly.)
- **Chain predecessor missing / not trusted** — successor with a valid `rotationSig` but no cached
  *trusted* predecessor at `prevEpoch` → chain step fails, falls to direct anchor / TOFU. A predecessor
  present in cache but **not** trusted (arrived via TOFU then was overwritten, or never trusted) must
  **not** anchor the successor.
- **prevEpoch == own epoch / self-referential** — `prevEpoch === cohortEpoch` is nonsense; reject the
  chain step (a cert cannot rotate from itself).
- **Skipped epoch** — cached epoch N, successor declares `prevEpoch = N+1` (an epoch the node never
  saw) → chain breaks; fall through. Document as acceptable (the node re-anchors directly or TOFUs).
- **rotationSig quorum mismatch** — `rotationSigners` not a `≥ minSigs` distinct subset of the
  *predecessor's* members, or signature invalid → chain step fails (reuse `verifyThreshold`, which
  already enforces distinct ⊆ members ≥ minSigs).
- **Forged rotation** — adversary cert with `prevEpoch` = a real trusted epoch but `rotationSig` signed
  by its own (non-predecessor) keys → `verifyThreshold` against the predecessor's members fails → not
  trusted. (Core security test.)
- **Trust-root member-set match** — compare as sets (order-independent), and require `epoch` equality
  too, so a cert reusing a genesis coord with a swapped keyset is not a trust root.
- **Backward compat** — every existing `MembershipCertV1` (no rotation fields) still decodes, and every
  existing verifier caller (no `anchor`/`trustRoots`) still constructs and behaves as today (TOFU).
- **Publisher round-trip** — a non-rotation publish must emit no rotation fields; `decode(encode(cert))`
  round-trips with and without them (codec symmetry, including the all-or-nothing validation).
- **Tier threading** — `directAnchor` receives the same `tier` the router used; a coord verified at the
  wrong tier must not accidentally anchor (the binding is tier-scoped).

## Key tests (db-core, `membership/verifier.spec.ts` + `wire/*.spec.ts`)

- forged unrelated-keyset cert + mock anchor `"rejected"` → `verifyMessage` returns `"untrusted"`
  (the headline security property).
- legit cert + mock anchor `"anchored"` → `"verified"`.
- unknown-coord cert + mock anchor `"unknown"`, self-consistent → `"verified"` (TOFU preserved, no
  regression).
- `"rejected"` beats TOFU: self-consistent + `"unknown"`... vs self-consistent + `"rejected"`.
- legit epoch rotation: trust predecessor (root/anchor), then successor with valid `rotationSig` over
  successor payload signed by predecessor members → `"verified"` with anchor returning `"unknown"`.
- forged rotation: successor `rotationSig` signed by wrong keys → `"untrusted"`.
- chain requires *trusted* predecessor: predecessor only TOFU-cached (not trusted) → successor chain
  step rejected.
- trust-root match by (coord, epoch, member-set); swapped keyset on a genesis coord → not a root.
- wire: all-or-nothing rotation-field validation; codec round-trip with/without rotation fields;
  legacy cert (no fields) decodes.
- regression: every existing verifier/publisher spec still green with default (no anchor) construction.

## TODO

- Add `TrustAnchorVerdict` + `IMembershipTrustAnchor` + `TrustRoot` to `ports.ts`; export from
  `cohort-topic/index.ts`. Ship a `noAuthorityTrustAnchor` default (`() => "unknown"`).
- Extend `MembershipCertV1` with optional `prevEpoch`/`rotationSig`/`rotationSigners` in `wire/types.ts`.
- Extend `validateMembershipCertV1` with all-or-nothing rotation-field validation; confirm
  `decodeMembershipCertV1`/`encodeCohortMessage` round-trip the new fields.
- Add `anchor`/`trustRoots` to `MembershipVerifierDeps`; implement `certIsTrusted(cert, tier)` and the
  trusted-cache invariant; thread `tier` into `loadFrom`. Keep `RefetchBound`/freshness logic intact.
- Let the publisher optionally attach a rotation attestation when given one (a `rotation?` arg on
  `publish`/`onStabilized` carrying `{ prevEpoch, rotationSig, rotationSigners }`); default path emits
  none. (Production of that attestation is the db-p2p ticket `cohort-topic-trust-anchor-rotation-production`.)
- Tests above; `yarn build` + `yarn test` green for db-core.
- Update `membership/verifier.ts` header and `docs/cohort-topic.md` §Bootstrapping trust to describe the
  implemented model and the documented interim TOFU limits.
