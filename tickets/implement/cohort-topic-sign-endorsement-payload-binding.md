description: When a node is asked to co-sign a cohort membership certificate, it currently signs whatever bytes it is handed without checking them, so one cohort insider can collect honest signatures over a certificate the cohort never actually agreed to. Make the signer re-derive what it is willing to attest from its own view and refuse anything that does not match.
prereq: cohort-topic-membership-cert-trust-anchoring
files:
  - packages/db-p2p/src/cohort-topic/host.ts (handleSignRequest + SignEndorsementDeps; signEndorse wiring around L688-698)
  - packages/db-core/src/cohort-topic/sig/payloads.ts (canonical signable array images the endorser re-derives)
  - packages/db-core/src/cohort-topic/membership/publisher.ts (membershipCertSignable — the exact image to match)
  - packages/db-core/src/cohort-topic/wire/types.ts (SignRequestV1 / SignKind — unchanged this ticket)
  - packages/db-p2p/test/cohort-topic/threshold-assembly.spec.ts (/sign endorsement policy tests — extend)
difficulty: hard
----

# Bind `/sign` endorsements to a payload the endorser independently re-derives

## Problem (confirmed by trace)

`handleSignRequest` (`packages/db-p2p/src/cohort-topic/host.ts:1568`) is the `/sign` endorsement policy.
For every non-`rotation` kind it runs exactly one gate and then signs:

```
members = cohortMembersAround(coord)
if self ∉ members            → refuse
if requester ∉ members       → refuse
if request.cohortEpoch != currentEpoch(coord)   → refuse   // the SEPARATE wire field, not the payload bytes
signature = signPeer(privateKey, request.payload)          // signs OPAQUE bytes, never inspected
```

The endorser never looks **inside** `request.payload`. The canonical signing image for a membership cert
is (`sig/payloads.ts:21`):

```
["MembershipCertV1", cohortCoord, cohortEpoch, members(sorted asc, b64url), stabilizedAt]
```

Because the requester supplies these bytes verbatim, a single cohort insider can:

