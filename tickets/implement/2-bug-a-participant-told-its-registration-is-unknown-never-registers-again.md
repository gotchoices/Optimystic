description: A machine subscribed to a group keeps sending "I am still here" messages, and when the group answers "we have no record of you" it treats that as a normal reply, so it stays unsubscribed for good while believing it is subscribed; and when it does fall back to subscribing again, it throws away where the new subscription landed.
architecture: docs/cohort-topic.md#ttl-and-renewal
files: packages/db-core/src/cohort-topic/registration/renewal.ts, packages/db-core/src/cohort-topic/service.ts, packages/db-core/test/cohort-topic/registration.spec.ts, packages/db-core/test/cohort-topic/service.spec.ts, packages/db-p2p/src/reactivity/collection-watch.ts, packages/db-p2p/src/reactivity/subscription-manager.ts, packages/db-p2p/src/cohort-topic/host.ts, docs/cohort-topic.md, docs/internals.md
repro: verified
----
# A renewal answered "unknown registration" is treated as a successful renewal

## Background

A participant (a machine registered with a cohort under a topic — a collection watch, or a matchmaking provider) keeps its registration alive by pinging its primary cohort member every third of the registration's lifetime (TTL). The driver is `TtlRenewalParticipant` in `packages/db-core/src/cohort-topic/registration/renewal.ts`; the service that owns it is `WalkRegisterService` in `packages/db-core/src/cohort-topic/service.ts`. A member answers a ping with one of the four `RenewReplyV1.result` values (`packages/db-core/src/cohort-topic/wire/types.ts`): `ok`, `primary_moved`, `unknown_registration`, `withdrawn`.

Today `pingLoop` sends the ping through `trySend`, which maps only a *thrown* send to `undefined` (a counted failure). Any reply at all goes to `onPingSuccess`, which resets the failure counter and acts only on `primary_moved` with an `if`. So `unknown_registration` is handled exactly like `ok`. The three-failure path (`failover`: re-attach each backup, then `transport.relookup()` re-runs the register walk) is entered only when the primary does not answer.

## Reproduction (run during the fix stage)

A participant built with `createRenewalParticipant` whose transport answers every send with `{ v: 1, result: 'unknown_registration' }`: after ten `pingLoop()` calls there were ten plain pings, zero re-attaches and zero `relookup` calls. The spec was a scratch file and was deleted; the test below in the TODO list is its permanent form.

## How a cohort comes to not hold the record

- The member restarted (records are in memory).
- A withdraw for a closed collection watch landed after a newer registration of the same topic by the same participant replaced the record (see the `NOTE:` in `ReactivityCollectionWatch.renew`, `packages/db-p2p/src/reactivity/collection-watch.ts`).
- The record expired while renewals were not getting through, and then the link recovered.
- Replication lag (benign, transient): the member that admits a register is not necessarily the computed primary (`CohortMemberEngine.accept` in `packages/db-core/src/cohort-topic/member-engine.ts` stores the record locally and the primary learns it by gossip, every 5 s by default). With the minimum TTL of 10 s the first ping goes out at about 3.3 s, so the primary can honestly answer `unknown_registration` once.

## Decision: an "unknown" reply counts as a failed ping

`unknown_registration` (and `withdrawn`, which a correct member never sends to a plain ping and which also means "no record here") counts as a strike on the same `consecutiveFailures` counter that silence uses. After `MAX_PING_FAILURES` (3) strikes in a row the existing `failover` runs: re-attach each backup (a backup that holds the record and is a computed backup promotes itself — the restart case recovers here), then `relookup` (the withdraw-race and expiry cases recover here).

Rejected alternative: fail over on the first `unknown_registration`. It recovers up to two ping intervals sooner, but it has no backoff — under the replication-lag case above, or when a relookup does not get accepted, it would re-run the register walk on every ping, which for short TTLs exceeds the cohort's limit of four register frames per peer per topic per minute (`docs/cohort-topic.md` § Anti-DoS, "Per-peer rate limits per cohort") and turns a benign lag into rate-limit refusals. Counting strikes reuses the existing backoff (at most one relookup per three pings, i.e. about one per TTL) and lets a one-off lag answer clear itself. Cost: a lost registration is re-made about one TTL later (90 s at the default) rather than one ping later. For collection watches the watch service's tail check covers that gap; for matchmaking providers it is a one-TTL absence from seeker results.

## Second arm, same site: a re-walk's result is thrown away

`renewalTransport`'s `relookup` in `service.ts` runs `this.walk.register(...)` and discards the outcome. The participant keeps the old primary/backups/epoch hint and the old `correlationId`, so if the walk landed at a different cohort the next three pings fail again and the walk re-runs; and the handle's `treeTier` keeps the tier of the original registration (the `NOTE:` above `followTail` in `packages/db-p2p/src/reactivity/subscription-manager.ts` records the consequences). With the first arm, `relookup` runs more often, so it must adopt the walk's answer.

