description: Two hardening fixes landed in the cohort-topic layer — a peer's redirect reply can no longer crash a topic lookup with a bad tier number, and several fixed-size identifier fields now reject oversized values before they can bloat in-memory maps.
prereq:
files:
  - packages/db-core/src/cohort-topic/walk.ts                 # (a) bound the adopted promoted targetTier before it reaches coord()
  - packages/db-core/src/cohort-topic/wire/validate.ts        # (b) length-check fixed-width byte fields; b64urlField note; cohortEpoch left lenient
  - packages/db-core/test/cohort-topic/walk.spec.ts           # new: out-of-range targetTier → retry_later (both followPromoted modes)
  - packages/db-core/test/cohort-topic/wire.spec.ts           # new: over-length topicId / correlationId rejected
  - packages/db-core/test/reactivity/subscriber.spec.ts       # NOT edited, but drove the cohortEpoch revert (1-byte synthetic epoch fixture)
difficulty: medium
----

# Review: cohort-topic wire hardening (adopted redirect tier + fixed-width byte fields)

Implements parts (a) and (b) of the parent fix `2-cohort-topic-topic-wire-validation-bounds-hoist`.
Part (c) (the cross-module primitive hoist) is a separate ticket (`cohort-topic-wire-validate-hoist`)
that runs after this one — not touched here.

**Build + test:** `yarn workspace @optimystic/db-core build` clean; `yarn workspace @optimystic/db-core test`
→ **1094 passing, 0 failing**. 3 new tests added (2 wire, 1 walk), all confirmed executing under the spec
reporter.

## What changed

### (a) Walk bounds the adopted `targetTier` (walk.ts)

A `promoted` reply names a `targetTier` the walk jumps outward to. The wire validator only checks it as
an optional finite number, so an attacker's `2.5` / `-1` / `300` flowed into `addressing.coord()` →
`coordD`, which throws a raw `RangeError` — an unclassified crash out of `register()` / `lookup()`.

Fix: a module-level `isValidTreeTier(value)` (integer in `0..DEFAULT_D_MAX_CAP`, matching the wire
`treeTier` validator's range) plus a guard in `case "promoted"`, placed **before both** adoption sites
(the `followPromoted === false` surface and the internal `d = targetTier` hop). When `reply.targetTier`
is present AND out of range, the walk returns `{ kind: "retry_later" }` instead of reaching `coord()`.
The `?? d + 1` fallback is left unchecked — `d` is walk-bounded so it can't exceed the range (only the
explicit attacker value is the hazard).

### (b) Fixed-width byte fields length-checked (wire/validate.ts)

Switched hash-derived fixed-width fields from `b64urlField` (base64url-only) to `b64urlFixedLen(…, N, …)`
so an oversized value (e.g. a 1 MiB `topicId`) is rejected as a `CohortWireError` before it can become a
map key in the store / rate limiter / replay guard. Added `CORRELATION_BYTES = 16` and relocated
`COORD_BYTES = 32` up next to `b64urlFixedLen`.

**Pinned** (32 bytes unless noted): `RegisterV1.topicId` + `.correlationId`(16); `RenewV1.topicId` +
`.correlationId`(16); `PromotionNoticeV1.topicId`/`cohortCoord`; `DemotionNoticeV1.topicId`/
`parentCohortCoord`/`cohortCoord`; `GossipRecordV1.topicId`; `GossipRecordRefV1.topicId`;
`ChildLinkRefV1.topicId`; `CohortGossipV1.coord`; `SignRequestV1.coord`; `MembershipCertV1.cohortCoord`;
`ChildLinkV1.topicId` (its `childCohortCoord`/`cohortEpoch` were already pinned by prior parent-child-link work).

**Left lenient (peer-id / signature / opaque):** all `participantCoord`, `childParticipantCoord`,
`participantId`, `primary`, `backups`, `signers`, `signature`, `thresholdSig`, `payload`, `appPayload`,
`appState`, etc. — variable width, per the ticket's do-not-pin list.

## ⚠️ Deviation from the ticket's field list — `cohortEpoch` / `prevEpoch` could NOT be pinned

The ticket listed `cohortEpoch` (32) for `RegisterReplyV1` / `RenewReplyV1` / `PromotionNoticeV1` /
`DemotionNoticeV1` / `CohortGossipV1` / `SignRequestV1` / `MembershipCertV1`, and `prevEpoch` (32) for the
rotation attestation. Pinning them broke a pre-existing test:

- `test/reactivity/subscriber.spec.ts` → "stale membership cache (real verifier path)" builds a
  `MembershipCertV1` with `cohortEpoch: bytesToB64url(new Uint8Array([7]))` — a **1-byte** synthetic epoch
  (line ~129). With the pin, `validateMembershipCertV1` rejected the cert, so the verifier returned
  `untrusted` instead of `delivered`. (`AssertionError: expected 'untrusted' to equal 'delivered'`.)

