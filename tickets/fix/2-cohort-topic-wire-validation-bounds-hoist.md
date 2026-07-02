description: Three related weaknesses in how cohort-topic validates incoming messages — an untrusted depth value can crash a lookup, oversized id fields become huge map keys, and the same validation helpers are copy-pasted across three modules and drifting apart — should be tightened and consolidated.
prereq:
files:
  - packages/db-core/src/cohort-topic/walk.ts                 # ~244-255, 260-268 — adopts targetTier from reply, then addressing.coord()
  - packages/db-core/src/cohort-topic/wire/validate.ts        # ~174-181 — byte fields checked only as base64url, no length bound
  - packages/db-p2p/src/matchmaking/wire.ts                   # ~170-266 — duplicate validation primitives
  - packages/db-p2p/src/reactivity/wire-validate.ts           # duplicate validation primitives (closest to a shared base)
difficulty: medium
----

# Wire validation: unbounded adopted tier, missing byte-length bounds, and copy-pasted primitives

Three related wire-validation weaknesses, groupable into one change:

## (a) Walk adopts an unbounded `targetTier` from promotion replies

`walk.ts:244-255` adopts `targetTier` straight from a register/promotion reply and feeds it to
`addressing.coord()`. A malicious cohort replying `targetTier: 2.5 / -1 / 300` makes `coord()` throw an
unclassified exception out of `register()`/`lookup()`. The reply's `targetTier` is validated only as an
optional finite number (`validateRegisterReplyV1`, no range check). Clamp the adopted tier to the valid
integer range and, on an out-of-range reply, return `retry_later` rather than throwing.

## (b) Wire byte-fields have no length bounds

`wire/validate.ts:174-181` and its siblings check byte fields (`topicId`, `correlationId`,
`participantCoord`, etc.) only as *valid base64url* — no length check. A ~1 MiB `topicId` passes
validation and becomes a map key in the store, budget, rate limiter, and replay guard. Add the exact
byte-length checks the doc comments already pin (32-byte coords/topic ids, 16-byte correlation ids). The
parent-child-link work already added a `b64urlFixedLen` helper (used for `ChildLinkV1` coords) — reuse it
for the register/renew/notice/gossip byte fields whose widths are fixed.

## (c) Validator primitives copy-pasted ×3 and diverging

The identical validation primitive set (`reqString`, `optFiniteNumber`, base64url helpers, etc.) exists
in `cohort-topic/wire/validate.ts`, `matchmaking/wire.ts:170-266`, and `reactivity/wire-validate.ts`, and
is already diverging. Hoist one shared module (reactivity's is closest to a clean base) and have all three
consume it, so a hardening fix like (b) lands once. Note this hoist spans the matchmaking and reactivity
directories as well as cohort-topic.

## Expected behavior

- A reply with an out-of-range `targetTier` yields `retry_later`, never an unclassified throw.
- An over-length byte field is rejected as a malformed frame before it can become a map key.
- The three modules share one validation-primitive module; behavior is unchanged except where (b)
  tightens it.

Suggested split if this is too large for one run: (a)+(b) as a cohort-topic hardening ticket, (c) as a
separate cross-module hoist ticket chained after it. Keep as one if it fits.

Note: complete ticket `8-cohort-topic-wire-formats` deliberately deferred exact byte-length and
range/semantic checks to the behavior tickets — (a) and (b) are that deferred work.
