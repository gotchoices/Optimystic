description: An explicit withdraw tombstone (ttl=0 / dedicated wire message) so CohortTopicService.withdraw() proactively frees remote cohort soft-state instead of waiting for TTL expiry. The local renewal-stop half already works; this is the remote half.
files:
  - packages/db-core/src/cohort-topic/service.ts (withdraw() — currently only drops the local handle)
  - packages/db-core/src/cohort-topic/registration/renewal.ts (a withdraw/tombstone path on the cohort side)
  - packages/db-core/src/cohort-topic/wire/types.ts (a WithdrawV1 message, or ttl=0 RenewV1 semantics)
  - packages/db-p2p/src/cohort-topic/host.ts (handle the tombstone; evict + gossip)
  - packages/db-core/src/cohort-topic/gossip/bus.ts (propagate the eviction)
----

# Cohort-topic: withdraw tombstone (remote half)

`CohortTopicService.withdraw(handle)` currently only deletes the local renewal handle, so the
participant stops pinging and the cohort soft-state TTL-expires (default 90 s) on its own. The review
fix made the local renewal-stop correct (a withdrawn handle's `renew()` is a no-op). What is missing
is the **remote** half: a proactive signal that frees the cohort record immediately rather than
holding it for up to a full TTL.

## Requirement

A withdraw signal — either a dedicated `WithdrawV1` message on the register protocol, or `ttl = 0`
semantics on a signed `RenewV1` — that the primary (and via gossip, the backups) treats as an
immediate eviction: drop the record, count it out of traffic, and gossip the eviction so the cohort
converges (reusing the existing `RenewalGossip.evicted` + bus eviction-convergence path). Must be
signed by the participant peer key (sibling of the `reattach` attestation) so a third party cannot
evict someone else's registration.

`service.ts`'s `withdraw()` doc note references this as the documented follow-on. Lower urgency than
the lookup-probe RPC since TTL expiry already bounds the leak.

## End
