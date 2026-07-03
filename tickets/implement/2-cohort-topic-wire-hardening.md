description: Harden how the cohort-topic layer handles two untrusted inputs — a tier number copied from a peer's redirect reply that can currently crash a lookup, and byte fields with no size limit that a hostile peer could bloat into huge in-memory map keys.
prereq:
files:
  - packages/db-core/src/cohort-topic/walk.ts                 # ~240-256 — adopts targetTier from a "promoted" reply, feeds it to coord()
  - packages/db-core/src/cohort-topic/addressing.ts           # coordD throws RangeError for non-int / <1 / >255 tier
  - packages/db-core/src/cohort-topic/wire/validate.ts        # b64urlFixedLen helper (already present), byte-field validators
  - packages/db-core/src/cohort-topic/wire/types.ts           # field-width doc comments (some STALE — see note)
  - packages/db-core/src/cohort-topic/dmax.ts                 # DEFAULT_D_MAX_CAP (60) — the treeTier ceiling
  - packages/db-core/test/cohort-topic/wire.spec.ts           # wire fixtures: topicId=32B, participantCoord=32B, correlationId=16B
  - packages/db-core/test/cohort-topic/walk.spec.ts           # walk fixtures + where to add the out-of-range targetTier test
  - packages/db-core/src/cohort-topic/service.ts              # ~352 — participantCoord := this.participantId (peer id, NOT 32B)
  - packages/db-core/src/cohort-topic/member-engine.ts        # ~156 — decodes participantCoord back as the peer id
difficulty: medium
----

# Cohort-topic wire hardening: bound the adopted redirect tier, and length-check fixed-width byte fields

Two independent hardening fixes in the cohort-topic substrate, both local to the `cohort-topic`
package. This is parts (a) and (b) of the parent fix ticket `2-cohort-topic-topic-wire-validation-bounds-hoist`;
part (c) (the cross-module primitive hoist) is split into `cohort-topic-wire-validate-hoist`, which
runs after this one.

## Background

A participant resolves/registers a topic by walking toward the tree root, one RPC per tier
(`walk.ts`). Each hop it computes a ring coordinate `coord(d, self, topicId)` (`addressing.ts`) and
sends a signed `RegisterV1` frame. Replies are structurally validated (`wire/validate.ts`) before use.
Two untrusted inputs slip through today.

## (a) Walk adopts an unbounded `targetTier` from a "promoted" reply → unclassified crash

When a cohort replies `result: "promoted"`, it names a `targetTier` — the tier the walk should jump
outward to. `walk.ts` adopts it:

```ts
// walk.ts, case "promoted":
const targetTier = reply.targetTier ?? d + 1;
...
if (!this.followPromoted) {
    return { kind: "promoted", targetTier };   // caller then calls coord(targetTier, …) itself
}
d = targetTier;                                 // then this hop calls coord(d, …)
```

`reply.targetTier` is validated only as an **optional finite number** (`validateRegisterReplyV1` →
`optFiniteNumber`, no range check). It flows into `addressing.coord(d, self, topicId)`, whose `coordD`
throws a raw `RangeError` for a non-integer, negative, or `> 255` tier
(`addressing.ts:88-94`). A malicious cohort replying `targetTier: 2.5`, `-1`, or `300` therefore makes
an **unclassified `RangeError` escape `register()` / `lookup()`** instead of a clean, classified
outcome. (`register()` is the shared engine path; a probe/lookup runs the same loop, so one fix covers
both.)

The default `reply.targetTier ?? d + 1` fallback is always safe — `d` is walk-bounded (≤ `d_max`,
capped by `DEFAULT_D_MAX_CAP = 60`), so `d + 1` cannot exceed the coord range. Only the **explicit**
attacker-supplied `reply.targetTier` is the hazard.

**Fix:** after computing `targetTier`, bound-check it. If `reply.targetTier` was present AND is not a
valid tier (integer in `0..DEFAULT_D_MAX_CAP`), return `{ kind: "retry_later", afterMs:
backoffRetryMs(0) }` rather than letting it reach `coord()`. Apply the check **before both** adoption
sites (the `followPromoted === false` surface at ~line 253 and the `d = targetTier` hop at ~line 255),
so neither a self-driven caller nor the internal follow ever gets an out-of-range value. Match the
range the existing `treeTier` validator uses (`0..DEFAULT_D_MAX_CAP`) for consistency — a tier above
the substrate's own walk-depth ceiling cannot name a real cohort.

> Rejected alternative: tightening `validateRegisterReplyV1` to reject an out-of-range `targetTier` at
> decode. That throws a `CohortWireError` out of `decodeRegisterReplyV1` inside the walk loop — still a
> throw out of `register()`, not the `retry_later` outcome the parent ticket asks for. Keep the bound in
> `walk.ts`. (Optionally *also* range-check it in the validator as belt-and-suspenders, but the walk
> guard is the one that must exist.)

## (b) Fixed-width byte fields have no length bound → oversized map keys

`wire/validate.ts` checks most byte fields only as **valid base64url** (`b64urlField`) — no length
check. A ~1 MiB `topicId` passes validation and then becomes a key in the store, topic budget, rate
limiter, and replay guard; a bloated `correlationId` becomes a replay-guard key. A `b64urlFixedLen`
helper already exists (added by the parent-child-link work, currently used for `ChildLinkV1`'s
`childCohortCoord` / `cohortEpoch`) — reuse it for the other fields whose width is genuinely fixed.

