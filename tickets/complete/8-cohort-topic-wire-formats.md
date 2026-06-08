description: Cohort-topic V1 wire layer — eight message types, length-prefixed JSON framing, cross-platform base64url codecs, per-message structural validation, and round-trip tests in db-core. Reviewed and completed.
prereq: fold-simulator-findings-into-design-docs, cohort-topic-package-layering
files:
  - packages/db-core/src/cohort-topic/wire/types.ts
  - packages/db-core/src/cohort-topic/wire/codec.ts
  - packages/db-core/src/cohort-topic/wire/validate.ts
  - packages/db-core/src/cohort-topic/wire/index.ts
  - packages/db-core/src/cohort-topic/index.ts
  - packages/db-core/src/index.ts
  - packages/db-core/test/cohort-topic/wire.spec.ts
  - docs/cohort-topic.md (§Wire formats)
----

# Complete: cohort-topic wire formats and RPC message codecs

The wire foundation of the cohort-topic substrate: the eight V1 message types
(`RegisterV1`, `RegisterReplyV1`, `RenewV1`, `RenewReplyV1`, `PromotionNoticeV1`,
`DemotionNoticeV1`, `CohortGossipV1`, `MembershipCertV1`) plus their JSON-over-the-wire
serialization. **No behavior** — types + codec + validation + tests only.

- **`wire/types.ts`** — V1 interfaces transcribed from `docs/cohort-topic.md` §Wire formats,
  plus a `CohortMessageV1` union. Byte fields typed `string` (base64url, no padding); timestamps
  unix ms; `appPayload` opaque/uninterpreted.
- **`wire/codec.ts`** — hand-rolled cross-platform base64url helpers (no Node `Buffer`);
  4-byte big-endian length-prefixed framing (`encodeCohortMessage`/`decodeCohortMessage`);
  `DEFAULT_MAX_MESSAGE_BYTES` (1 MiB) ceiling; typed decoders (decode → validate → narrow).
- **`wire/validate.ts`** — `CohortWireError` + per-message structural validators (required fields,
  `v === 1`, enum discriminants, base64url-decodability, `tier` 0..3, `loadBuckets` length-4 each
  0..7, single-nibble hex `willingnessBits`, finite timestamps). Absent optionals omitted, not set
  to `undefined`.
- Re-exports flow `wire/index.ts` → `cohort-topic/index.ts` → `db-core/src/index.ts`.
- **`docs/cohort-topic.md`** — §Wire formats callout naming the codec module canonical and
  documenting the framing + `max_message_bytes` ceiling.

## Review findings

Adversarial pass over the implement diff (`91a0075`). Read every touched file plus the source doc
(§Wire formats, §Configuration) and the original implement spec before forming findings.

### Verified correct (no change)
- **base64url codec** — encode/decode tail paths (rem 1/2/3), `len % 4 === 1` rejection,
  non-alphabet / `+` / `/` / `=` rejection, and high-bit (>127) char rejection all correct. Existing
  tests exercise byte lengths 0..10 plus 16/32 round-trips.
- **Framing** — `decodeCohortMessage` builds its `DataView` from `bytes.byteOffset`/`byteLength`,
  so a subarray that aliases a larger backing buffer reads the prefix correctly. The flagged
  aliasing concern is real-world-safe; added a dedicated regression test that decodes a frame
  embedded at a non-zero offset in a larger buffer (`aliased.byteOffset === 5`).
- **Tier ranges** — `tier` 0..3 applied to `RegisterV1.tier`, `DemotionNoticeV1.tier`,
  `PromotionNoticeV1.fromTier/toTier`, `CohortTopicSummary.tier` (all genuine T0..T3 fields), while
  `treeTier`/`targetTier` (walk position `d`, up to `d_max_cap`) are correctly left unbounded.
- **db-core barrel re-export** — `export * from "./cohort-topic/index.js"` in `src/index.ts`
  compiles cleanly (no symbol collisions); `yarn build` green.
- **`max_message_bytes` headroom** — worst-case cohort gossip is `topics_max = 2048` summaries
  ≈ 450–512 KiB of JSON (43-char base64url `topicId` + six small fields per summary, ~200–250 B
  each) plus a tiny header — comfortably under the 1 MiB flat cap (~2× headroom). The placeholder
  is safe.

### Fixed inline (minor)
- **`willingnessBits` width** — validator accepted any-length hex; doc specifies "4 bits T0..T3",
  i.e. exactly one nibble. Tightened the regex to `/^[0-9a-fA-F]$/` and added a rejection test for
  a 2-char value. The sample (`'f'`) stays valid; `willingnessBits` has no other producer in the
  tree, so the tightening is safe.
- **Doc/type drift** — `docs/cohort-topic.md` typed `MembershipCertV1.fretAttestation` as required
  `string` while its own comment and the implementation (`fretAttestation?: string`) treat it as
  optional. Aligned the doc to `fretAttestation?: string`.
- **Test coverage** — added cases for the previously untested reply discriminants
  (`RegisterReplyV1` `no_state` / `unwilling_cohort` / `unwilling_member`, `RenewReplyV1` `ok`),
  a cross-type rejection (Renew frame through `decodeRegisterV1`), an empty-`topicSummaries`
  gossip round-trip, the subarray-aliasing regression, and the `willingnessBits` width rejection.
  Test count 31 → 39 (db-core total 340 → 348).

### Accepted deferrals (documented, no ticket filed)
- **Exact `max_message_bytes` bound** — still the conservative 1 MiB flat cap with a TODO in
  `codec.ts`. The fold-simulator pass confirmed defaults *as written* but did not add a concrete
  `max_message_bytes` to §Configuration, so there is no exact bound to derive against yet. Headroom
  verified safe (above); the precise bound naturally belongs to whichever downstream gossip/config
  ticket introduces the constant. No separate ticket — the dependency is already documented in the
  codec TODO and the §Wire formats callout.
- **Semantic validation** — validators are structural only. Signature verification,
  `correlationId`/`topicId`/coord exact byte lengths (16/32), `signers.length >= minSigs`,
  `members` sorted-ascending / length `k`, and cross-field presence rules (e.g. `accepted` ⇒
  `primary` present) are owned by the registration/gossip/promotion behavior tickets that hold those
  semantics. This structural/semantic split is the intended boundary for the pure wire layer.
- **base64url non-canonical inputs** — like every standard base64 decoder (including Node `Buffer`),
  `b64urlToBytes` does not reject non-zero trailing bits, so two distinct strings can decode to the
  same bytes (decode-then-encode is not identity for non-canonical input). Any canonicalization /
  malleability hardening belongs to the semantic layer that compares decoded key/id bytes, not here.

### No findings
- **Resource cleanup / error handling** — no I/O, timers, or handles in this layer; all error paths
  funnel through `CohortWireError`. Nothing to clean up.
- **Type safety** — no `any`; decoders narrow from `unknown` through validators. Clean.

## Verification
- `yarn build` green for db-core. ✓
- `yarn test` green for db-core — **348 passing** (was 340; +8 new wire cases). ✓
- `docs/cohort-topic.md` §Wire formats reflects framing/ceiling + references the codec module, and
  the `fretAttestation` optionality now matches the implementation. ✓
