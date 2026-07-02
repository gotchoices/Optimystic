description: A promotion/demotion notice doesn't say which cohort it was decided for, so a node that belongs to several cohorts for the same topic-and-tier can apply it to the wrong one — or silently drop a valid one. Add the cohort's coordinate to the notice (and cover it in the signature) and route the notice by that exact coordinate.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (PromotionNoticeV1 L146 / DemotionNoticeV1 L162 — add cohortCoord)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validatePromotionNoticeV1 L276 / validateDemotionNoticeV1 L292 — validate cohortCoord)
  - packages/db-core/src/cohort-topic/sig/payloads.ts (PromotionSignable/DemotionSignable + both signing images — cover cohortCoord)
  - packages/db-core/src/cohort-topic/promotion.ts (PromotionDeps L113 add cohortCoord dep; promote() L282 / demote() L327 stamp it on the notice + signable)
  - packages/db-p2p/src/cohort-topic/host.ts (createCoordEngine wires cohortCoord; handleInboundNotice L2047 + verifyAndApplyNotice L1987 resolve by carried coord; waterKey L2077; CoordRegistry.findServing L1192/L442 becomes unused)
  - packages/db-core/test/cohort-topic/wire.spec.ts, promotion.spec.ts
  - packages/db-p2p/test/cohort-topic/promote-notice.spec.ts (servingRegistry L272 → coord-keyed; new disambiguation test)
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts, threshold-assembly.spec.ts, cohort-topic-scale-lifecycle.spec.ts
  - docs/cohort-topic.md (§Promotion L620-647; §Wire formats notice field list)
difficulty: hard
----

# Cohort-topic: carry the served coord on promotion/demotion notices so a multi-cohort node routes them to the right engine

## Summary of the bug (confirmed by reading the code)

A `PromotionNoticeV1` / `DemotionNoticeV1` carries `topicId`, `fromTier`/`toTier` (or `tier` +
`parentCohortCoord`), `effectiveAt`, `cohortEpoch`, `signers`, `thresholdSig` — but **not the served
coord the decision was made for**. The threshold-signed image
(`promotionNoticeSigningPayload` / `demotionNoticeSigningPayload`, `sig/payloads.ts`) does not cover a
coord either.

The inbound `promote` handler therefore disambiguates the target engine by scanning:

```ts
// host.ts handleInboundNotice
const tier = inbound.kind === "promotion" ? inbound.notice.fromTier : inbound.notice.tier;
const target = registry.findServing(topicId, tier);   // FIRST engine matching (topic, tier)
```

and `createCoordRegistry().findServing` (host.ts L1192) returns the **first** engine whose
`treeTier === tier && servesTopic(topicId)`. `verifyAndApplyNotice` (host.ts L1987) then verifies the
notice's `signers` against **that** engine's cert (`verifier.verifyMessage(signers, target.servedCoord,
…)`, verifier.ts keys the cert lookup by `expectedCoord`).

A node's served coord is `coord_d(participantCoord, topicId)` — it varies with the registering
participant — so at `d ≥ 1` a single node can be a member of several sibling cohorts for the *same*
`(topic, tier)`, each with its own served coord, cert, and `PromotionLifecycle`. When that happens:

- `findServing` returns whichever engine iterates first, possibly the wrong cohort's engine.
- The signature is verified against the *wrong* cohort's cert. Overlapping-but-not-identical cohorts →
  `signers ⊄ cert.members` → `"untrusted"` → the notice is dropped and the **correct** engine never
  adopts the transition. Nothing re-delivers it.

### Second, same-root defect in the same handler: the shared high-water key

`handleInboundNotice` gates replays on a per-`(topic, tier)` high-water:

```ts
const waterKey = `${inbound.notice.topicId}|${tier}`;   // host.ts L2077 — coord-agnostic
```

Two cohorts serving the same `(topic, tier)` on one node **share** this entry. A notice applied for
cohort A advances the water; a legitimate cohort-B notice at an equal-or-lower `effectiveAt` is then
dropped as `"stale"` before it is ever verified. This is the identical multi-cohort assumption and is
fixed here alongside the routing (key the high-water by the served coord too).

## Why it is latent, not a live regression

