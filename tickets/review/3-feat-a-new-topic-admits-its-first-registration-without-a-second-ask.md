description: The first machine to subscribe to a newly watched collection used to be told "not yet, ask again" and got in about half a minute later; the group serving the subscription now asks its members whether they are willing at once, waits a moment for their answers, and accepts the subscription in the same request.
architecture: docs/cohort-topic.md#cold-start-instantiation
files: packages/db-core/src/cohort-topic/willingness.ts, packages/db-core/src/cohort-topic/member-engine.ts, packages/db-p2p/src/cohort-topic/cold-quorum-wait.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts, packages/db-p2p/src/cohort-topic/index.ts, packages/db-p2p/src/reactivity/collection-watch.ts, packages/db-core/test/cohort-topic/willingness.spec.ts, packages/db-core/test/cohort-topic/member-engine.spec.ts, packages/db-p2p/test/cohort-topic/live-tier.spec.ts, docs/cohort-topic.md, docs/reactivity.md
difficulty: hard
----

# A new topic admits its first registration without a second ask — review handoff

## What changed, in one paragraph

A group of machines serving a topic (a "cohort") counts willing members from gossip. A cohort that has only just started serving a topic has heard nobody, so the member a first registration lands on used to count only itself, fall short of the quorum and decline. It now tells "my members said no" apart from "I have not heard from my members yet". In the second case it broadcasts its own willingness immediately, holds the request for up to 2 seconds, and decides again as answers arrive. A member that receives that broadcast with no state for the topic creates it and, because it is hearing the sender for the first time, broadcasts its own willingness straight back.

## The pieces

**db-core, `willingness.ts`.** `WillingnessDeps` gained `cohortMembers` (optional). `UnwillingCohortOutcome` gained `awaitingMembers`: true iff the quorum is short and `willing + unheard ≥ quorum`, where unheard is the cohort's members, minus self, with no entry in the gossip view. A member that gossiped unwilling counts as heard. The out-of-range-tier decline is always `false`.

**db-core, `member-engine.ts`.** New port `QuorumWait { until(ready, now): Promise<number> }` and optional dep `quorumWait`. `admitOrDecline` takes a `mayWait` flag. On `unwilling_cohort` with `awaitingMembers`, a `quorumWait` and `mayWait`, it calls `decideOnceMembersAnswer`: await the wait, then, if the topic is no longer served, decline; otherwise run `decideServed` (promoted → redirect, else `admitOrDecline` with `mayWait` false) at the clock the wait returned. `accept` therefore stamps `attachedAt`/`lastPing` with the settle time. The probe path is untouched.

**db-p2p, `cold-quorum-wait.ts` (new).** `createColdQuorumWait({ waitMs, solicit })` is the one shared wait of an engine. The first `until` calls `solicit(now)`; if that returns false no wait opens and the call resolves at once. Otherwise a deadline timer starts; later calls join until 64 are waiting (`MAX_COLD_QUORUM_WAITERS`, with a `NOTE:`), beyond which they resolve at once. `recheck()` settles the waiters whose `ready()` is now true; `close()` settles all. The wait closes when its last waiter settles. The settle clock is the caller's `now` plus the real time spent waiting.

**db-p2p, `host.ts`, inside `createCoordEngine`.**
- The willingness check is fed `cohort().members` as base64url.
- `frameAt` and `signAndBroadcast` are the frame builder and sender now shared by `gossipRound` and the advert.
- `advertiseWillingness(at)` sends the idle-heartbeat frame out of band. It refuses when the engine is closed, the host has no signing key, an advert went out within `gossipIntervalMs`, the engine holds any record, or `pending` is non-empty. It sets `lastGossipAt` so the next round does not heartbeat again.
- The wait is passed to the member engine only for a tier-0 engine on a host with a signing key and `coldQuorumWaitMs > 0`.
- One `bus.onGossip` subscription per engine (signing hosts only) rechecks the wait and answers a member heard for the first time with the advert.
- `close()` settles the wait.
- New host option `coldQuorumWaitMs` (default 2000, `0` disables, negative or non-finite throws). It reaches a node through the existing `cohortTopic.host` pass-through in `libp2p-node-base.ts`; no node-base change was needed.

## Where I departed from the plan ticket

- `cohortMembers` is optional, not required. Absent means no member is unheard, so `awaitingMembers` is always false. This left the existing test call sites of `createWillingnessCheck` unchanged; the host always supplies it.
- The wait lives in its own module rather than inline in `host.ts`.
- The bus subscription is permanent per engine, not opened and closed per wait.
- **A non-idle engine opens no wait.** The plan said a wait opens by sending the solicitation and, separately, that only an idle engine may send one. I resolved the two as: no advert, no wait, immediate decline as before.
- **Key-less hosts never advert**, including the first-heard answer. The plan did not say. Without a key there is no check on who sent the frame being answered.
- `signAndBroadcast` skips the broadcast if the engine closed while the frame was being signed. That now also applies to an ordinary gossip round caught mid-sign by a close.
- Two clocks feed the advert throttle: the register's `now` on the wait path and `Date.now()` on the first-heard path. In production both are wall clock. A test driving an engine on a virtual clock mixes them.

## Tests

Added or changed, and what each pins:

