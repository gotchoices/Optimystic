description: A cohort's "epoch" identifier arrives from the network unchecked for size, so a hostile peer could send a huge one and bloat an in-memory lookup table; pin it to its real fixed width once the affected test fixtures are updated to match.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/validate.ts          # the 7 cohortEpoch sites + prevEpoch to re-pin
  - packages/db-core/test/reactivity/subscriber.spec.ts         # fixture: cohortEpoch [7] → 32 bytes
  - packages/db-core/test/reactivity/checkpoint.spec.ts         # fixture: cohortEpoch [7] → 32 bytes
  - packages/db-core/test/reactivity/resume.spec.ts             # fixture: cohortEpoch [7] → 32 bytes
  - packages/db-p2p/test/cohort-topic/invalidation-notification.spec.ts   # fixture: cohortEpoch [7]
  - packages/db-p2p/test/cohort-topic/reactivity-real-crypto.spec.ts      # fixture: cohortEpoch [7]
  - packages/db-p2p/test/reactivity/forwarder-host.spec.ts                # fixture: cohortEpoch [7]
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts        # fixture: cohortEpoch [9,9,9]
difficulty: easy
----

# Pin `cohortEpoch` / `prevEpoch` to 32 bytes across the cohort-topic wire

## What a "cohort epoch" is (plain terms)

A **cohort** is the small group of peers that jointly serve one slice of the distributed topic tree.
Its **epoch** is a short fingerprint of "who is in this group right now" — computed by hashing the sorted
member list. When membership changes, the epoch changes. It travels on the wire in several message types
so a receiver can tell which membership snapshot a message refers to.

## The gap

The wire decoder (`packages/db-core/src/cohort-topic/wire/validate.ts`) validates each `cohortEpoch`
field with `b64urlField` — which only checks "is this valid base64url", **not** how many bytes it decodes
to. A hostile peer can therefore put an arbitrarily large value (e.g. 1 MiB) in a `cohortEpoch` field.
That value then becomes a key in in-memory maps (the rotation-state `epochKey` index in
`packages/db-p2p/src/cohort-topic/host.ts`, plus store / replay-guard structures), so it can bloat memory —
the same class of hazard the parent ticket (`2-cohort-topic-wire-hardening`) fixed for `topicId` /
`correlationId` by switching them to `b64urlFixedLen(..., 32, ...)`.

## Why it wasn't fixed in the parent ticket

The parent's implementer tried to pin `cohortEpoch` but a test fixture broke, and — following the parent
ticket's own rule ("if a fixture breaks on a field you pinned, revert it and note it") — reverted it and
flagged the width question to the reviewer.

**The reviewer confirmed the width during review:** in real (non-test) code the epoch IS a fixed 32-byte
value. `packages/db-p2p/src/cohort-topic/host.ts:660` computes it as
`hash.H(new TextEncoder().encode(epochInput))`, where `hash.H` is db-core's SHA-256 ring hash → always 32
bytes. Every real path and every *round-trip* wire fixture already uses 32 bytes. The only values that are
not 32 bytes are lazy synthetic placeholders (`new Uint8Array([7])`, `[9,9,9]`) in tests where the epoch's
width is irrelevant to what the test asserts (member-subset staleness, signer-subset checks).

So the fix is safe — it was left out of the parent only because the true blast radius (7 fixtures across
**two** packages, one a slow real-libp2p integration test) was larger than the parent's db-core-only scope
and its "just fix one fixture" premise. Hence this separate, tracked ticket.

## The work

1. In `validate.ts`, switch these `cohortEpoch` fields from `b64urlField` to
   `b64urlFixedLen(..., COORD_BYTES, ...)` (COORD_BYTES = 32, already defined in the file):
   - `validateRegisterReplyV1` (optional — guard stays `if (cohortEpoch !== undefined)`)
   - `validateRenewReplyV1` (optional)
   - `validatePromotionNoticeV1`
   - `validateDemotionNoticeV1`
   - `validateCohortGossipV1`
   - `validateSignRequestV1`
   - `validateMembershipCertV1`

   and `prevEpoch` in `validateRotationAttestation` (also 32 bytes — it is a prior `cohortEpoch`).
   Remove the `NOTE:` markers pointing at this ticket once done.

2. Widen every non-32-byte `cohortEpoch` test fixture to 32 bytes (keep the placeholder value, just
   pad — e.g. `new Uint8Array(32).fill(7)` — since none of these tests assert the epoch value):
   - db-core: `test/reactivity/subscriber.spec.ts`, `test/reactivity/checkpoint.spec.ts`,
     `test/reactivity/resume.spec.ts`
   - db-p2p: `test/cohort-topic/invalidation-notification.spec.ts`,
     `test/cohort-topic/reactivity-real-crypto.spec.ts`, `test/reactivity/forwarder-host.spec.ts`,
     `test/substrate-real-libp2p.integration.spec.ts` (`[9,9,9]`)

   Note: only fixtures that round-trip through `encodeCohortMessage` → decode actually break on the pin
   (that's the wire path). Ones that inject the cert object directly into a verifier/cache never hit the
   decoder — but widen them anyway for consistency and to future-proof.

3. Add a dedicated over-length rejection test for a `cohortEpoch` field (e.g. on `MembershipCertV1`) in
   `packages/db-core/test/cohort-topic/wire.spec.ts`, mirroring the parent ticket's over-length
   `topicId` / `correlationId` tests, to lock the new pin in.

4. Run **both** `yarn workspace @optimystic/db-core test` and `yarn workspace @optimystic/db-p2p test`
   green. The db-p2p real-libp2p integration test can be slow — stream its output.

## Related consistency note (optional, decide while here)

`ChildLinkV1.cohortEpoch` is *already* pinned to 32 (pre-existing, from parent-child-link work). Pinning
the rest removes the current asymmetry where `ChildLinkV1` is the only epoch-pinned type. `topicId` on
`CohortTopicSummary` and `childCohortCoord` on `ChildLinkRefV1` are 32-byte in all fixtures but left
lenient by the parent's curated pin list — a reviewer could pin those for consistency too, but that is
independent of the epoch work.