Multi-tier / multi-cohort serving is not functional yet (`cohort-topic-followon-derivation`,
`cohort-topic-participant-coord-routing-key-mismatch`, and multi-tier promotion are all still open).
Every shipped test drives one cohort around a single coord, where `findServing` is exact and the shared
high-water key never collides. This is a **gate for multi-cohort promotion**, not a bug reachable today.
There are no deployed nodes speaking this protocol (pre-release milestone), so the wire/payload change
below can be a hard, coordinated change with no version negotiation.

## Chosen approach (the ticket's recommended "wire-field" option)

Carry the served coord on the notice, cover it in the signing payload, and resolve the local engine by
that exact coord instead of the first-match `(topic, tier)` scan. This binds the decision to its cohort
cryptographically and closes the related "a valid notice from cohort A replayed at a node also in cohort
B" concern: rewriting the coord breaks the signature outright, and looking the engine up by the *signed*
coord means a notice is verified against exactly the cohort that produced it.

Name the field **`cohortCoord`** to match `MembershipCertV1.cohortCoord` and the verifier's
`expectedCoord` (both are the same served-coord concept). 32 bytes, base64url.

The alternative "verify-then-apply against every candidate" option is rejected for the reasons the fix
ticket already gave: it re-runs verification up to N times and still cannot separate two cohorts whose
certs both accept the signers (overlapping membership). The signed coord is unambiguous.

### Producing side — the engine already knows its served coord

`createCoordEngine(ctx, servedCoord, treeTier, participantCoord)` (host.ts L1286) receives `servedCoord`
as a parameter and already passes it to `broadcastNotice(notice, servedCoord)`. `PromotionDeps`
(promotion.ts L113) just needs a `cohortCoord: () => Uint8Array` resolver (mirroring the existing
`cohortEpoch: () => Uint8Array` / `parentCoord: (topicId) => Uint8Array` deps), wired to `() => servedCoord`.
`promote()` / `demote()` then stamp `cohortCoord` onto both the `signable` and the returned notice.

### Receiving side — resolve by the signed coord

Replace the `findServing(topicId, tier)` scan with a lookup by the notice's carried coord:

```ts
const coord = b64urlToBytes(inbound.notice.cohortCoord);
const target = registry.findByCoord(coord);   // exact; already exists on CoordRegistry
```

`findByCoord` (host.ts L1181) is a pure lookup (never lazily creates), which is correct here — a node
that does not serve that coord has no business adopting the notice; it is `dropped`. `verifyAndApplyNotice`
keeps verifying against `target.servedCoord`, which is now provably the notice's coord (we looked it up by
it). `findServing` becomes unused; remove it from the `CoordRegistry` interface (L442) and the
implementation (L1192) so the first-match trap cannot be reintroduced.

Key the replay high-water by the coord as well: `waterKey = \`${inbound.notice.cohortCoord}|${tier}\``
(coord already uniquely identifies the cohort; `tier` is kept only for readability). The `PROMOTE_HIGHWATER_MAX_KEYS`
LRU bound is unchanged.

### Demotion-to-parent broadcast is intentionally out of scope

`broadcastNotice` also fans a demotion to the **parent** coord for `childCohortCount` bookkeeping
(`noticeBroadcastCoords`, host.ts L2099). With coord-keyed routing, a demotion arriving at a parent-only
node carries the *child's* `cohortCoord`, which the parent does not serve → `findByCoord` → `undefined`
→ `dropped`. That matches today's de-facto behavior: `childCohortCount` is `0` in this milestone and the
parent-side decrement is not wired through `applyDemotionNotice` anyway (the current `findServing(topicId,
childTier)` also fails to match a parent engine whose `treeTier` is `childTier − 1`). A node that is a
member of *both* the parent and child cohorts still serves the child coord and adopts correctly (it is
acting as a child sibling). Wiring the real parent `childCohortCount` decrement is follow-on work owned by
`cohort-topic-followon-derivation`; do **not** expand scope to it here — just leave a `NOTE:` at the
`noticeBroadcastCoords` call site recording that the parent-coord broadcast is currently a no-op apply for
a parent-only node and why.

## Coordinate with the sibling `d ≥ 1` tickets

`cohort-topic-participant-coord-routing-key-mismatch` and `cohort-topic-followon-derivation` are the other
open `d ≥ 1` multi-tier gates. The `cohortCoord` added here is `coord_d(participantCoord, topicId)` — the
same `addressing.coord(...)` the register dispatch computes (host.ts L877). Keep the derivation identical;
if those tickets change how `coord_d` is computed or how participant coords route, reconcile this field
with them (it must always equal the coord the producing engine was instantiated at).