### Which fields are actually fixed-width — READ THIS BEFORE EDITING

The `types.ts` doc comments are **partly stale**. Several fields the doc labels "32 bytes" are in
practice a libp2p **peer id**, which is multihash-encoded and NOT 32 raw bytes. Concretely:

- `service.ts:352` sets `RegisterV1.participantCoord = bytesToB64url(this.participantId)` — the
  participant's **peer id**, not a 32-byte ring coord.
- `member-engine.ts:156` decodes `reg.participantCoord` straight back into the peer id.
- `validateChildLinkV1` already documents this: it deliberately keeps `childParticipantCoord` (and
  `topicId` there) lenient "because a participant coord is not always 32 raw bytes, e.g. a
  multihash-encoded peer id in tests".

So the `b64urlFixedLen` set is **only the hash-derived fields**, never peer-id-derived ones. Length-check
these (all 32 bytes unless noted), reusing the existing `COORD_BYTES = 32` constant and a new
`CORRELATION_BYTES = 16`:

- `RegisterV1`: `topicId` (32), `correlationId` (16)
- `RegisterReplyV1`: `cohortEpoch` (32)
- `RenewV1`: `correlationId` (16)  *(topicId here too — see note below)*
- `RenewReplyV1`: `cohortEpoch` (32)
- `PromotionNoticeV1`: `topicId` (32), `cohortCoord` (32), `cohortEpoch` (32)
- `DemotionNoticeV1`: `topicId` (32), `parentCohortCoord` (32), `cohortCoord` (32), `cohortEpoch` (32)
- `GossipRecordV1` / `GossipRecordRefV1` / `ChildLinkRefV1`: `topicId` (32)
- `CohortGossipV1`: `coord` (32), `cohortEpoch` (32)
- `SignRequestV1`: `coord` (32), `cohortEpoch` (32)
- `MembershipCertV1`: `cohortCoord` (32), `cohortEpoch` (32), `prevEpoch` (32 when present)
- `ChildLinkV1`: `topicId` (32) — currently lenient; tighten only if fixtures allow (see caution)

**Do NOT length-check** (peer-id / signature / opaque, all variable width): `participantCoord`,
`childParticipantCoord`, `participantId`, `primary`, `backups`, `signers`, `signer`, `fromMember`,
`signature`, `thresholdSig`, `rotationSig`, `rotationSigners`, `payload`, `appPayload`, `appState`,
`fretAttestation`, `bootstrapEvidence`. These stay on plain `b64urlField`.

Caution on `topicId`: it is a SHA-256 truncation (32 bytes) and the wire fixtures use 32 bytes, so it
*should* be safe to pin — but confirm no test/real path feeds a non-32-byte topicId before tightening.
The full db-core test run below is the gate. If a fixture breaks on a field you pinned, that field is
not actually fixed-width — leave it lenient and note it.

> Out of scope (do not do here): a *max*-length bound on the variable-width peer-id / signature fields.
> Those are also attacker-bloatable into map keys, but their widths aren't pinned by any doc, so a
> ceiling would be a chosen policy value, not a decode of the spec — and the fields most likely to break
> fixtures. Record this as a review tripwire, not work in this ticket (see TODO).

## Expected behavior

- A `promoted` reply with an out-of-range `targetTier` (`2.5` / `-1` / `300`) yields a `retry_later`
  outcome, never an unclassified `RangeError` out of `register()` / `lookup()`.
- An over-length fixed-width byte field (e.g. a 1 MiB `topicId` or `correlationId`) is rejected as a
  malformed `CohortWireError` frame before it can become a map key.
- All existing cohort-topic behavior is otherwise unchanged.

## TODO

- [ ] In `walk.ts` `case "promoted"`, bound-check the adopted `targetTier`: if `reply.targetTier` is
      present and not an integer in `0..DEFAULT_D_MAX_CAP`, return `retry_later`. Guard both the
      `followPromoted === false` return and the `d = targetTier` hop.
- [ ] Add a walk test (`walk.spec.ts`): a stubbed router returning `promoted` with `targetTier` of
      `2.5`, `-1`, and `300` each yields a `retry_later` outcome (no throw). Cover both
      `followPromoted` modes.
- [ ] In `wire/validate.ts`, add `CORRELATION_BYTES = 16` and switch the fixed-width byte fields listed
      above from `b64urlField` to `b64urlFixedLen(…, COORD_BYTES | CORRELATION_BYTES, …)`.
- [ ] Add wire tests (`wire.spec.ts`): an over-length `topicId` and an over-length `correlationId` each
      throw `CohortWireError`; a correctly-sized frame still round-trips. Keep the existing
      "32-byte topicId / 16-byte correlationId fidelity" test green.
- [ ] Run the db-core build + full test suite, streaming output:
      `yarn workspace @optimystic/db-core build 2>&1 | tee /tmp/build.log` then
      `yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/test.log`
      (confirm the exact package name / scripts from `packages/db-core/package.json` and the repo
      `AGENTS.md` first). If any fixture breaks on a field you pinned, that field is not fixed-width —
      revert it to `b64urlField` and note it in the handoff.
- [ ] Record the deferred max-length bound on variable-width peer-id/signature fields as a review
      tripwire: a `// NOTE:` at the `b64urlField` site in `wire/validate.ts` (e.g. "no max-length bound
      on peer-id/signature fields; if a bloated one is seen as a map key in the store/replay-guard, add
      a b64urlMaxLen ceiling"), and one line in the review handoff.
