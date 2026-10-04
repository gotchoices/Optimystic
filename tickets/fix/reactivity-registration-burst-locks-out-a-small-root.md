description: On a network smaller than wantK, when several machines register to watch a collection at nearly the same moment, the reactivity root pre-promotes and never demotes, so later watchers are redirected to a tier the network cannot form and are never pushed changes. Reported from sereus's real-network scenario.
repro: verified
files: packages/db-core/src/cohort-topic/promotion.ts (slopePredictsCrossing, promotionTriggered), packages/db-core/src/cohort-topic/walk.ts (RouterWalkEngine.register, promoted branch), packages/db-p2p/src/reactivity/collection-watch.ts (checkTail, tick, enqueue), packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts (DEFAULT_GOSSIP_INTERVAL_MS), docs/reactivity.md, docs/cohort-topic.md
----
# A burst of registrations locks later watchers out of a small root

**Reactivity: on a network smaller than `wantK`, a burst of registrations locks later subscribers out of the root**

Setup: 3 machines, `clusterSize` 2, `cohortTopic: { enabled: true }` with default `wantK`/`minSigs`, one collection watched on every machine through the quereus plugin's `optimystic.network_watch` tag; Optimystic 1.10.0.

When two subscribers' registrations land at a root under ~0.5 s apart (three under ~1 s), the root pre-promotes. `slopePredictsCrossing` extrapolates 2 participants to 64 within 30 s, and a tier-0 root never demotes. Every later registrant is redirected to tier 1, which needs 14 signatures from a 16-wide cohort, and a 3-machine network cannot form that cohort. The later machine's `watch` therefore retries every 30 s and fails each time with `CohortBackoffError: no willing primary right now`, and that machine gets no pushes. We never saw the tail rotate during these runs, so whether a new root clears the lock-out is untested.

This is the normal case for a new collection: every machine's watch opens before the first commit, and all of them register on the renewal tick after it. In our scenario 5 of 8 runs left one of three machines unregistered. Spacing the registrations 1 s apart avoided it in 20 of 20 runs; a 0 s spacing reproduced it in 2 of 2.

Seen once or twice in those runs, mechanism unconfirmed: a registered subscriber stopped being pushed ~90 s after registering, and the unregistered machine's 30 s tail-read wakes stopped after its third failed walk.

Possible directions, for you to judge: do not apply slope pre-promotion below some participant floor, or at all at a root-placed root; do not promote to a tier the network is too small to form; let a root demote.

Separately: for about one gossip interval after a registration lands, a commit announced only by the root member that does not hold the registration is delivered to nobody (3 of 13 runs when the commit came ~1 s after registration; 0 of 7 after a 10 s wait). If that window is expected, a line in `docs/reactivity.md` would help; subscribers do catch up at the next tail read.

Reproduction: `packages/integration-tests/src/scenarios/strand-reactivity-wakes-watchers.integration.ts` in gotchoices/sereus. Set `REGISTRATION_SPACING_MS` to 0 to see the lock-out.

## Evidence from sereus

`strand-reactivity-scenario` ran sereus's new `strandReactivity` option on a real network: one party, three machines, one strand at `strandClusterSize: 2`, one table tagged `"optimystic.network_watch" = true`, every strand node built with `cohortTopic: { enabled: true }` and no other cohort-topic tuning (so `wantK` 16, `minSigs` 14 for non-root tiers). Optimystic was the linked `v1.10.0` release (commit `34e607c6`, clean tree). Loopback, one Windows machine, 2026-10-03.

When every machine registers, push works well. Every watcher, including the machine outside the tail block's storage group, was woken within about 50 ms of the committing machine's insert returning. The problem is getting every machine registered.

- **Repro: verified.** With the tag declared in the sApp schema, every machine's watch opens at strand launch on an empty collection, so all three register on the same renewal tick after the first commit. In 5 of 8 runs one machine never registered: every 30 s its walk ended in `CohortBackoffError: cohort-topic: no willing primary right now`, and some engine's gossip tick logged `cohort threshold sign: gathered 3 of 14 required signatures` every 5 s.
- **Trigger: verified.** The scenario now turns the tag off, commits, and turns it back on one machine at a time. With a 0 ms gap between one registration landing and the next tag going on, the third machine never registered (2 of 2 runs). With 1 s, all three registered every time (20 of 20).
- **Mechanism: static (read from the code, not instrumented).** `PromotionLifecycle.slopePredictsCrossing` extrapolates the registration count over a 10 s window. Two registrations under ~484 ms apart (three within ~983 ms) predict 64 participants within 30 s, so the root pre-promotes, and a tier-0 root never demotes. The next registrant's walk follows `promoted` to tier 1, a non-root cohort that needs `minSigs` 14 of `wantK` 16. Three machines can never assemble that, so the walk backs off on every attempt. A `promote: untrusted promotion notice … tier 0` line appears in these runs. To confirm, instrument the root's promotion state, or rerun with `cap_promote` raised.

Further effects seen in the failing runs. Each was observed once or twice; the mechanisms are guesses.

- A registered machine stopped receiving pushes about 90 s after registering, while other watchers on the same root still got them. Guess: renewals at a promoted root stop landing, so the record expires at its TTL.
- The machine that never registered also stopped waking from the 30 s tail read: after its third failed walk, no further failure was logged and the round's commit went unseen for more than 35 s. Guess: a later walk never settled and stalled its subscription's serial queue (the `enqueue` NOTE in `collection-watch.ts`).

A separate, smaller gap, also verified. For a few seconds after the last registration lands, a commit can be pushed to nobody. In 3 of 13 runs whose first measured commit came about 1 s after the last registration, one root-group member announced the commit (a probe on `cohortTopicHost.service.onLocalCommit` saw the call) but no machine's `reactivitySubscribers.deliver` was called, not even the announcer's own. With a 10 s wait (two cohort gossip intervals) it never happened in 7 runs. Our reading: the registrations sat on the other root member and had not yet been gossiped. If that is by design, it only needs documenting; if not, the announcer could forward to the member that holds them.

## Downstream

sereus works around this in `strand-reactivity-wakes-watchers.integration.ts` (`REGISTRATION_SPACING_MS`, `RECORD_GOSSIP_SETTLE_MS`). When this ships, tell sereus the version so it can drop the workaround.
