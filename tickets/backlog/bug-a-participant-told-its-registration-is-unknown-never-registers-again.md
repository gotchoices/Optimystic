description: A machine that has subscribed to a group (to hear a collection's change announcements, or to be listed as a matchmaking provider) keeps sending "I am still here" messages; when the group answers "we have no record of you", the machine treats that as a normal reply and carries on, so it stays unsubscribed for good while believing it is subscribed.
architecture: docs/cohort-topic.md#ttl-and-renewal
files: packages/db-core/src/cohort-topic/registration/renewal.ts, packages/db-core/src/cohort-topic/service.ts, packages/db-core/test/cohort-topic/registration.spec.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/reactivity/collection-watch.ts, docs/cohort-topic.md
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: For collection watches the periodic tail check still wakes the watcher within one interval, so the visible cost there is slower wakes rather than missed ones; a maintainer may defer this until matchmaking providers, which have no such fallback, are in real use.
----

# A renewal answered "unknown registration" is treated as a successful renewal

## What happens

A participant keeps a registration alive by pinging its primary cohort member every third of the registration's lifetime (`TtlRenewalParticipant.pingLoop` in `packages/db-core/src/cohort-topic/registration/renewal.ts`). The member answers with one of `ok`, `primary_moved`, `unknown_registration` or `withdrawn` (`RenewReplyV1` in `packages/db-core/src/cohort-topic/wire/types.ts`).

`pingLoop` treats *any* reply that arrives as success: it calls `onPingSuccess`, which resets the failure counter and acts only on `primary_moved`. An `unknown_registration` reply — the member saying it holds no record for this participant under this topic — is therefore indistinguishable from `ok`. The three-failure path that tries the backups and then re-registers (`failover`, ending in `transport.relookup()`) is entered only when the ping gets no reply at all.

So once a cohort no longer holds a registration and its primary is still reachable, the participant pings forever, is told every time that it is unknown, and never registers again.

The cohort side was written expecting otherwise. The comment on `resolveRenew` in `packages/db-p2p/src/cohort-topic/host.ts` says it replies `unknown_registration` "so the participant's failover loop tries its backups and ultimately re-runs the `d_max` lookup". `docs/cohort-topic.md` § TTL and renewal does not say what a participant does with this reply.

This was read from the code, not reproduced. A test that would confirm it: a `createRenewalParticipant` whose transport answers every plain ping with `{ result: 'unknown_registration' }`; after any number of `pingLoop()` calls, `relookup` has not been called and no re-attach was sent.

## How a cohort comes to not hold the record

- **The member restarted.** Registration records are in memory. Whether the other members' gossip restores the record on the restarted primary before the next ping was not checked.
- **A withdraw landed after a newer registration of the same topic by the same participant.** Found while reviewing the collection watch service (`ReactivityCollectionWatch` in `packages/db-p2p/src/reactivity/collection-watch.ts`): close a watch while its first registration is in flight, then open it again. The first registration lands, the service withdraws it (as it must), and that withdraw can reach the cohort after the second registration has replaced the record. The cohort's freshness check (`isFreshPrivileged` in `renewal.ts`) accepts the withdraw when it was signed after the second registration was stamped, and evicts the record the second watch depends on.
- **The record expired** because renewals were not getting through for longer than its lifetime, and then the link recovered.

## What it costs

- **Collection watches:** the watcher stops receiving announcements for that collection until its log starts a new tail block (every 32 commits), which makes the watch service register under a new topic. Meanwhile the service's periodic tail check still wakes the watcher, up to 30 s late on a Core node. A `NOTE:` at `renew` in `collection-watch.ts` records this.
- **Matchmaking providers:** a provider whose record is gone is no longer returned to seekers, and nothing brings it back while its primary stays reachable. Read from the code; the provider manager renews through the same `CohortTopicService.renew`.

## What is wanted

A participant that is told its registration is unknown ends up registered again without the application having to notice: by trying its backups (replication lag on one member is the benign case) and then re-running the register walk, the way an unreachable primary already does. Whether one `unknown_registration` reply is enough or it should take several in a row is part of the work; a member that restarted will answer the same way every time, and a re-registration is rate-limited by the cohort (four register frames per peer per topic per minute).

The reply handling should make a missing case impossible to write: `onPingSuccess` branches on one of four reply kinds with an `if`, which is how this one went unhandled. An exhaustive `switch` over `RenewReplyV1.result` would have failed to compile.

`docs/cohort-topic.md` § TTL and renewal should say what a participant does with each reply.

## Second arm, same site: a re-walk's result is thrown away

Found while planning `cohort-topic-a-topics-root-can-move`. When the renewal falls back to re-registering (`relookup` in `renewalTransport`, `packages/db-core/src/cohort-topic/service.ts`), it runs the register walk and discards the outcome: the participant's renewal record keeps the failed primary and backups, so the next three pings fail again and the walk re-runs, and the handle's tree tier (added by that ticket) keeps the tier of the original registration. Read from the code, not reproduced. A fix to the unknown-registration path will call `relookup` more often, so it should make `relookup` adopt the accepted walk's primary, backups, epoch and tree tier.