- **Falsify `members`** inside the payload (any superset still containing the real signers passes the
  verifier's `signers ⊆ cert.members` check) while putting the *honest* epoch in the separate
  `request.cohortEpoch` wire field, collect `k − x` honest endorsements, and publish a cert the cohort
  never agreed to. The wire-field epoch gate does **not** bind the `cohortEpoch` *inside* the payload, nor
  the `members`/`stabilizedAt` inside it.
- **Falsify `stabilizedAt`** (e.g. far-future) so a stale cert masquerades as fresh to locked-cert
  staleness logic.
- **Kind-mismatch** the bytes: a `kind: "membership"` request can carry a `PromotionNoticeV1` /
  `DemotionNoticeV1` image (or vice versa); the threshold blob is kind-agnostic, so the assembled
  signature verifies for whatever the bytes decode to.

This was a **documented deviation** of `cohort-topic-threshold-assembly` (see the JSDoc at
`host.ts:1555-1559`: "the cohort + epoch gate IS the full policy" for `membership`). This ticket closes it.

Crucially, in this host the epoch is a hash of the member set
(`host.ts:556-563`: `cohortEpoch = H(sorted members joined)`), so **same epoch ⟹ same member set**. The
fix exploits this: by binding the *payload-internal* `cohortEpoch` and `members` to the endorser's own
re-derived view, a falsified member list can no longer ride an honest epoch.

## Reproduction (write this first — it is currently GREEN, i.e. the bug)

Add to `packages/db-p2p/test/cohort-topic/threshold-assembly.spec.ts`, `describe('/sign endorsement policy')`:

```ts
it('refuses a membership payload whose members do not match the endorser view (falsified cert)', async () => {
  const [self, requester, ...rest] = await makeMembers(5);
  const realMembers = [self!, requester!].map(m => m.bytes);
  // Endorser's honest view: cohort = {self, requester}, epoch = H(that set).
  const honestEpoch = epochOf(realMembers);                 // mirror host.cohortAround epoch derivation
  const exp = membershipCertSignable({ coord: COORD, cohortEpoch: honestEpoch, members: realMembers, stabilizedAt: 1_000 });

  // Attacker payload: SAME honest epoch field, but an INFLATED members list (adds `rest`).
  const forged = membershipCertSignable({
    coord: COORD, cohortEpoch: honestEpoch,
    members: [self!, requester!, ...rest].map(m => m.bytes), stabilizedAt: 1_000,
  });
  const req: SignRequestV1 = {
    v: 1, kind: 'membership', coord: bytesToB64url(COORD),
    cohortEpoch: bytesToB64url(honestEpoch),                 // honest wire epoch — passes the OLD gate
    payload: bytesToB64url(membershipCertSigningPayload(forged)),
  };
  const reply = await handleSignRequest(req, requester!.idStr, depsFor(self!, [self!, requester!], honestEpoch, exp));
  expect('refused' in reply, 'falsified-members payload must be refused').to.equal(true);  // FAILS today (signs it)
});
```

(`epochOf` / `depsFor` are small helpers the implementer adds; `depsFor` wires the new
`expectedMembershipFields` dep below to `exp`.)

## Fix — re-derive-and-match, all in `handleSignRequest`

The endorser already holds everything it needs: `currentEpoch(coord)` and the cohort member set (today as
peer-id strings via `cohortMembersAround`; the cert image needs the member **bytes** sorted ascending +
b64url, i.e. the `membershipCertSignable` order). Thread the endorser's own canonical fields in as a dep
and compare field-by-field; only sign on a full match.

### `SignEndorsementDeps` (host.ts:1530) — add

```ts
/**
 * The endorser's own canonical MembershipCertV1 signable fields for `coord` at its CURRENT epoch,
 * re-derived from its own cohort snapshot (membershipCertSignable with stabilizedAt omitted/ignored).
 * Used to bind a `membership` endorsement to the endorser's independent view. `cohortEpoch` here MUST
 * equal bytesToB64url(currentEpoch(coord)); `members` is the ascending-sorted b64url cohort set.
 */
readonly expectedMembershipFields: (coord: RingCoord) => { cohortCoord: string; cohortEpoch: string; members: string[] };
/** Wall clock (ms) for the stabilizedAt sanity bound. Host wires Date.now; tests inject a fixed clock. */
readonly now?: () => number;
```

### Host wiring (host.ts:688-698, the `signEndorse` closure)

`cohortAround(coord)` is already in scope; re-derive via the db-core helper (already imported,
`host.ts:92-93`):

```ts
expectedMembershipFields: (coord) => {
  const snap = cohortAround(coord);
  const { cohortCoord, cohortEpoch, members } = membershipCertSignable({
    coord, cohortEpoch: snap.cohortEpoch, members: snap.members, stabilizedAt: 0,
  });
  return { cohortCoord, cohortEpoch, members };
},
now: () => Date.now(),
```

### `handleSignRequest` body

Add a small payload-image decoder (the payload is `utf8(JSON.stringify(array))`, **not** a
`CohortMessageV1` — decode with `JSON.parse`, not `decodeCohortMessage`):

```ts
function decodeSignableImage(payloadB64: string): unknown[] | undefined {
  try { const a = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64))); return Array.isArray(a) ? a : undefined; }
  catch { return undefined; }
}
```

Then, in the non-rotation path, **after** the existing cohort + wire-epoch gate, before signing:

- Decode the image; refuse if undecodable.
- **All kinds** — bind the kind and the payload-internal epoch:
  - tag (`image[0]`) must match the kind: `membership`→`"MembershipCertV1"`,
    `promotion`→`"PromotionNoticeV1"`, `demotion`→`"DemotionNoticeV1"`. Refuse on mismatch (closes the
    kind-mismatch hole).
  - the image's embedded `cohortEpoch` (last array element for all three images) must equal
    `bytesToB64url(currentEpoch(coord))`. Refuse on mismatch (closes the falsified-internal-epoch hole
    cheaply, for promotion/demotion too).
- **`membership` additionally** — bind coord, members, stabilizedAt to the endorser's own view:
  - `image[1]` (cohortCoord) === `expectedMembershipFields(coord).cohortCoord` (== `request.coord`).
  - `image[3]` (members) deep-equals `expectedMembershipFields(coord).members` (same length, same order —
    both are ascending-sorted b64url). Refuse on mismatch. **This is the core fix.**
  - `image[4]` (stabilizedAt) is a finite number and not far-future: `stabilizedAt <= now() + SKEW`
    (reuse a ~5 s skew). A lower bound is not security-critical; keep it loose or omit.

Only after all checks pass, `signPeer(privateKey, request.payload)` as today.

Because epoch = H(members) in this host, the members + internal-epoch checks are mutually reinforcing: a
forged member list cannot produce the honest epoch, and an honest epoch cannot ride a forged member list.
No churn tolerance is needed for the **current-epoch** case (same epoch ⟹ identical member set by
construction); the one-rotation-stale tolerance the original ticket mused about only matters if stale
epochs were accepted, which assembly does not — leave it out and note it.

### `rotation` path (host.ts:1575-1591) — minimal hardening only

The rotation branch carries the **successor** cert image and is gated on *prior*-epoch membership (its own
design, `cohort-topic-trust-anchor-rotation-production`). Do **not** disturb that gate. Add only a
structural sanity check: decode the payload and refuse unless it is a `"MembershipCertV1"` image. Full
successor-cert re-derivation for rotation is out of scope (the endorser is the *outgoing* cohort and may
not know the successor member set) — note it as a follow-on, do not attempt it here.

## Out of scope (split out — see backlog ticket)

The promotion/demotion **hot/cold refinement** (the endorser additionally requiring its own replicated
`directParticipants(topicId)` to be hot/cold) is genuinely blocked: it needs a `topicId` (+ per-topic
context) on `SignRequestV1` — the current `(payload, minSigs)` `ICohortThresholdCrypto` port cannot carry
it — **and** gossip record replication of `directParticipants` (still interim — `renewal.gossip.touch` is a
no-op). Parked in `cohort-topic-sign-endorsement-hotcold-refinement` (backlog). This ticket delivers the
membership binding + the cheap all-kinds kind/epoch decode gate, which is the milestone deliverable.

## Test impact

- The existing `describe('/sign endorsement policy')` happy-path test (`threshold-assembly.spec.ts:247`)
  uses an **arbitrary** `PAYLOAD` for a `membership` request; after this change it will be refused. Update
  it to build a real `membershipCertSigningPayload(membershipCertSignable(...))` matching the injected
  `expectedMembershipFields`, and keep the verifiable-signature assertion.
- The threshold-assembly end-to-end test (`threshold-assembly.spec.ts:207`/`~380`) drives the real
  `dialSign` → `handleSignRequest` path via `assemblerFor`/`honestDialSign`; confirm those helpers (or the
  host's `signEndorse` wiring) now supply `expectedMembershipFields` so the real assembly still collects a
  quorum. The publisher signs the *real* `membershipCertSignable(snapshot)`, so an honest assembly matches
  by construction — the e2e cert-verifies test should stay green once the helper wires the new dep.

## TODO

- [ ] Add the reproducing test (falsified-members membership payload) — confirm it FAILS (signs) on HEAD.
- [ ] Add `expectedMembershipFields` + `now?` to `SignEndorsementDeps`; wire both in the host `signEndorse`
      closure via `cohortAround` + `membershipCertSignable` + `Date.now`.
- [ ] Add the `decodeSignableImage` helper (JSON-array decode of the payload bytes).
- [ ] In `handleSignRequest` non-rotation path: decode; bind tag↔kind and embedded `cohortEpoch` for all
      kinds; for `membership` additionally bind `cohortCoord`, `members` (deep-equal endorser view), and
      `stabilizedAt` (finite, not far-future). Sign only on full match.
- [ ] In the `rotation` path: add the structural `"MembershipCertV1"` tag sanity check; leave the
      prior-epoch gate untouched.
- [ ] Update the existing happy-path `/sign` membership test to use a real cert image + add helpers
      (`epochOf`, `depsFor`). Add explicit refusal tests: kind-mismatch (promotion bytes under
      `kind: membership`), internal-epoch mismatch, falsified `stabilizedAt` (far-future), undecodable
      payload.
- [ ] Keep the rotation-gate tests (`threshold-assembly.spec.ts:283+`) green; add a rotation test that a
      non-`MembershipCertV1` payload is refused.
- [ ] Update the JSDoc on `handleSignRequest` (host.ts:1548-1566) to state the membership binding is now
      enforced (drop the "cohort + epoch gate IS the full policy" deviation note) and reference the backlog
      hot/cold follow-on.
- [ ] Build + run: `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log` (stream it);
      also `yarn workspace @optimystic/db-core build` if payloads/types touched. Type-check both packages.
