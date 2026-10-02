description: When a machine checks a group-signed message, it used to accept a membership certificate describing a different group than the one the message claims to come from, so one dishonest machine could get a forged message accepted. The checker and the fetch that feeds it now refuse a certificate for any coordinate but the one asked about.
architecture: docs/cohort-topic.md#bootstrapping-trust
files: packages/db-core/src/cohort-topic/membership/verifier.ts, packages/db-core/test/cohort-topic/membership.spec.ts, packages/db-core/test/reactivity/subscriber.spec.ts, packages/db-p2p/src/cohort-topic/membership-source.ts, packages/db-p2p/test/cohort-topic/membership-source.spec.ts, docs/cohort-topic.md
difficulty: easy
repro: verified
----

# The membership verifier accepts a certificate for another coordinate — implemented

## What changed

- **Verifier (the security fix).** `CachingMembershipVerifier.loadFrom` (`packages/db-core/src/cohort-topic/membership/verifier.ts`) now takes the expected coordinate key (`coordKey` from `verifyMessage`) and, right after decoding, returns `undefined` when `cert.cohortCoord !== coordKey` — before the trust gate, before caching. Both loads (`current` and the single `fetch` refetch) and both threshold rules go through it, so a mismatch on `current` falls through to the refetch and a mismatch on the refetch yields `"untrusted"`. Module header step 2 and the `loadFrom` doc comment updated. `cache()` (self-published) untouched.
- **Membership source.** `FretMembershipSource.fetch` (`packages/db-p2p/src/cohort-topic/membership-source.ts`) decodes each reply (`decodeMembershipCertV1`) and caches/returns only one naming the requested coord; an undecodable reply (`CohortWireError`) or a wrong-coord reply is logged at debug and the next holder is asked. Other errors from decode are rethrown. The previously silent unreachable-holder catch now logs too. Logger reuses the existing `cohort-topic` namespace (a new sub-namespace would need a `docs/debugging.md` row per the log-namespace guard). `NOTE:` added at `has` — a cached cert is only checked to name the coord, not trusted. Signatures are not verified in the source.
- **Docs.** `docs/cohort-topic.md` §Bootstrapping trust: new paragraph "A cert counts only for the coordinate it names", citing both symbols. `yarn lint:docs` passes.

## Tests

- `membership.spec.ts` › trust anchoring › "refuses a self-consistent cert that names another coord, and does not cache it there" — the reproduction: anchor `"rejected"` for COORD, `"unknown"` otherwise; source returns a self-consistent adversary cert for an unrelated coord; `verifyMessage(adv signers, COORD)` must be `"untrusted"` (confirmed failing with `"verified"` when the check is disabled). Also asserts the foreign cert wasn't cached under its own coord (a follow-up verify for that coord hits `source.current` again).
- `membership-source.spec.ts` (existing) — the first case now includes a member answering with a cert for another coordinate, which must be skipped in favor of the next holder. The test's placeholder cert bytes (`{}`) were replaced with a real encoded cert, since fetch now decodes.
- `reactivity/subscriber.spec.ts` › "stale membership cache (real verifier path)" — **existing test fixed, not new**: its certs named the all-zero coord while the notification verifies at the tail's reactivity root, i.e. it passed only because of this defect. Certs now name `reactivityRootCoord(TAIL)`.

## Validation run

- `yarn build` db-core and db-p2p: clean. db-core `yarn test`: 1852 passing. db-p2p `yarn test`: all passing after the namespace fix (one run showed only the log-namespace guard failure, since fixed and re-run with the membership/log-namespace subset). Integration suite not run.

## For the reviewer

- Check whether any other caller/test relied on a cert naming a different coord than verified (grep found only the subscriber spec; integration specs `substrate-real-libp2p.integration.spec.ts` not run).
- Out of scope, owned by sibling `the-membership-protocol-serves-one-certificate-for-every-cohort-a-node-is-in`: `FretMembershipSource.cache(coord, encoded)` (host-fed path) still caches without checking the coord.