- `packages/db-core/test/cohort-topic/willingness.spec.ts`, "tells a quorum short for want of unheard members (awaitingMembers) from one whose members answered unwilling" — three members, quorum 2: empty view → true; one sibling unwilling, one unheard → still true; both unwilling → false.
- `packages/db-core/test/cohort-topic/member-engine.spec.ts`, "admits on the same request once a sibling answers willing during the wait, and declines when none does" — real willingness check, fake wait. Also asserts `ready()` is false before the sibling's answer and true after, and that the stored record's `attachedAt` is the wait's settle time.
- `packages/db-p2p/test/cohort-topic/live-tier.spec.ts` case 5b, rewritten — five real-keyed nodes, nothing pre-seeded, no gossip pumped: the first `service.register` resolves to a handle, a sibling has an engine, and after one pumped round the sibling holds the record. This is the host-level reproduction; before the change the same call threw `CohortBackoffError`.
- One existing stub in `member-engine.spec.ts` gained `awaitingMembers: false` to satisfy the type.

**The mock mesh needed no change.** Its `dialProtocol` hands a frame to the target's handler on send, so a broadcast is delivered without pumping. Pumping only drives `gossipRound`.

Not tested, verified by reading only: the timeout path at host level, the advert throttle, the waiter cap, close during a wait, promotion or budget eviction during a wait, and the absence of a wait at tier above 0 and on key-less hosts. `cold-quorum-wait.ts` has no spec of its own. If the reviewer wants one, the deadline, the refused-solicit path and the cap are its three branches.

## Validation run

- `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs` from the root: clean.
- `yarn test` in `packages/db-core`: 1860 passing.
- `yarn test` in `packages/db-p2p`: 3200 passing, 65 pending (env-gated).
- `yarn workspace @optimystic/quereus-plugin-optimystic test`: 1001 passing, 14 pending.
- Both "collection watch over real libp2p" integration cases pass with no assertion changes.

Not run: root `yarn test` for the other workspaces, `yarn check:rn`, `yarn lint:deps`, and the rest of `yarn test:integration`.

## Measured attach time, and why it is not "a few seconds" yet

Command, from `packages/db-p2p`: `OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/substrate-real-libp2p.integration.spec.ts" --grep "every machine in every cohort"`, with temporary timing and trace lines that have since been removed.

Over 42 traced runs on a Windows 11 development machine, Node 24.2.0:

| | min | median | mean | max |
|---|---|---|---|---|
| `watch()` → `isAttached` | 0.26 s | 3.0 s | 4.2 s | 16.7 s |
| cohort: cold-start register in → `accepted` out | 22 ms | — | — | 111 ms |

In all 42 the cold-start register was accepted on the first ask. One traced sequence: register in at 38.443, advert sent at 38.445, both siblings created engines and adverted back by 38.485, `accepted` out at 38.491.

The remaining time is on the subscriber. Reactivity registers at the highest operation tier, where a cold-start register must carry a proof of work, and the subscriber computes it between the plain register's `no_state` reply and the cold-start register. Twelve mints at the default difficulty took 445 ms to 10.4 s, mean 3.9 s. The loop is synchronous. This predates the ticket and was hidden by the 30-second retry. Filed as `tickets/backlog/bug-first-registration-proof-of-work-freezes-the-node-for-seconds.md`. `docs/reactivity.md` now states the measured numbers rather than a target.

The wider-mesh case ("a mesh wider than one storage group") measured 1.95 s in its one timed run.

**One unexplained run.** Before the trace lines existed, one run took 40.8 s. That fits a first attempt that failed after about 10.8 s followed by a retry on the 30-second tick, but I have no trace of it and could not reproduce it in the 42 traced runs. An 18.4 s run from the same untraced batch is within what the proof of work alone produces (the traced maximum was 16.7 s). A reviewer with time could loop the case with `DEBUG` set to `optimystic:db-p2p:reactivity-collection-watch*` and look for a "registration at tail=… failed" line.

## Known gaps and things to look at

- **A narrow race still declines.** In a cohort larger than three, a register that lands on a sibling in the few milliseconds between that sibling creating its engine (and adverting) and the other siblings' adverts arriving finds the advert throttled, so no wait opens and it is declined as before. Registers for one coordinate normally all land on the same member, so this needs two subscribers hitting different members at the same instant.
- **The mesh harness parks `gossipIntervalMs` at one hour**, so in mesh tests an engine adverts at most once per test. Any future mesh test that expects a second cold start on the same engine to wait will see an immediate decline instead.
- **Restart case unchanged**, as planned: siblings whose engines outlived a restarted member have already heard it, so they answer on their 30-second heartbeat. Recorded as a `NOTE:` at the first-heard handler in `host.ts`.
- **The set of heard members is never pruned.** It grows with members that pass the bus's co-member check, the same way the gossip view does.
- **`decideServed` after the wait redirects a topic that reads as promoted.** A cold-path register on a recreated engine whose seeded transition says "promoted" was admitted before this change (the cold path does not check promotion) and still is when no wait happens; if a wait happens it is redirected instead. Arguably more correct, but it is a behaviour difference between the two paths.
- The plan listed `docs/internals.md` for a 30-second mention; there was none, so it is unchanged.

## Docs touched

- `docs/cohort-topic.md`: §Willingness (unheard versus unwilling), §Cold-start instantiation → *Bootstrapping a cold multi-node cohort* (mechanisms 3 and 4, the new convergence paragraph, implementation pointers), §Anti-DoS (what the wait does and does not give a sender), §Configuration (`T_cold_quorum_wait`).
- `docs/reactivity.md`: the *Attach* bullet (measured numbers and their cause) and the "Decided, not built" bullet (first half of its revisit condition met, second half unmeasured, decision stands).
- `packages/db-p2p/src/reactivity/collection-watch.ts`: the accepted-tradeoff `NOTE:` in `moveTo` rewritten to the new meaning of a decline.