Shape (recommended, implementer may refine):

- `RenewalParticipantTransport.relookup()` resolves the new assignment, or `undefined` when the walk was not accepted (`retry_later` / `promoted` outcome): e.g. `{ primary, backups, cohortEpoch, correlationId }` — participant-level fields only; `treeTier` is a service concept and stays out of `renewal.ts`.
- On a defined result the participant replaces `current.primary`, `current.backups`, `current.lastPing`, its epoch hint, and the `correlationId` it stamps on later renews (it is a constructor dep today; make it participant state). On `undefined` it keeps the old record — the counter reset after relookup already rate-limits the retry.
- The service's `relookup` closure builds the hint with the existing `hintFromReply` and records the hint-only fields (`treeTier`, `cohortMembers`, `topicTraffic`) in the per-registration `LiveRenewal` entry (beside the `root` slot), and `syncHandle` copies them onto the handle along with what it copies today. Primary/backups/epoch keep coming from the participant's record, which stays the authority because later `primary_moved` replies change it.

## Related observation (fix while in `failover`)

If `relookup` throws (for example the walk's unguarded direct dial, backlog `bug-walk-direct-dial-failure-aborts-register`), `failover` exits before resetting `consecutiveFailures`, so every following ping re-enters failover and re-walks. Reset the counter in a `finally` so a throwing relookup is backed off like a refused one; the throw still propagates to the caller of `renew`, which already logs it (`ReactivityCollectionWatch.renew`).

## TODO

- In `TtlRenewalParticipant` (`renewal.ts`), replace `onPingSuccess`'s `if` with an exhaustive `switch` over `RenewReplyV1.result` (a `never`-typed default so a fifth result fails to compile): `ok` → reset strikes; `primary_moved` → reset + `applyPrimaryMoved`; `unknown_registration` and `withdrawn` → count a strike and fall into the same three-strike path as a thrown send (restructure `pingLoop` so both share one "strike, then maybe `failover`" step).
- Change `RenewalParticipantTransport.relookup` to resolve the adopted assignment or `undefined`; have the participant adopt it (primary, backups, lastPing, epoch hint, correlationId). Reset `consecutiveFailures` in a `finally` around the relookup.
- In `service.ts`, have the `relookup` closure return the accepted walk's assignment, store `treeTier` / `cohortMembers` / `topicTraffic` on the `LiveRenewal` entry, and have `syncHandle` copy them to the handle. Keep `moveRoot`'s root slot behaviour unchanged.
- Update the module header comment in `renewal.ts` (the bullet list) to say what each reply does.
- Tests (keep to these):
  - `registration.spec.ts`, renewal participant: a transport answering every plain ping `unknown_registration` (and backups' re-attach `unknown_registration`) → after two pings no re-attach and no relookup, after the third the backups are re-attached and `relookup` runs once. This is the bug's reproduction. Update `MockParticipantTransport.relookup` to the new signature.
  - `registration.spec.ts`: a relookup that resolves a new assignment is adopted — the next ping goes to the new primary and carries the new `correlationId`.
  - `service.spec.ts`: after a renewal re-walk that lands at a different tree tier and primary, the handle's `treeTier` and `primary` reflect the re-walk (the `moveRoot` test's router is a template: `dialMember` throws, `routeAndAct` returns an accepted reply — make the accepted reply differ from the first one).
- Remove the two `NOTE:` comments that describe this bug: in `ReactivityCollectionWatch.renew` (`packages/db-p2p/src/reactivity/collection-watch.ts`) and above `followTail` (`packages/db-p2p/src/reactivity/subscription-manager.ts`); keep any part of the latter that remains true after the fix.
- Check the comment on `resolveRenew` in `packages/db-p2p/src/cohort-topic/host.ts` now matches what the participant does (it should, once the fix lands).
- `docs/cohort-topic.md` § TTL and renewal: add what a participant does with each reply (`ok`, `primary_moved`, `unknown_registration`/`withdrawn` counted as failures, the three-strike failover, relookup adopting the new primary/backups/epoch/tree tier), including the one-TTL recovery cost and why it is not immediate (rate limit, replication lag). Also add `"withdrawn"` to the `RenewReplyV1` result list in that document's wire section, which omits it.
- `docs/internals.md` § Registration-record lifecycle, the "TTL renewal" bullet: mention that an `unknown_registration` reply counts toward the three failures and that the relookup's landing is adopted.
- Run `yarn test` in `packages/db-core` and `packages/db-p2p` (rebuild db-core first so db-p2p's build-freshness guard passes), and `yarn lint:docs` from the root.
