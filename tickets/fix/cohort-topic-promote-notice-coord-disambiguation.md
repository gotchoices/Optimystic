description: A `PromotionNoticeV1`/`DemotionNoticeV1` carries `(topicId, tier)` but **not** the served coord it was decided for, so the inbound `promote` handler disambiguates the target engine with `registry.findServing(topicId, tier)`, which returns the *first* engine serving that `(topic, tier)`. When a node serves the same `(topic, tier)` under more than one cohort/coord (multi-cohort topology), the notice can be applied to — or verified against — the wrong engine and silently dropped as untrusted. Latent today (single-cohort milestone); a gate for multi-cohort promotion.
prereq:
files:
  - packages/db-p2p/src/cohort-topic/host.ts (findServing at L509; promote handler at L935; verifyAndApplyNotice at L811 verifies signers against target.servedCoord)
  - packages/db-core/src/cohort-topic/wire/types.ts (PromotionNoticeV1 L113 / DemotionNoticeV1 L129 — no served-coord field)
  - packages/db-core/src/cohort-topic/sig/payloads.ts (promotion/demotion signing payloads — coord is not covered by the signature either)
  - packages/db-core/src/cohort-topic/membership/verifier.ts (verifyMessage keys the cert lookup by expectedCoord = target.servedCoord)
difficulty: hard
----

# Cohort-topic: the inbound promote handler cannot disambiguate which cohort a notice belongs to

## The gap

`gap 4` (promote verify-and-apply) routes an inbound notice to a local engine via:

```ts
const tier = inbound.kind === "promotion" ? inbound.notice.fromTier : inbound.notice.tier;
const target = registry.findServing(b64urlToBytes(inbound.notice.topicId), tier);
```

and `findServing` returns the **first** engine matching `treeTier === tier && servesTopic(topicId)`:

```ts
findServing(topicId, treeTier) {
  for (const engine of engines.values())
    if (engine.treeTier === treeTier && engine.servesTopic(topicId)) return engine;
  return undefined;
}
```

A `PromotionNoticeV1` / `DemotionNoticeV1` carries `topicId`, `fromTier`/`toTier` (or `tier` +
`parentCohortCoord`), `effectiveAt`, `cohortEpoch`, `signers`, `thresholdSig` — but **not the served
coord** the promotion decision was made for. The threshold-signed payload
(`promotionNoticeSigningPayload` / `demotionNoticeSigningPayload`) likewise does **not** cover a coord.

In the current single-cohort-per-topic milestone a node serves a given `(topic, tier)` under at most
one coord, so `findServing` is unambiguous and verification (`verifier.verifyMessage(signers,
target.servedCoord, …)`) checks the signers against the right cert. **But** the served coord is
`coord_d(participantCoord, topicId)` — it varies with the registering participant — so at `d ≥ 1` a
single node can be a member of several sibling cohorts for the *same* `(topic, tier)`, each with its
own served coord, cert, and `PromotionLifecycle`. When that happens:

- `findServing` returns whichever engine is first in the map, which may be the wrong cohort's engine.
- `verifyAndApplyNotice` then verifies the notice's signers against the *wrong* cohort's cert
  (`target.servedCoord`). The cohorts overlap but are not identical, so `signers ⊄ cert.members` →
  `"untrusted"` → the notice is dropped and **the correct engine never adopts the transition**.
- Nothing re-delivers the notice to the right engine; the node's view of that cohort's promoted state
  diverges until the next independent re-trigger.

## Why it's latent, not active

Multi-tier / multi-cohort serving is not functional yet (`cohort-topic-followon-derivation`,
`cohort-topic-participant-coord-routing-key-mismatch`, and multi-tier promotion are all still open).
Every shipped test drives a single cohort around one coord, where `findServing` is exact. This is a
**gate for multi-cohort promotion**, not a regression in the current milestone.

## Options to decide

- **Carry the served coord on the notice** (and ideally cover it in the signing payload), then resolve
  the engine by exact coord rather than by `(topic, tier)` scan. Cleanest disambiguation; binds the
  decision to its cohort cryptographically. Costs a wire field + payload-version bump.
- **Make the handler coord-agnostic but robust**: have `findServing` return *all* engines matching
  `(topic, tier)` and apply the notice to whichever one's cert the signers verify against (verify-then-
  apply per candidate). No wire change, but it runs verification up to N times and still cannot
  distinguish two cohorts whose certs both accept the signers (overlapping membership).

Prefer the wire-field approach if a payload-version bump is acceptable when this is picked up; it also
closes the related "a valid notice from cohort A replayed to a node that is also in cohort B" concern
(the signature would then bind the coord).

## Acceptance

- A node serving `(topic, tier)` under two distinct coords adopts a promotion/demotion into the
  *correct* engine, with the other engine's state unchanged. Add a db-p2p test that stands up two
  `NoticeApplyTarget`s for the same `(topic, tier)` and confirms the notice lands on the matching one.
- A notice decided for cohort A is not mis-applied to (nor dropped by) a node's cohort-B engine.
- `docs/cohort-topic.md` §Promotion reflects how a receiver disambiguates the target cohort.

## Notes

- Surfaced by the gap-4 review (`cohort-topic-promote-verify-apply`). The review explicitly flagged
  `findServing`'s first-match scan and the single-cohort assumption; this ticket records the multi-
  cohort correctness gap behind it.
- Coordinate with `cohort-topic-participant-coord-routing-key-mismatch` and
  `cohort-topic-followon-derivation` — all three are `d ≥ 1` multi-tier gates and any wire/coord change
  here should be reconciled with the `coord_d` decisions there.
