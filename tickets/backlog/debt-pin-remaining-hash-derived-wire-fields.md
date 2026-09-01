description: Some network message fields that are always a fixed-size fingerprint are still accepted at any size, so a hostile peer can send a huge one and bloat the tables the receiver keys by them.
files:
  - packages/db-core/src/cohort-topic/wire/validate.ts
  - packages/db-core/src/matchmaking/wire.ts
  - packages/db-core/src/cohort-topic/wire/primitives.ts
  - packages/db-core/test/cohort-topic/wire.spec.ts
  - packages/db-core/test/matchmaking/wire.spec.ts
difficulty: easy
severity: edge-case
likelihood: unusual
tradeoffs: Nobody has observed a bloated field in practice, and each site is a one-line change with no user-visible payoff, so a maintainer could reasonably wait until one of these shows up in a memory profile.
----

# Pin the hash-derived wire fields that are still length-lenient

## Background

Wire messages carry two kinds of base64url byte fields:

- **Fixed-width, hash-derived** — a topic id, a ring coord, a cohort epoch. Each is a SHA-256 digest
  truncated to the ring width, so it is *always* exactly 32 bytes. These are validated with
  `b64urlFixedLen(..., COORD_BYTES, ...)`, which rejects any other length.
- **Variable-width** — peer ids (multihash-encoded), signatures, opaque application payloads. These are
  validated with `b64urlField`, which only checks that the string is valid base64url. Their widths are
  not fixed by the spec, so a length cap would be a chosen policy number rather than a decode of the
  format. `b64urlField`'s own doc comment records that decision.

The receiver turns several of the fixed-width ones into **map keys** — the child-link set is
last-writer-wins per `(topicId, childCohortCoord)`, the per-topic gossip summaries are keyed by
`topicId`. A key whose size the sender chooses is memory the sender controls.

`debt-cohort-topic-pin-cohort-epoch` closed this for every `cohortEpoch` / `prevEpoch` field on both
the cohort-topic and matchmaking wires. Four hash-derived fields were left on the lenient path, and one
of them is half of a map key whose *other* half is already pinned:

- `ChildLinkRefV1.childCohortCoord` (`validate.ts`, `validateChildLinkRefV1`) — its sibling `topicId` in
  the same struct is pinned; together they form the child-link map key.
- `CohortTopicSummary.topicId` (`validate.ts`, `validateCohortTopicSummary`) — repeated once per topic
  inside every gossip frame, the highest-volume inbound message on the wire.
- `QueryV1.topicId` (`matchmaking/wire.ts`, `validateQueryV1`).
- `AggregateCountV1.topicId` (`matchmaking/wire.ts`, `validateAggregateCountV1`).

Each is documented as "32 bytes, base64url" in its own type definition and in `docs/cohort-topic.md` /
`docs/matchmaking.md`, so the code simply does not enforce what it already claims.

## Expected behaviour

Decoding a frame whose `childCohortCoord` / `topicId` does not decode to exactly 32 bytes fails with a
`CohortWireError` naming the field, the same way an over-length `cohortEpoch` or `correlationId`
already does. Every producer in the tree derives these from `hash.H(...)`, so no honest sender is
affected.

## The durable part

Pinning four call sites is the easy half; the class recurs because leniency is the default and pinning
is opt-in per call site, so the next hash-derived field added to a message can silently join the lenient
bucket. The lasting fix is a **table-driven decode test that enumerates every fixed-width field on both
wires** and asserts each rejects 0-, 31-, 33-, 64- and 1024-byte values — so a new field that forgets
its width gate shows up as a missing row rather than as a memory-growth bug years later.
`packages/db-core/test/cohort-topic/wire.spec.ts` already has exactly this shape for `cohortEpoch`
(`describe('cohortEpoch 32-byte width')`); generalize it to cover coords and topic ids rather than
adding another one-off case per field.

## Out of scope

The variable-width fields (`participantCoord`, signatures, `appPayload`, `payload`, peer ids). Their
leniency is a recorded decision in `b64urlField`'s doc comment, with a stated revisit condition — if a
bloated one is ever *seen* as a map key in practice, add a `b64urlMaxLen` ceiling there. That condition
has not tripped.