Per the ticket's explicit rule ("if a fixture breaks on a field you pinned, that field is not actually
fixed-width — revert it to `b64urlField` and note it"), and because `subscriber.spec.ts` is outside this
ticket's file scope, I reverted **all** reply/notice/gossip/sign `cohortEpoch` fields and the rotation
`prevEpoch` to lenient `b64urlField`, with `// NOTE:` markers at the sites pointing at the reactivity
fixture. Everything else in the ticket's list stayed pinned (the full suite is green with them pinned).

**One asymmetry to be aware of:** `ChildLinkV1.cohortEpoch` **is** still pinned to 32 — that pin is
*pre-existing* (added by earlier parent-child-link work, its own fixtures use 32-byte epochs), so I left
it as-is rather than un-pin working code outside this ticket's mandate. So epochs are pinned in
`ChildLinkV1` but lenient everywhere else.

**For the reviewer to decide (a real, but conditional, follow-up — NOT filed as a ticket):** is a
`cohortEpoch` genuinely a 32-byte SHA-256 truncation in *real* (non-test) code? Every real path and every
other fixture uses 32 bytes; only that one reactivity test uses `[7]` as a lazy placeholder where epoch
width is irrelevant to what it asserts (member-subset staleness). If real epochs are confirmed 32-byte,
the clean finish is: fix that one fixture (`[7]` → a 32-byte array) and re-pin `cohortEpoch`/`prevEpoch`
across the listed types (restoring the ticket's full intent + the `ChildLink`/rest consistency). That
edit touches a file outside this ticket's scope, which is why it's flagged for the reviewer rather than
done here. If real epochs are *not* always 32 bytes, the current lenient state is correct and the
`ChildLinkV1` pin is arguably too strict — but that's pre-existing, don't chase it here.

## Tripwire recorded (deferred, conditional — not a ticket)

Per the ticket, the deferred **max-length bound on variable-width peer-id / signature fields** (they're
also attacker-bloatable into map keys, but their widths aren't pinned by the spec, so a ceiling is a
policy choice, not a decode) is parked as:

- a `// NOTE:` in the JSDoc of `b64urlField` (wire/validate.ts) — "no max-length bound here … if a bloated
  one is ever seen as a map key in practice, add a `b64urlMaxLen` ceiling here."

Recorded here in findings as the index; the analysis lives at that code site.

## Use cases to validate / attack surface for the reviewer

Treat the tests below as a **floor**, not a finish line.

- **(a) Redirect-tier crash:** a `promoted` reply with `targetTier` = `2.5`, `-1`, `300` (or any
  non-integer / <0 / >60) must yield `retry_later`, never a `RangeError`, in **both** `followPromoted`
  modes. Covered by `walk.spec.ts` "bounds an out-of-range promoted targetTier…". Not covered: a
  `targetTier` of exactly `DEFAULT_D_MAX_CAP` boundary via the walk (validator boundary is covered in
  wire.spec, but the walk-loop boundary at `60`/`61` is only implicitly covered). Worth a boundary case.
- **(b) Oversized fixed field:** an over-length `topicId` (32) / `correlationId` (16) throws
  `CohortWireError`; a correctly-sized frame still round-trips; the existing "32-byte topicId / 16-byte
  correlationId fidelity" test stays green. Covered by `wire.spec.ts`. **Gap:** the new over-length tests
  only exercise `RegisterV1`. The other newly-pinned fields (`RenewV1.topicId`, the notice `cohortCoord`s,
  `GossipRecordV1.topicId`, `SignRequestV1.coord`, `MembershipCertV1.cohortCoord`, `ChildLinkRefV1.topicId`,
  etc.) rely on the full-suite round-trips for their *happy* path but have **no dedicated over-length
  rejection test** — the length gate is the same helper, so risk is low, but a reviewer wanting belt-and-
  suspenders could parametrize the over-length assertion across message types.
- **Under-length:** the new tests use over-length (64 bytes). A too-short value (e.g. 16-byte topicId) is
  covered transitively by `b64urlFixedLen`'s exact-equality check and the existing ChildLink
  "rejects a non-32-byte coord field" test, but there's no explicit under-length test on the fields this
  ticket pinned.
- **Real-frame integration:** all length checks were validated against the encode→decode fixtures, not
  against a live `service.ts`/`member-engine.ts` round-trip. `service.ts` sets `participantCoord` from the
  peer id (left lenient — correct) and `topicId` from a 32-byte hash (pinned — correct), so no runtime
  breakage is expected, but this was confirmed by the passing suite, not by driving the real p2p path.

## Notes on scope decisions

- `CohortTopicSummary.topicId` and `ChildLinkRefV1.childCohortCoord` were **deliberately left lenient** —
  neither is in the ticket's pin list (the ticket curated fields explicitly). Both are 32-byte in current
  fixtures, so a reviewer could pin them for consistency, but that's beyond this ticket's stated scope.
- No `*Reply` `result` enums or numeric bounds were touched. Only byte-field widths and the walk redirect
  tier.
