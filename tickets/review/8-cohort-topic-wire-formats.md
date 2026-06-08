description: Review the cohort-topic V1 wire layer — message types, length-prefixed JSON framing, base64url codecs, per-message validation, and round-trip tests in db-core.
prereq: fold-simulator-findings-into-design-docs, cohort-topic-package-layering
files:
  - packages/db-core/src/cohort-topic/wire/types.ts
  - packages/db-core/src/cohort-topic/wire/codec.ts
  - packages/db-core/src/cohort-topic/wire/validate.ts
  - packages/db-core/src/cohort-topic/wire/index.ts
  - packages/db-core/src/cohort-topic/index.ts
  - packages/db-core/test/cohort-topic/wire.spec.ts
  - docs/cohort-topic.md (§Wire formats)
----

# Review: cohort-topic wire formats and RPC message codecs

Implements the wire foundation of the cohort-topic substrate: the eight V1 message types and
their JSON-over-the-wire serialization. **No behavior** — no FRET wiring, no state machines, no
addressing/storage. Just types + codec + validation + tests.

## What was built

- **`wire/types.ts`** — every V1 interface transcribed verbatim from `docs/cohort-topic.md`
  §Wire formats: `RegisterV1`, `RegisterReplyV1` (+ `RegisterResult`, `TopicTrafficV1`),
  `RenewV1`, `RenewReplyV1`, `PromotionNoticeV1`, `DemotionNoticeV1`, `CohortGossipV1`
  (+ `CohortTopicSummary`), `MembershipCertV1`. Plus a `CohortMessageV1` union. Byte fields are
  typed `string` (base64url); timestamps are unix ms. `appPayload` is documented as opaque — the
  wire layer never interprets it.
- **`wire/codec.ts`** — cross-platform base64url helpers (`bytesToB64url`/`b64urlToBytes`, no
  padding, manual impl, **no Node `Buffer`**); length-prefixed framing
  (`encodeCohortMessage`/`decodeCohortMessage`, 4-byte big-endian prefix); `DEFAULT_MAX_MESSAGE_BYTES`
  ceiling (1 MiB, with a TODO to derive the exact `topics_max`-based bound); typed decoders
  (`decodeRegisterV1`, …one per message type) that decode → validate → narrow.
- **`wire/validate.ts`** — `CohortWireError` + per-message structural validators: required fields,
  `v === 1`, enum discriminants, base64url decodability of byte fields, numeric ranges
  (`tier` 0..3, `loadBuckets` length-4 each 0..7), hex `willingnessBits`, finite timestamps.
  Absent optionals are **omitted** from the decoded object (not set to `undefined`).
- Re-exports wired through `wire/index.ts` → `cohort-topic/index.ts` → `db-core/src/index.ts`.
- **`docs/cohort-topic.md`** — added a §Wire formats callout naming the codec module as canonical
  and documenting the 4-byte framing + `max_message_bytes` ceiling.

## Verification done

- `yarn build` green for db-core.
- `yarn test` green for db-core — **340 passing**, including the 31 new cases in
  `test/cohort-topic/wire.spec.ts`: round-trip per message type, base64url byte fidelity (seeded
  32-/16-byte values), malformed rejection (missing field, bad enum, non-finite timestamp, bad
  `v`, out-of-range tier, non-base64url byte field, bad `loadBuckets`, non-hex willingness),
  oversized-frame rejection, and absent-optional omission.

## Review focus / known gaps (treat as a floor, not a finish line)

- **`max_message_bytes` is a placeholder.** 1 MiB flat, not the `topics_max` (2048) × per-summary
  derivation the ticket calls for. The fold-simulator ticket confirmed defaults *as written* but
  did not add a concrete `max_message_bytes` to §Configuration, so there is no exact bound to
  pull yet. TODO left in `codec.ts`. Reviewer: confirm 1 MiB is safe for a worst-case cohort
  gossip (2048 summaries ≈ small hundreds of KiB of JSON) — it should be, but verify the headroom.
- **Validation is structural, not semantic.** Validators check shape/ranges/base64url-decodability
  but do **not** verify signatures, `correlationId` length (16 bytes), `topicId`/coord length
  (32 bytes), `signers.length >= minSigs`, `members` sorted-ascending / length `k`, or cross-field
  presence rules (e.g. `accepted` ⇒ `primary` present). These are deferred to the
  registration/gossip/promotion behavior tickets that own those semantics. Confirm this split is
  the intended boundary.
- **`willingnessBits` accepts any-length hex** (doc says "4 bits T0..T3, hex"); not pinned to a
  single nibble. Likely fine but flag if a fixed width is wanted.
- **`decodeCohortMessage` uses `bytes.byteOffset`/`byteLength`** for the DataView so subarray
  inputs work; the round-trip and truncation tests cover this, but double-check no caller passes a
  view that aliases a larger buffer where the prefix-length check could misread.
- **base64url decoder is hand-rolled** (the ticket forbids `Buffer` for cross-platform reach). It
  rejects `%4 === 1` lengths, non-alphabet chars, and `+`/`/`/`=`. Worth a skim for correctness on
  the 2-/3-remainder tail paths (tests exercise lengths 0..10 and 16/32).

## Done-when (all met)

- `yarn build` green for db-core. ✓
- `yarn test` green for db-core incl. `wire.spec.ts`. ✓
- `docs/cohort-topic.md` §Wire formats reflects framing/ceiling + references the codec module. ✓
