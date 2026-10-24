description: A machine watching many tables renews each table's subscription with its own network request every 20–30 seconds, so when another machine holds those subscriptions the idle traffic still grows with the number of tables. Renewals headed for the same machine could travel together.
files: packages/db-core/src/cohort-topic/registration/renewal.ts (`pingLoop`, `RenewalParticipantTransport`), packages/db-core/src/cohort-topic/service.ts (`renew`), packages/db-p2p/src/reactivity/collection-watch.ts (`ReactivityCollectionWatch`), packages/db-p2p/src/cohort-topic/host.ts (`RenewV1` handling)
tradeoffs: It needs a new multi-registration renew frame on the cohort-topic register protocol (each `RenewV1` is signed per registration and answered per registration), and the saving is only for registrations whose primary is another machine, which on a two-member group is about half of them.
----
# Subscription renewals to one cohort member share a request

Found while planning `the-reactivity-backstop-check-costs-nothing-while-idle` (GitHub [#48](https://github.com/gotchoices/Optimystic/issues/48)), which batches the watch service's per-tick tail reads into one read. Renewals were left at one per collection on purpose — the issue asked that their cadence stay at TTL / 3, and it measured only the tail reads.

## Today

Each watched collection has its own cohort-topic registration. On every tick (TTL / 3: 30 s Core, 20 s Edge) the watch service renews each one (`ReactivitySubscriptionManager.renew` → `CohortTopicService.renew` → `RenewalParticipant.pingLoop`), which sends one signed `RenewV1` to that registration's slot primary and reads its reply. Slots are spread over the root group's members by `H(participantId ‖ cohortEpoch) mod k`, so on a two-member group roughly half a node's registrations have the other machine as primary. Eighteen watched tables on an edge phone: about nine renew requests per 20 s, or ~27 a minute, after the tail-read batching has brought those down to ~6. (Static reading; the issue's capture counted only sync-protocol requests, so this number is not measured.)

## Expected

A node's renewals that share a primary at one tick go in one request, and the primary answers each registration in it as it answers a single `RenewV1` today (renewed, `primary_moved`, `unknown_registration`, `withdrawn`), so failover and re-walk per registration are unchanged. Cadence stays TTL / 3. A primary on an older build must still be renewable (fall back to single renews).
