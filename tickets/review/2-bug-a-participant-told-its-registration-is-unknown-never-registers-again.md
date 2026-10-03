description: A machine keeping a group subscription alive now treats the group's "we have no record of you" answer as a failed check-in, so after three in a row it recovers by re-attaching to a backup or subscribing again, and when it subscribes again it adopts where that new subscription landed instead of throwing it away.
architecture: docs/cohort-topic.md#ttl-and-renewal
files: packages/db-core/src/cohort-topic/registration/renewal.ts, packages/db-core/src/cohort-topic/service.ts, packages/db-core/test/cohort-topic/registration.spec.ts, packages/db-core/test/cohort-topic/service.spec.ts, packages/db-p2p/src/reactivity/collection-watch.ts, packages/db-p2p/src/reactivity/subscription-manager.ts, packages/db-p2p/src/cohort-topic/host.ts, docs/cohort-topic.md, docs/internals.md, packages/substrate-simulator/src/registration.ts
repro: verified
----
# Review: an "unknown registration" renewal reply now counts as a failed ping, and a re-walk's landing is adopted

## What changed

**Participant (`TtlRenewalParticipant`, `packages/db-core/src/cohort-topic/registration/renewal.ts`).**

- `pingLoop` now hands a reply to `acceptPingReply`, an exhaustive `switch` over `RenewReplyV1.result` with a `never`-typed default: `ok` resets the failure count; `primary_moved` resets it and runs `applyPrimaryMoved`; `unknown_registration` and `withdrawn` return `false`. A `false` and a thrown send both go to `strike()`, which counts one failure and runs the existing `failover` on the third in a row. The wire validator (`validateRenewReplyV1`) already rejects any other result, so the default's throw is unreachable at runtime; it is there so a fifth result fails to compile.
- `RenewalParticipantTransport.relookup()` now resolves `RenewalAssignment | undefined` — `{ primary, backups, cohortEpoch, correlationId }` of an accepted re-walk, or `undefined` when the walk was not accepted. On a defined result the participant's private `adopt` replaces `current.primary`, `current.backups`, `current.lastPing`, the epoch hint and the correlation id it stamps on later renews (the correlation id moved from a constructor dep read on each send to participant state seeded from that dep).
- `failover` resets `consecutiveFailures` in a `finally` around the relookup, so a throwing relookup is backed off like a refused one; the throw still propagates out of `pingLoop`/`renew`.
- Module header comment rewritten to say what each reply does and why the re-walk is rate-limited.

**Service (`WalkRegisterService`, `packages/db-core/src/cohort-topic/service.ts`).**

- New private `WalkLanding` (`treeTier`, `cohortMembers`, `topicTraffic`) stored on the `LiveRenewal` entry beside the root-key slot, seeded from the register's hint.
- The `relookup` closure in `renewalTransport` builds the hint with the existing `hintFromReply`, writes the three hint-only fields into the landing, and returns the participant-level assignment with the walk's `correlationId`. A non-accepted outcome returns `undefined`. An accepted reply missing `primary`/`cohortEpoch` still throws `CohortBackoffError` out of `hintFromReply`, as it does at register time.
- `syncHandle` now also copies `treeTier`, `cohortMembers` and `topicTraffic` from the landing onto the handle. Primary, backups and epoch still come from the participant's record (it remains the authority because later `primary_moved` replies change them without a walk). `moveRoot` is unchanged.

**db-p2p.** Removed the `NOTE:` in `ReactivityCollectionWatch.renew` (`collection-watch.ts`). Replaced the `NOTE:` above `ReactivitySubscriptionManager.followTail` (`subscription-manager.ts`) with one sentence saying `treeTier` now tracks a re-walk's landing — nothing in the old note stayed true. Reworded the `resolveRenew` comment in `packages/db-p2p/src/cohort-topic/host.ts` to say the participant counts the reply as a failed ping.

**Docs.** `docs/cohort-topic.md` § TTL and renewal: one bullet per reply, the relookup bullet now says the landing is adopted and the count resets, and a new "Why an `unknown_registration` waits for three strikes" note (one-TTL recovery cost, the replication-lag case, the per-peer register rate limit, how collection watches and matchmaking providers live through the gap). The wire section's `RenewReplyV1` result list gained `"withdrawn"`, and `RenewV1` gained the `withdraw?` field the doc's own "Landed since" note already pointed at. `docs/internals.md` § Registration-record lifecycle, "TTL renewal" bullet, updated.

## Tests added

- `registration.spec.ts`, "counts an unknown_registration answer as a failed ping: the third in a row fails over" — the bug's reproduction: every send answered `unknown_registration`; after two pings no re-attach and no relookup, after the third both backups are re-attached and `relookup` runs once. `MockParticipantTransport.relookup` now returns a settable `landing` (default `undefined`).
- `registration.spec.ts`, "adopts the assignment a relookup lands: later pings go to its primary under its correlationId" — primary and backups fail, the relookup returns a new assignment; the epoch hint changes, the next ping goes to the new primary carrying the new correlation id, and no further relookup happens.
- `service.spec.ts`, "CohortTopicService / renewal re-walk" — register lands at tree tier 1 (`d_max` is 1 for the mocked size estimate); the router then answers `no_state` above tier 0 and an accepted reply with a different primary and epoch at tier 0; after three failed renews the handle's `treeTier`, `primary` and `cohortEpoch` are the re-walk's.

## Validation run

- `yarn test` in `packages/db-core`: 1858 passing. `yarn test` in `packages/db-p2p` (after rebuilding db-core): 3200 passing, 65 pending. `yarn lint:docs`: all resolve. eslint on the changed files: clean.
- Also ran `test/substrate-real-libp2p.integration.spec.ts` (db-p2p, 13 passing) and `test/network-change-notification.integration.spec.ts` (quereus-plugin-optimystic, 1 passing) with `OPTIMYSTIC_INTEGRATION=1`, since they renew registrations over real sockets. The rest of `yarn test:integration` was not run.

## Known gaps for the reviewer

- **The design simulator still models the rejected alternative.** `ParticipantRenewal.onReachablePrimary` in `packages/substrate-simulator/src/registration.ts` re-runs the lookup on the first `unknown_registration`. The simulator claims to model `docs/cohort-topic.md` §TTL and renewal, which now says three strikes. Not changed here: the simulator's cohort answers `unknown_registration` for "whole cohort unreachable" too, and its `reattach` path assumes a reachable backup holds the record, so aligning it needs a look at what its churn scenario counts (`churn.reLookups`). Decide whether to align it or file it.
- **A re-walk re-sends the first registration's `appPayload`** (`req.appPayload` in the `relookup` closure). For a collection watch that payload carries `tailIdAtAttach` and `lastKnownRev` from the first registration, so a re-walk registers with a stale starting revision. This is unchanged behaviour, but the re-walk now runs in more situations. Effects seen by the subscriber look limited to duplicates the manager already drops, but this was not traced through the forwarder.
- **No test for the `finally` reset on a throwing relookup.** The ticket limited the tests to the three above; the reset is a two-line `try/finally` in `failover`.
- `RegistrationRecord.attachedAt` on the participant side is not updated when a re-walk is adopted (only `primary`, `backups`, `lastPing`), per the ticket's shape; nothing on the participant side reads it.
