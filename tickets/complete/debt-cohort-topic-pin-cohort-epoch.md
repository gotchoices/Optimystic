description: A cohort's "epoch" identifier arrives from the network unchecked for size, so a hostile peer could send a huge one and bloat an in-memory lookup table; it is now pinned to its real fixed width on every message type that carries one.
files:
  - packages/db-core/src/cohort-topic/wire/validate.ts
  - packages/db-core/src/cohort-topic/wire/primitives.ts
  - packages/db-core/src/cohort-topic/wire/types.ts
  - packages/db-core/src/matchmaking/wire.ts
  - packages/db-core/test/cohort-topic/wire.spec.ts
  - packages/db-core/test/matchmaking/wire.spec.ts
  - docs/cohort-topic.md
  - docs/matchmaking.md
----

# Pin `cohortEpoch` / `prevEpoch` to 32 bytes across the wire — complete

## What shipped

A cohort epoch is `H(sorted members)` — a SHA-256 digest, so always exactly 32 bytes — but the decoder
accepted any length. The receiver turns it into a map key (the verifier's rotation state, the gossip
bus's drift check), so its size was the sender's choice. Every `cohortEpoch` and `prevEpoch` field is
now validated with `b64urlFixedLen(..., COORD_BYTES, ...)` and rejects anything but 32 bytes.

Implement stage (commit `15885416`) pinned nine sites in
`packages/db-core/src/cohort-topic/wire/validate.ts` — the two optional reply fields, the promotion and
demotion notices, cohort gossip, sign request, membership cert, the rotation attestation's `prevEpoch`,
and `validateChildLinkV1` (whose own docstring already claimed it was pinned when it was not) — and
widened the synthetic 1- and 3-byte epoch fixtures in seven test files to 32 bytes.

Review stage added the two sites the implement pass missed and the coverage to hold the line; see
below.

## Review findings

**Checked:** the full implement diff read before the handoff summary; every producer of a cohort epoch
in `packages/*/src` (all reach `hash.H(...)`, so the pin breaks no honest sender); every remaining
`cohortEpoch` test fixture in both packages; the wire type definitions and the `docs/` schema blocks
against the new reality; every other `b64urlField` call on both wires for the same class of defect;
`tickets/backlog`, `fix`, `plan`, `implement` for an existing claim on these files (none); lint,
typecheck across all workspaces, and both test suites.

**Major — the same field was left lenient on a second wire (fixed in this pass).**
`packages/db-core/src/matchmaking/wire.ts` carries the identical `cohortEpoch` on `QueryReplyV1` and
`AggregateCountV1`, both still validated with the length-agnostic `b64urlField`. The ticket's own
description says the epoch is pinned "across all wire message types", and the matchmaking wire
explicitly documents itself as following the cohort-topic wire conventions, so leaving two of them open
would have left the hole half-closed. Both are now `b64urlFixedLen`. The producer
(`db-p2p/src/matchmaking/aggregate-counts.ts`) already documents its input as 32 bytes, so nothing
honest changes.

**Minor — the width constant was private to one validator (fixed).** `COORD_BYTES` was a file-local
`const` in `validate.ts`, so pinning the matchmaking wire would have meant a second literal `32` in a
second file. It moved to `wire/primitives.ts` — the module both wires already import their validation
helpers from — and is imported by both. One definition, no duplicated magic number.

**Minor — test coverage was one assertion for nine changed sites (fixed).** The implement pass proved
the gate on a single over-length `MembershipCertV1`. Eight of the nine pinned fields, and the
under-length direction entirely, went untested; a site that reverted to `b64urlField` would not have
failed anything. `wire.spec.ts` now has a table-driven `describe('cohortEpoch 32-byte width')` that
walks every epoch-bearing message type — the two replies, both notices, child link, gossip, sign
request, membership cert, and `prevEpoch` — asserting a 32-byte epoch is accepted and that 0, 1, 31,
33, 64 and 1024 bytes are all rejected. The table is the point: a new epoch-bearing message type that
forgets the gate shows up as a missing row. `test/matchmaking/wire.spec.ts` gets the equivalent for its
two fields, framing with `encodeCohortMessage` so the assertions exercise the decode gate rather than
the encode gate.

**Minor — the types and docs under-documented the field (fixed).** Five `cohortEpoch` declarations in
`wire/types.ts` carried no width annotation while their sibling coord fields did; five schema blocks in
`docs/cohort-topic.md` and four in `docs/matchmaking.md` were the same. All now read `32 bytes`,
including the not-yet-implemented `ArrivalPushV1` so whoever builds it pins the field. No doc claimed
the old lenient behaviour, so nothing had to be retracted.

**Major — filed, not fixed here: four sibling fields of the same class.**
`tickets/backlog/debt-pin-remaining-hash-derived-wire-fields.md`. `ChildLinkRefV1.childCohortCoord`,
`CohortTopicSummary.topicId`, `QueryV1.topicId` and `AggregateCountV1.topicId` are all documented as
32-byte hash-derived values and all still lenient. The sharpest instance: `ChildLinkRefV1`'s child-link
set is last-writer-wins per `(topicId, childCohortCoord)` and *only the `topicId` half is pinned*, so
half a map key is attacker-sized. This is a different field family from the epoch — the parent ticket
explicitly called it independent work — so it is a ticket rather than more scope here. It is filed at
the generalized-test rung: the durable ask is to extend the new table-driven width test to cover every
fixed-width field on both wires, not to patch four call sites.

**Considered and declined — the variable-width fields.** `participantCoord`, signatures, `appPayload`,
`payload` and peer ids stay on `b64urlField`. `b64urlField`'s doc comment records this as an accepted
tradeoff with a stated revisit condition ("if a bloated one is ever seen as a map key in practice, add
a `b64urlMaxLen` ceiling"), and that condition has not tripped. Not re-filed.

**Empty categories.** No tripwires: every concern found was either definite and fixed, or definite and
filed — none had the "fine now, only matters if X later" shape. No resource-cleanup, concurrency, or
error-handling findings: the diff adds no state, no I/O and no lifetime, and its only failure mode is
the `CohortWireError` throw it exists to produce. No source-hygiene findings: `validate.ts` is 504
lines and `primitives.ts` 195 (`wc -l`), both well inside the pattern of this directory, and the
implement pass correctly deleted the stale `NOTE:` comments that pointed at this ticket rather than
leaving them to rot.

**Left alone deliberately.** Two epoch fixtures in
`packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts` (lines 617 and 715) are UTF-8 strings,
not 32 bytes. They are injected straight into `verifier().cache(cert)` and never round-trip through
`encodeCohortMessage`, so the pin cannot reject them and widening them would only churn the diff. The
implement pass's reasoning here was checked and is correct.

## Compatibility note

This is a tightening of the wire format: a peer emitting a non-32-byte epoch is now rejected where it
was previously accepted. Every producer in the tree derives the epoch from `hash.H(...)`, so no
in-tree sender is affected, and the matchmaking query-protocol producers are not yet wired up at all.
There is no cross-version negotiation to stage this behind today.

## Verification

- `yarn lint` — clean.
- `yarn typecheck` (all workspaces) — clean.
- `yarn workspace @optimystic/db-core test` — 1546 passing, 0 failing (up from 1474; the new width
  tables account for the increase).
- `yarn workspace @optimystic/db-p2p test` — 2489 passing, 49 pending (pre-existing skips, unrelated),
  0 failing.