## Acceptance

- A node serving `(topic, tier)` under two distinct coords adopts a promotion/demotion into the **correct**
  engine, with the other engine's state unchanged. New db-p2p test: stand up two `NoticeApplyTarget`s (via
  a coord-keyed `CoordRegistry` stub) for the same `(topic, tier)` under distinct coords; a notice carrying
  coord A lands on target A and leaves target B unchanged.
- A notice decided for cohort A is neither mis-applied to nor able to falsely stale-drop a node's cohort-B
  engine: with both engines present, A's notice at `effectiveAt = t` does not advance/consult B's high-water,
  and a subsequent B notice at `effectiveAt ≤ t` still verifies+applies.
- Rewriting `cohortCoord` on a validly-signed notice makes it fail verification (the coord is covered by the
  signature) — add an assertion in `promote-notice.spec.ts`.
- `docs/cohort-topic.md` §Promotion reflects that the receiver disambiguates the target cohort by the signed
  coord (pipeline becomes `decode → rate limit → resolve engine by carried cohortCoord → high-water → verify+apply`),
  and §Wire formats lists the new `cohortCoord` field on both notices.

## TODO

### Phase 1 — db-core wire + signature
- Add `cohortCoord: string` (32-byte base64url; doc-comment: the served coord `coord_d(participantCoord, topicId)`
  the cohort sits at, keyed to the cert the signature verifies against) to `PromotionNoticeV1` and
  `DemotionNoticeV1` in `wire/types.ts`.
- Add `cohortCoord` to `PromotionSignable` / `DemotionSignable` and append it to both JSON-array images in
  `sig/payloads.ts`. This changes the canonical signed bytes — a hard, coordinated change (acceptable
  pre-release; note it in the doc-comment there).
- Validate `cohortCoord` via `b64urlField(reqString(...))` in `validatePromotionNoticeV1` /
  `validateDemotionNoticeV1` (`wire/validate.ts`).

### Phase 2 — db-core promotion lifecycle
- Add `cohortCoord: () => Uint8Array` to `PromotionDeps` (`promotion.ts`).
- In `promote()` and `demote()`, compute `const cohortB64 = bytesToB64url(this.deps.cohortCoord());`, add it
  to the `signable` object (so it is signed) and to the returned notice object.

### Phase 3 — db-p2p host wiring + inbound routing
- In `createCoordEngine`, pass `cohortCoord: () => servedCoord` into `createPromotionLifecycle` deps.
- In `handleInboundNotice` / `verifyAndApplyNotice`: resolve `target` via `registry.findByCoord(b64urlToBytes(
  inbound.notice.cohortCoord))` instead of `registry.findServing(topicId, tier)`; key the high-water by
  `\`${inbound.notice.cohortCoord}|${tier}\``.
- Remove `findServing` from the `CoordRegistry` interface (L442) and `createCoordRegistry` (L1192) once no
  caller remains; update the interface doc-comment.
- Add the `NOTE:` at the `noticeBroadcastCoords` call site (parent-coord demotion broadcast is a no-op apply
  for a parent-only node in this milestone — see the scope section above).

### Phase 4 — tests
- db-core `wire.spec.ts`: notice roundtrips include `cohortCoord`.
- db-core `promotion.spec.ts`: supply the new `cohortCoord` dep; assert both notices carry it and that the
  signing payload covers it.
- db-p2p `promote-notice.spec.ts`: build notices with `cohortCoord`; replace the `servingRegistry` (findServing)
  stub (L272) with a coord-keyed registry (`findByCoord`); add the **two-cohort disambiguation** test and the
  **coord-tamper rejection** test; adjust the existing "no serving engine → dropped" test to a coord miss.
- db-p2p `live-tier.spec.ts`, `threshold-assembly.spec.ts`, `cohort-topic-scale-lifecycle.spec.ts`: update any
  notice construction / payload assertions for the new field.

### Phase 5 — docs
- Update `docs/cohort-topic.md` §Promotion (L620-647) pipeline wording and add a sentence on coord-based
  disambiguation; add `cohortCoord` to the §Wire formats notice field lists.

### Validate
- From repo root, build + test the two packages, streaming output:
  `yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/dbcore.log` and
  `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/dbp2p.log` (confirm the exact test scripts in each
  package's `package.json` / AGENTS.md first). Run the type-check/build for both packages too, since this
  touches shared wire types re-exported across the boundary.
