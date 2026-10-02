description: When a machine checks a group-signed message, it used to accept a membership certificate describing a different group than the one the message claims to come from, so one dishonest machine could get a forged message accepted. The checker and the fetch that feeds it now refuse a certificate for any coordinate but the one asked about.
architecture: docs/cohort-topic.md#bootstrapping-trust
files: packages/db-core/src/cohort-topic/membership/verifier.ts, packages/db-core/test/cohort-topic/membership.spec.ts, packages/db-core/test/reactivity/subscriber.spec.ts, packages/db-p2p/src/cohort-topic/membership-source.ts, packages/db-p2p/test/cohort-topic/membership-source.spec.ts, docs/cohort-topic.md
difficulty: easy
repro: verified
----

# The membership verifier accepts a certificate for another coordinate — complete

## What landed (`ticket(implement): membership-verifier-accepts-a-certificate-for-another-coordinate`)

- `CachingMembershipVerifier.loadFrom` (`packages/db-core/src/cohort-topic/membership/verifier.ts`) takes the coordinate being verified and treats a decoded cert whose `cohortCoord` differs as no cert: it is never passed to the trust gate and never cached. Both loads (`current` and the single refetch) go through this check.
- `FretMembershipSource.fetch` (`packages/db-p2p/src/cohort-topic/membership-source.ts`) decodes each reply. If a reply won't decode or names another coordinate, it is logged and the next holder is asked. An unreachable holder is now logged rather than silently skipped.
- `docs/cohort-topic.md` §Bootstrapping trust has a new paragraph: "A cert counts only for the coordinate it names".
- Tests: a reproduction in `membership.spec.ts`; the fetch spec now also covers a holder answering with another coordinate's cert; and the subscriber spec's certs were fixed to name the coordinate the notification is verified at, since that test had only passed because of this defect.

## Review findings

- **Diff read first.** The coordinate check sits inside the `try`, before `certIsTrusted`. So `lockedUnderAnotherRule` and the `byCoord.set` that run after it only ever see `cert.cohortCoord === coordKey`. This also makes the existing keying by the cert's own `cohortCoord` equivalent to keying by `coordKey`. Correct; nothing changed.
- **Error handling.** In `fetch`, `decodeMembershipCertV1` reports every malformed frame as `CohortWireError`, including bad JSON (read `decodeCohortMessage` in `packages/db-core/src/cohort-topic/wire/codec.ts`). A hostile reply is therefore skipped rather than aborting the fetch, and only unexpected errors are rethrown. An empty "no certificate" reply fails to decode and is skipped, as before. No change needed.
- **Other callers and consumers.** `decodeMembershipCertV1` is used only in these two places. I also checked every test that builds a `cohortCoord`, including `substrate-real-libp2p.integration.spec.ts`: the certs all name the coordinate they are verified at, apart from the subscriber spec, which the implementer already fixed.
- **Out of scope, already owned.** The host-fed `FretMembershipSource.cache(coord, encoded)` path still caches without checking the coordinate. That belongs to the open sibling `the-membership-protocol-serves-one-certificate-for-every-cohort-a-node-is-in`. The verifier's new check covers it in the meantime, because whatever that cache serves is still refused unless it names the coordinate. No new ticket.
- **Tests.** The reproduction test pins a security contract with real branching: it was confirmed to fail without the check, and it also asserts the cert is not cached under its own coordinate. The extended fetch case covers the new skip path. Both are kept and no tests were cut. No new tests: no defect found.
- **Docs.** The doc paragraph and the module header and `loadFrom` comments describe the new behaviour accurately. `yarn lint:docs` passes.
- **Hygiene.** The new comments explain why the check exists, not what each statement does. The `NOTE:` at `has` is a tripwire saying the cache is an existence hint, not a trust decision; it stays. Logging uses the existing `cohort-topic` namespace, which the log-namespace guard requires. Files are small.
- **Validation.**
  - db-core `yarn test --grep "membership|subscriber|reactivity"`: 267 passing.
  - db-p2p `yarn test --grep "membership|cohort-topic|reactivity|log namespace"`: 519 passing, 21 pending.
  - `OPTIMYSTIC_INTEGRATION=1` `substrate-real-libp2p.integration.spec.ts`: 13 passing, 2 pending. These pending tests are marked pending in the spec itself, not by this change.
  - eslint on the changed source files is clean, and `yarn lint:docs` is clean.
  - The implementer's full db-core and db-p2p `yarn test` runs were green, and I did not repeat them.
- **Major findings, tripwires and declined findings:** none.
