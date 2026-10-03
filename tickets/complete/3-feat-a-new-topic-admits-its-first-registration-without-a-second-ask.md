description: The first machine to subscribe to a newly watched collection used to be told "not yet, ask again" and got in about half a minute later; the group serving the subscription now asks its members whether they are willing at once, waits a moment for their answers, and accepts the subscription in the same request.
architecture: docs/cohort-topic.md#cold-start-instantiation
files: packages/db-core/src/cohort-topic/willingness.ts, packages/db-core/src/cohort-topic/member-engine.ts, packages/db-p2p/src/cohort-topic/cold-quorum-wait.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts, packages/db-p2p/src/cohort-topic/index.ts, packages/db-p2p/src/reactivity/collection-watch.ts, packages/db-core/test/cohort-topic/willingness.spec.ts, packages/db-core/test/cohort-topic/member-engine.spec.ts, packages/db-p2p/test/cohort-topic/cold-quorum-wait.spec.ts, packages/db-p2p/test/cohort-topic/live-tier.spec.ts, docs/cohort-topic.md, docs/reactivity.md
----

# A new topic admits its first registration without a second ask

## What was built

A group of machines serving a topic (a "cohort") counts willing members from gossip. A cohort that has only just started serving a topic has heard nobody, so the member a first registration lands on used to count only itself, fall short of the quorum and decline; the subscriber got in on its next 30-second tick.

The willingness check now tells "my members said no" apart from "I have not heard from my members yet" (`awaitingMembers` on `UnwillingCohortOutcome` in `packages/db-core/src/cohort-topic/willingness.ts`: the quorum is short, and would be met if every member with no entry in the gossip view turned out willing). In the second case the member engine (`decideOnceMembersAnswer` in `packages/db-core/src/cohort-topic/member-engine.ts`) holds the request on an injected `QuorumWait` and then decides again, once, at the time the wait settled.

The host supplies the wait (`createColdQuorumWait` in `packages/db-p2p/src/cohort-topic/cold-quorum-wait.ts`): one shared wait per engine, opened by broadcasting the engine's own willingness immediately (`advertiseWillingness` in `packages/db-p2p/src/cohort-topic/host.ts`), settled as answering frames merge or after `coldQuorumWaitMs` (default 2 s, `0` disables). A member that receives that broadcast with no state for the topic creates it and, because it is hearing the sender for the first time, broadcasts its own willingness straight back. The wait is offered only on a tier-0 engine of a host with a signing key; only an idle engine sends the advert, at most once per gossip interval, and when it may not send one no wait opens.

Measured on a three-machine mesh over real sockets (implement stage, 42 runs): the cohort answered the cold-start register `accepted` within 22–111 ms on the first ask every time. The subscriber's `watch()` → attached time was 0.26–16.7 s (median 3.0 s), nearly all of it the subscriber computing the proof of work a cold-start register must carry. That is tracked separately in `tickets/backlog/bug-first-registration-proof-of-work-freezes-the-node-for-seconds.md`.

Known limits, each documented in `docs/cohort-topic.md` §Cold-start instantiation or by a `NOTE:` at the site:

- A register landing on a sibling in the few milliseconds between that sibling sending its own advert and the others' answers arriving finds the advert throttled, so no wait opens and it is declined as before.
- A member that restarts is not "heard for the first time" by siblings whose engines outlived it, so its first register after the restart waits on their 30-second heartbeat (`NOTE:` at the first-heard handler in `host.ts`).
- A register re-decided after a wait redirects when the topic reads as promoted; a cold-path register that did not wait is still admitted without that check.
- Test meshes park `gossipIntervalMs` at one hour, so in a mesh test an engine sends at most one advert per test.

## Review findings

Reviewed the diff of `ticket(implement): feat-a-new-topic-admits-its-first-registration-without-a-second-ask` before the handoff, then the surrounding code it depends on.

**Checked, nothing found**

