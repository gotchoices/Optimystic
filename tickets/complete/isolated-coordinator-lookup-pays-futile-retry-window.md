---
description: A node that is alone no longer waits a full second per block hoping another machine shows up; it now waits only when it can point to something that could actually arrive.
prereq:
files: packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, docs/transactions.md, docs/correctness.md, packages/db-p2p/docs/cluster.md
difficulty: medium
---

# Complete: coordinator retry window is evidence-gated

## What shipped

`Libp2pKeyPeerNetwork.findCoordinator` runs up to 3 selection attempts and sleeps 500 ms between
them when an attempt found no candidate **and** the node holds zero connections. That sleep is now
paid only when a peer could plausibly arrive during it.

`canRetryImprove(fretNeighborIds)` — which tested `networkMode` (frozen at construction) and
`networkHighWaterMark` (monotonic), so it kept the window open forever on nodes that could never
fill it — is replaced by `retryCouldImprove(candidateIds)`, which reads only live state:

- a non-self id in `candidateIds` (the key's FRET neighbours, exclusion- and ban-filtered) → keep
  the window;
- otherwise `dialsInFlight() > 0` (`queued`/`active` entries in `libp2p.getDialQueue()`) → keep the
  window;
- neither → break to the last-resort tier on this attempt.

Nothing about the *decision* changed: the break falls into the same last-resort tier, which calls
`shouldAllowSelfCoordination(intent)` exactly as before. Every `FIND_COORDINATOR_ERROR_CODES` value
stays reachable; a partitioned write still fails with `SELF_COORDINATION_BLOCKED`, ~1 s sooner.
`networkMode` survives as a diagnostic in the `retry-futile` log line only.

Specs pin: futile isolated write → self in 1 attempt (was 3); same shape with a dial in flight →
still 3 attempts; a peer landing 50 ms into a bought sleep still wins the key on attempt 2;
partition denial, `SELF_COORDINATION_EXHAUSTED`, `NO_COORDINATOR_AVAILABLE` and an excluded non-self
neighbour all resolve in 1 attempt. Attempt counting (the FRET mock's `getNeighbors` call counter)
is the clock-free assertion idiom.

## Validation run in this pass

From `packages/db-p2p`:

```
npx tsc --noEmit -p tsconfig.json                       # clean
npx eslint <the two touched files>                      # clean
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter min
    # 1563 passing / 44 pending / 0 failing
```

Plus `packages/quereus-plugin-optimystic` `test/collection-factory-key-network.spec.ts` — 3 passing
(the other `Libp2pKeyPeerNetwork` construction site). No pre-existing failures surfaced, so no
`tickets/.pre-existing-error.md` was written. Integration specs (`OPTIMYSTIC_INTEGRATION=1`) were
not run in either stage.

## Review findings

### Major

None. The one thing that would have been major — the futility break silently changing an *outcome*
rather than only a *delay* — does not happen: the break falls into the same last-resort tier, and
the specs assert every error code still surfaces, in one attempt instead of three.

### Verified upstream (settles the implementer's largest stated gap — no ticket filed)

The handoff's top "look hardest here" item was that the dial-queue signal is only ever exercised
against a mock, so the shape of a real dial was unknown. Read the upstream sources instead of
adding an integration test; all three questions are answered statically:

- **Settled dials never linger in the queue.** `@libp2p/utils` splices a job out of its queue array
  in `.finally()` the moment it settles (`@libp2p/utils/src/queue/index.ts:218-226`), so `error` /
  `success` entries are essentially unobservable through `getDialQueue()`. The `queued|active`
  filter is correct; the "settled entries only" unit test is defensive, not load-bearing.
- **An unreachable configured bootstrap never becomes a FRET neighbour.** FRET's `getNeighbors` is
  ring-member-scoped (`p2p-fret/src/service/fret-service.ts:1099-1108`, with
  `isMember = e.membership === 'member'` at :58) and a never-contacted peer stays `unknown`. So the
  reported case reaches the futility break through an empty/self-only neighbour list, and the
  implementer's open question — "the confirming `'joining'` spec uses an empty FRET neighbourhood,
  not a self-only one; worth confirming that reading is right" — is confirmed, for a stronger reason
  than the handoff gave.
- **The fix bounds rather than eliminates the futile cost in that case.** FRET re-probes an unknown
  peer at most once per its capped 32 s backoff (`recordBackoff`: base 1000 ms × factor ≤ 32,
  `fret-service.ts:1298-1303`) and each probe's dial can sit `active` for libp2p's
  `DIAL_TIMEOUT = 10_000` (`libp2p/src/connection-manager/constants.defaults.ts:4`) — so up to
  roughly a third of wall-clock still has a dial in flight, and lookups in those stretches still pay
  ~1 s. Paying there is *correct* (a succeeding probe makes the peer selectable), so this is
  knowledge, not work — parked as a `NOTE:` on `dialsInFlight()` with the measured constants and the
  revisit condition (either upstream constant moving far enough to push the duty cycle toward 1).

### Minor — fixed in this pass

- **DRY, `libp2p-key-network.ts`.** The exclusion/ban predicate
  `!excluded.has(id) && !reputation?.isBanned(id)` was written out three times: the FRET tier, the
  connected-peer fallback, and the new futility input. Extracted to `isSelectable(id, excluded)` and
  used at all three. Beyond style: the futility test and the selection tiers must not be able to
  drift apart about who is pickable, and three copies of one predicate is exactly how they would.
- **Stale claim, `docs/correctness.md:116`.** Still said a grace-period denial degrades to
  self-coordination "after the coordinator-lookup retry window", unconditionally. Amended to note
  the window is skipped when nothing could arrive during it. This file was outside the implement
  diff.
- **Stale claim, constructor comment (`libp2p-key-network.ts:203`).** Priced a grace-period denial
  at "the ~1s findCoordinator retry window"; that is now conditional. Amended.
- **Overstated rationale at the futility call site.** The comment justified not applying this
  network's membership filter on the grounds that an `unknown` neighbour is "exactly the peer that
  flips to `serves` inside the window" — true, but it reads as though unclassified peers are what
  populate `ids`, and FRET's ring membership has already made a stricter cut upstream. Rewritten to
  keep the (still valid) reason and add what actually carries the motivating case: for an unreached
  bootstrap only the dial-in-flight signal can keep the window, because that peer is absent from
  `ids` entirely.

### Tripwires

The three the implementer parked stand as written and were re-read, not re-filed: the accepted
inbound-arrival regression and the no-`peerStore`-scan decision (both at `retryCouldImprove`), the
diagnostic-only `networkMode` field, and the over-inclusive dial queue at `dialsInFlight()`. One
added, described under *Verified upstream* above: the measured duty cycle of the remaining futile
cost, at `dialsInFlight()`.

### Considered and deliberately not done

- **No ban-arm test at the futility call site.** The comment there claims exclusion *and* ban
  filtering, and only exclusion has a spec. After the `isSelectable` extraction the ban check is
  literally the same helper the exclusion spec already drives through the same call, and covering it
  separately would need a seventh option on a helper the handoff already flags as over-shaped.
  Recorded here rather than tested.
- **`dialsInFlight()` called twice on the futile path** (once in `retryCouldImprove`, once for the
  log line) — kept. Synchronous array filter, at most once per lookup; threading the value through a
  return would cost more readability than it buys.
- **`justDisconnectedNode` at six options** — read in full; each option varies exactly one axis the
  specs need. No split yet.
- **No real-libp2p integration spec** — the two questions it would have answered are settled above,
  and a test that waits out a 10 s dial timeout is not worth its wall-clock.
- **`networkMode` still a constructor parameter** — the ticket settled that deliberately; the field's
  `NOTE:` states the revisit condition (the constructor becoming an options bag).

### Tickets filed

None. No finding survived as work: everything was either fixed inline, answered by reading upstream
source, or is a recorded condition rather than a task.
