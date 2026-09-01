description: A cohort's "epoch" identifier arrives from the network unchecked for size, so a hostile peer could send a huge one and bloat an in-memory lookup table; it is now pinned to its real fixed width across all wire message types.
files:
  - packages/db-core/src/cohort-topic/wire/validate.ts
  - packages/db-core/test/cohort-topic/wire.spec.ts
  - packages/db-core/test/reactivity/subscriber.spec.ts
  - packages/db-core/test/reactivity/checkpoint.spec.ts
  - packages/db-core/test/reactivity/resume.spec.ts
  - packages/db-p2p/test/cohort-topic/invalidation-notification.spec.ts
  - packages/db-p2p/test/cohort-topic/reactivity-real-crypto.spec.ts
  - packages/db-p2p/test/reactivity/forwarder-host.spec.ts
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts
difficulty: easy
----

# Pin `cohortEpoch` / `prevEpoch` to 32 bytes across the cohort-topic wire — done

## What changed

`packages/db-core/src/cohort-topic/wire/validate.ts`: every `cohortEpoch` (and `prevEpoch`, a prior
epoch carried in the rotation-attestation group) field switched from `b64urlField` (accepts any
length) to `b64urlFixedLen(..., COORD_BYTES, ...)` (COORD_BYTES = 32), matching the real value —
`hash.H(...)` (SHA-256) always produces 32 bytes. Sites fixed:

- `validateRegisterReplyV1` (optional field)
- `validateRenewReplyV1` (optional field)
- `validatePromotionNoticeV1`
- `validateDemotionNoticeV1`
- `validateCohortGossipV1`
- `validateSignRequestV1`
- `validateMembershipCertV1`
- `validateRotationAttestation`'s `prevEpoch`
- **`validateChildLinkV1`** — not in the ticket's listed 7 sites. The ticket's own text asserted this
  one was "already pinned to 32 (pre-existing, from parent-child-link work)" and the function's
  docstring makes the same claim, but the actual code still called lenient `b64urlField`. Since the
  fix is identical (COORD_BYTES fixed-length) and every `ChildLinkV1` test fixture already used
  32-byte epochs (so nothing could break), I pinned it too to make the code match its own docstring
  and the ticket's premise.

All now-stale `NOTE:`/`See b64urlField's note` comments that pointed at this ticket (in `validate.ts`)
were removed.

## Test fixtures widened to 32 bytes

Padded every non-32-byte synthetic `cohortEpoch` test fixture that round-trips through
`encodeCohortMessage` → decode (these would otherwise now throw `CohortWireError`):

- db-core: `subscriber.spec.ts`, `checkpoint.spec.ts`, `resume.spec.ts` — each `new Uint8Array([7])`
  → `new Uint8Array(32).fill(7)`.
- db-p2p: `invalidation-notification.spec.ts`, `reactivity-real-crypto.spec.ts`,
  `forwarder-host.spec.ts` — same `[7]` → `fill(7)` pad.
- db-p2p: `substrate-real-libp2p.integration.spec.ts` — the one explicitly flagged fixture,
  `new Uint8Array([9, 9, 9])` → `new Uint8Array(32).fill(9)`. Left alone: two other `cohortEpoch`
  values further down the same file (`bytesToB64url(new TextEncoder().encode(\`rx:${TAIL_ID}\`))` and
  a `rx-resume:` variant) — these are injected directly into `verifier().cache(cert)`, never through
  `encodeCohortMessage` → decode, so the pin cannot reject them; the ticket listed only the `[9,9,9]`
  fixture for this file and marked the rest optional ("widen anyway for consistency" — skipped to keep
  the diff to what the pin actually requires).

## New test

Added to `packages/db-core/test/cohort-topic/wire.spec.ts`, next to the existing over-length
`topicId`/`correlationId` tests: `'rejects an over-length cohortEpoch (a fixed 32-byte field cannot
become a bloated rotation-state map key)'` — round-trips a `MembershipCertV1` with a 64-byte
`cohortEpoch` through `encodeCohortMessage` → `decodeMembershipCertV1` and asserts it throws
`CohortWireError` matching `/cohortEpoch/`.

## Verification

- `yarn workspace @optimystic/db-core test` — 1474 passing, 0 failing.
- `yarn workspace @optimystic/db-p2p test` (includes the real-libp2p integration suite) — 2489
  passing, 49 pending (pre-existing skips, unrelated), 0 failing.

## Left out of scope (per ticket's own "optional" note)

The ticket's "Related consistency note" flags `CohortTopicSummary.topicId` and
`ChildLinkRefV1.childCohortCoord` as also-32-byte-in-practice-but-left-lenient by the parent ticket's
curated pin list, and explicitly calls pinning those "independent of the epoch work" — not done here,
left for a reviewer/future ticket to pick up if desired.