- *The wait rechecks after the merge, not before.* The gossip bus (`onInbound` in `packages/db-core/src/cohort-topic/gossip/bus.ts`) verifies the sender, merges the frame into the view, and only then calls subscribers, so the host's `recheck()` sees the answer it was woken for. Frames that fail the co-member check never reach the handler, so neither the recheck nor the first-heard answer can be driven by a stranger.
- *The readiness probe has no side effects.* `awaitsMembers` re-runs `willingness.evaluate` once per held register per inbound frame; `evaluate` reads the view and the attempt counter but writes nothing, so repeated probes do not inflate back-off or rate accounting.
- *A waiting engine cannot be evicted from under its register.* The register has already instantiated the topic's forwarder, which the engine registry treats as pinned (`EVICTION_RANK` in `host.ts`). An engine closes during a wait only when the host stops, and `close()` settles the wait first.
- *One wait, one timer.* The deadline is set exactly while at least one register is held and is cleared when the last settles; it is `unref`'d. A joiner inherits the open wait's deadline, so it can be held for less than the full 2 s but never more.
- *Advert and round do not double-send.* The advert drains nothing from the pending-delta queue and stamps `lastGossipAt`, so the next round neither repeats the heartbeat nor loses a delta. An engine holding records refuses to advert, so it cannot blank its own topic summaries in a sibling's view.
- *Abuse surface.* The wait runs after the signature, rate-limit, cold-start-evidence, replay and topic-budget gates. Per engine: at most 64 held streams, each for at most 2 s, and at most one advert per gossip interval. A member that never answers costs one full-length hold per gossip interval, not one per register.
- *Hold versus the participant's timeout.* 2 s against the 5 s the participant waits for a reply; the option rejects negative and non-finite values.
- *Type safety, error handling, cross-platform.* No `any`; the advert's sign-and-broadcast failure is logged, not swallowed; the timer `unref` is optional-called so it works where timers have none.
- *Docs.* Read `docs/cohort-topic.md` (§Willingness, §Cold-start instantiation, §Anti-DoS, §Configuration) and `docs/reactivity.md` (*Attach*, "Decided, not built") against the code; they match. Searched the other docs for leftover "deferred, retried at the next tick" wording about first registrations; none remains. `docs/internals.md` had no mention to update.
- *The backlog ticket the implementer filed* (proof-of-work freeze) carries repro, severity, likelihood, tradeoffs and an anchor.

**Found and fixed in this pass (minor)**

- `cold-quorum-wait.ts` had three branches no test reached at any level: a refused solicitation opening no wait, the deadline settling an unanswered register, and the 64-waiter cap; nor was `close()` exercised. Added `packages/db-p2p/test/cohort-topic/cold-quorum-wait.spec.ts` (three tests) pinning those, plus that one wait solicits once however many registers join it and that a recheck settles only the registers that are ready.

**Tests reviewed**

- Kept the implementer's three: the `awaitingMembers` truth table (real branching), the engine's wait-then-decide-again step over the real willingness check, and live-tier case 5b (the host-level reproduction: before the change the same call threw `CohortBackoffError`). None restates the implementation or verifies a mock.

**Major findings / new tickets**

- None. No defect was found that needs a ticket.

**Tripwires (parked, not ticketed)**

- The waiter cap and its per-frame cost: `NOTE:` at `MAX_COLD_QUORUM_WAITERS` in `cold-quorum-wait.ts` (already present).
- The restart gap: `NOTE:` at the first-heard handler in `host.ts` (already present).
- The advert throttle reuses the gossip interval, so a deployment that lengthens `gossipIntervalMs` also lengthens the time before a second wait can open on the same engine. Stated in `docs/cohort-topic.md` §Cold-start instantiation, mechanism 3; no code change.

**Not resolved**

- The implementer saw one untraced 40.8 s attach before adding trace lines and could not reproduce it in 42 traced runs. I did not re-run the real-socket integration case, so it remains unexplained. The 30-second tick bounds its effect to one late attach.

**Validation in this pass**

- `yarn lint` and `yarn lint:docs` from the root: clean.
- `yarn test` in `packages/db-core`: 1860 passing.
- `yarn test` in `packages/db-p2p`: 3203 passing (3200 plus the three new), 65 pending (env-gated).
- Not run: `yarn test:integration`, `yarn check:rn`, `yarn lint:deps`, other workspaces' suites (no source changed in this pass).
