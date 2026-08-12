----
description: A node that is alone waits a full second before every operation on every block, hoping another machine shows up — even when it can already tell that none can. Make the wait conditional on there being something to wait for.
prereq:
files: packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, docs/transactions.md, packages/db-p2p/docs/cluster.md
difficulty: medium
----

# Skip the coordinator retry window when nothing can arrive during it

## Background

`Libp2pKeyPeerNetwork.findCoordinator` (`packages/db-p2p/src/libp2p-key-network.ts`) runs up to
three selection attempts. Between attempts, when the attempt found no candidate **and the node
holds zero connections**, it sleeps 500 ms (line ~641), so an isolated lookup burns ~1 s before
reaching the last-resort tier that returns self. A coordinator lookup happens per block, so an
operation touching several blocks pays that window several times — on precisely the node that has
no peers to parallelise against.

There is already an escape hatch: `canRetryImprove` (line ~290) breaks the loop early. Its test is
too narrow to fire for real isolated nodes:

```ts
private canRetryImprove(fretNeighborIds: string[]): boolean {
	if (this.networkMode !== 'forming') return true;   // (1) frozen at construction
	if (this.networkHighWaterMark > 1) return true;     // (2) history, not evidence
	const onlySelf = /* FRET neighbourhood empty or just us */;
	return !onlySelf;
}
```

1. `networkMode` is computed once in `libp2p-node-base.ts:696` as
   `bootstrapNodes.length > 0 ? 'joining' : 'forming'` and never re-derived. Any node configured
   with a bootstrap address is permanently `'joining'`, so it can never break early — even when it
   has never reached those addresses and its FRET neighbourhood holds nothing but itself.
2. `networkHighWaterMark` is monotonic (raised at lines ~248-258, persisted, relaxed only by the
   `hwm-decay` branch after three consecutively isolated sessions). A node that once saw a bigger
   network pays the window on every lookup for its first three isolated sessions.

## The change

Replace `canRetryImprove` with a futility test answered from **evidence available at the moment of
the call**. Rename it to make the changed contract explicit (the old name is reached only through
`(network as any)` in the spec, so a rename forces those tests to be rewritten deliberately rather
than silently passing under stale assumptions):

```ts
/**
 * Can another attempt plausibly return a BETTER answer than this one did? Consulted ONLY
 * when the current attempt found no candidate and the node holds zero connections — i.e.
 * purely to decide whether the 500ms inter-attempt sleep is worth paying.
 *
 * Answered from evidence available NOW, never from configuration or history:
 *  - a non-self candidate in the FRET neighbourhood for this key — a peer we know of and
 *    route to; a connection to it landing during the sleep makes it selectable.
 *  - a dial in flight (`queued` / `active` in libp2p's dial queue) — a connection attempt
 *    that can complete inside the sleep. This is the signal that covers a
 *    configured-but-not-yet-reached bootstrap peer: while its dial runs, the window is
 *    worth paying; once the dial has failed, it is not.
 *
 * Neither present → nothing this call can wait for; break to the last-resort tier.
 */
private retryCouldImprove(candidateIds: string[]): boolean {
	if (candidateIds.some(id => id !== this.libp2p.peerId.toString())) return true;
	const pending = (this.libp2p.getDialQueue?.() ?? [])
		.filter(d => d.status === 'queued' || d.status === 'active');
	return pending.length > 0;
}
```

Call site (line ~641) passes the **exclusion- and ban-filtered** neighbour ids, not the raw `ids`:

```ts
const knowable = ids.filter(id => !excludedSet.has(id) && !(this.reputation?.isBanned(id)));
if (!this.retryCouldImprove(knowable)) {
	this.log('findCoordinator:retry-futile key=%s neighbors=%d dialsInFlight=%d mode=%s hwm=%d', …);
	break;
}
```

Do **not** apply the network-membership filter to this input: an `unknown` (not-yet-identified)
non-self neighbour is exactly the peer that flips to `serves` inside the retry window, so its
presence must keep the window (that behaviour has a spec — "selects a peer once it flips from
unknown to serves within the retry window", spec line ~1317; it runs with a live connection so it
never reaches the sleep, but the intent must not be undermined).

`getDialQueue` is non-optional on the `Libp2p` interface
(`@libp2p/interface/dist/src/index.d.ts:582`, `PendingDial.status: 'queued' | 'active' | 'error' |
'success'`), so an absent method only ever means a test mock. Optional-chain it and treat absence
as "no evidence of an in-flight dial", matching how `getConnections?.()` is already handled.

Nothing about the **decision** changes: `shouldAllowSelfCoordination` keeps its grading, the
last-resort tier keeps its hard/deferrable split, and every existing error code stays reachable.
This ticket only stops *waiting* before a decision the waiting cannot influence.

## Settled design decisions — implement these, do not re-open

**Inbound reachability is NOT a futility factor, and there is no second, shorter window.**
Tempting alternative: treat "this node has listen addresses or a relay reservation, so someone
could dial in" as a reason to keep the window. Rejected, three reasons:

- It would exempt every node with a listen address — i.e. most nodes — leaving the fix useful only
  to browsers.
- Today's `canRetryImprove` already breaks early for a `forming` + `hwm<=1` node regardless of its
  listen addresses, so inbound reachability was never part of this decision; extending the same
  treatment to `joining` / `hwm>1` nodes is consistent rather than novel.
- An inbound connection from a peer we know nothing about is not something a specific 500 ms slice
  can be aimed at, and if it lands it is picked up by the next lookup anyway. The window's stated
  purpose is "connections can be temporarily down" — reconnecting to *known* peers. Zero known
  peers plus no dial in flight means there is nothing to reconnect to.

A separate shorter window for inbound-incapable nodes was also rejected: a second timing constant
and more state for a case that now resolves in one attempt.

**No peerStore scan.** "Knows of another peer serving this network" is answered from the FRET
neighbourhood plus the dial queue, not from `peerStore.all()`. A peerStore scan is an async
datastore iteration on a per-lookup hot path (and network-scoping it would cost one more async
`get` per peer to read protocols), while a peerStore entry with no FRET entry and no in-flight dial
is a peer nobody is currently attempting — sleeping 500 ms does not dial it. Note the consequence
for the motivating case: a phone configured with a server address that is now offline has that
server in its peerStore but not in FRET; while libp2p's bootstrap discovery dial is in flight the
queue keeps the window, and once the dial fails the lookup goes fast. That is the intended
behaviour.

**`networkMode` becomes diagnostic-only, and stays.** After this change nothing consults it for a
decision; it still carries real triage value in the `retry-futile` log line ("this node was
configured to expect company" vs. "solo by design"), so keep it in that log and add a `NOTE:` at
the field declaration recording that it no longer participates in any decision and should be
dropped or re-derived when the constructor becomes an options bag — the trigger the existing
constructor NOTEs already describe. Removing the positional parameter now would churn ~50
construction sites in `test/libp2p-key-network.spec.ts` for no behaviour change. Do not file a
follow-up ticket for that; the `NOTE:` is the record.

**`hwm-decay` stays untouched and stays consistent.** The futility break skips only the *sleep*.
It cannot skip a denial: after the break, control falls to the same last-resort tier, which calls
`shouldAllowSelfCoordination(intent)` exactly as before. A `hwm>1`, `consecutiveIsolatedSessions<3`
node with a detected partition still gets a HARD denial on a write (`SELF_COORDINATION_BLOCKED`) —
just ~1 s sooner. A node past the decay threshold still self-coordinates with a warning.

**Accepted regression, documented in the code:** under the old behaviour, a futile-looking node
that received an inbound connection during attempt 0's sleep would route the key to that peer
instead of degrading to self. That path is now skipped for nodes with no known peers and no dial in
flight. The cost is one lookup's routing (a self pick is never cached, so the next lookup picks the
new peer up); the benefit is that every isolated lookup stops paying ~1 s. Record this as a
`NOTE:` at the futility test.

## Edge cases & interactions

- **Futile isolated write** (zero connections, self-only FRET, empty dial queue) — must reach the
  last-resort tier on **one** attempt and still return degraded self. This is the headline case,
  and it includes `hwm>1` / `'joining'` nodes.
- **Non-futile isolated write** (same, but a `queued`/`active` dial in the queue) — must still
  spend all 3 attempts. This is what preserves the "a peer that lands during the write retry window
  still wins the key over self" guarantee.
- **A peer landing during attempt 0's sleep still wins the key** for a non-futile node. The
  existing spec (line ~814) asserts the arriving peer is picked on attempt 2; its mock currently
  has no dial queue, so it must be given one — an in-flight dial is also the realistic reason a
  peer appears 50 ms later, so the spec gets *more* honest, not weaker.
- **Read path must not regress.** A read already admits self at the FRET tier when isolated and
  returns on attempt 0, so it never reaches the sleep; assert it still takes exactly 1 attempt.
- **`SELF_COORDINATION_EXHAUSTED`** (self excluded, `hwm<=1`, no other peer) must stay reachable
  and keep its message about the first-attempt cause — the break falls through to the same tier.
- **`NO_COORDINATOR_AVAILABLE`** (self excluded, `hwm>1`) and **`NO_NETWORK_COORDINATOR`**
  (`droppedUnconfirmedAnyAttempt`) must stay reachable. Note `droppedUnconfirmedAnyAttempt`
  accumulates across attempts, so breaking earlier means fewer attempts contribute to it — verify
  the two existing `NO_NETWORK_COORDINATOR` specs (lines ~1246 and ~1288) still pass; both run with
  a live connection, so they never reach the sleep.
- **Exclusion interaction:** when FRET's only non-self neighbour is excluded or banned, the futility
  input is empty → break early. Correct: neither the FRET tier nor the connected fallback can use
  that peer.
- **FRET service unavailable** (`getNeighborIdsForKey` throws): `ids` stays `[]`, so futility turns
  on the dial queue alone. A node with no routing information has nothing to wait for.
- **Dial queue over-inclusive** — it may hold a dial to an excluded, banned, or foreign-network
  peer. That keeps the window (conservative, matches today's behaviour); do not try to
  cross-reference it, and say so in a comment.
- **Concurrent lookups:** several `findCoordinator` calls can be in flight for different blocks.
  The futility test reads only live libp2p state and its own argument — no instance mutation, so no
  ordering hazard between concurrent calls. Keep it that way (do not memoize the verdict on the
  instance).
- **The existing solo-node wall-clock guard** (spec line ~702, "three solo lookups stay well under
  one 500ms retry delay") must keep passing.

## Tests

Extend `packages/db-p2p/test/libp2p-key-network.spec.ts`. Attempt counting via the FRET
`getNeighbors` call counter is the primary assertion (the spec's established clock-free idiom); do
not add new wall-clock assertions beyond the one that already exists.

Mock work needed first:

- `createMockLibp2p` gains an optional `dialQueue` option, defaulting to `[]`, exposed as
  `getDialQueue: () => …`.
- `justDisconnectedNode` (line ~753) gains a `dialInFlight?: boolean` option that puts one
  `{ id: 'd0', status: 'active', multiaddrs: [] }` entry in the queue.

Specs to write:

- **The confirming case from the report.** `networkMode: 'joining'`, `networkHighWaterMark = 1`,
  zero connections, FRET neighbourhood of self only, empty dial queue → `findCoordinator` (write
  intent) returns self after **1** FRET attempt. Assert 3 before the change to prove the spec bites.
- Same shape with `networkHighWaterMark = 10` (the `justDisconnectedNode` scenario) → 1 attempt,
  result is degraded self. This replaces the current "completes a WRITE from its own replica after
  the retry window" expectation of 3 attempts; keep the *result* assertion, change the count and
  the comment.
- `dialInFlight: true` on the same node → still **3** attempts, still returns degraded self.
- The arrival spec (line ~814) with `dialInFlight: true` → arriving peer wins, picked on attempt 2,
  unchanged otherwise.
- Isolated **read** → self, exactly 1 attempt (unchanged, now also guarding the futile path).
- Futile node with `detectPartition: () => true`: write throws `SELF_COORDINATION_BLOCKED`, read
  returns self — both in 1 attempt. This is the `hwm-decay` consistency check: the denial survives,
  only the delay goes.
- Futile node, self excluded, `hwm<=1` → `SELF_COORDINATION_EXHAUSTED` in 1 attempt.
- Futile node, self excluded, `hwm>1` → `NO_COORDINATOR_AVAILABLE` in 1 attempt.
- `retryCouldImprove()` unit block replacing the `canRetryImprove()` block (lines 71-114):
  self-only + empty queue → `false`; empty list + empty queue → `false`; self-only +
  `status: 'active'` dial → `true`; self-only + only `status: 'error'`/`'success'` entries →
  `false`; list with a non-self id → `true`; and — the regression the whole ticket is about —
  `'joining'` mode with `hwm = 10`, self-only, empty queue → `false`.
- The `networkMode defaults` block (lines ~914-927) still passes; it only reads the field.

## Docs

- `docs/transactions.md:2056` — "Retry Logic" bullet: state that the retry is skipped when no
  non-self FRET neighbour exists for the key and no dial is in flight.
- `docs/transactions.md:2206` — the paragraph explaining the 3×500 ms window: add that the window is
  paid only when something could arrive during it, and name the two signals.
- `docs/transactions.md:2203` — the write row of the read/write table says "Self stays dropped for
  the whole retry window"; qualify with "for as long as the window is worth paying".
- `packages/db-p2p/docs/cluster.md` — add a bullet next to "Self-Coordination Is Never Memoized"
  (~line 647) recording that the retry window is evidence-gated, and why the peerStore is not
  consulted.
- Leave `docs/transactions.md:1742` alone — it is a historical changelog entry.

## TODO

Phase 1 — futility test
- Replace `canRetryImprove` with `retryCouldImprove(candidateIds)` as specified; delete the
  `networkMode` and `networkHighWaterMark` tests from it.
- Build the exclusion/ban-filtered `knowable` list at the call site and pass it.
- Expand the `retry-futile` log line with neighbour count and in-flight dial count.
- Add the `NOTE:` at the futility test recording the accepted regression (inbound arrival during a
  skipped sleep) and the deliberate absence of a peerStore scan.
- Add the `NOTE:` at the `networkMode` field declaration recording that it is diagnostic-only now.

Phase 2 — specs
- Add `dialQueue` to `createMockLibp2p` and `dialInFlight` to `justDisconnectedNode`.
- Rewrite the `canRetryImprove()` describe block as `retryCouldImprove()` with the cases listed above.
- Add / adjust the `findCoordinator` specs listed above.
- Run `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log` (stream it; never
  silently redirect) and the package type check. Confirm the full spec file is green, in particular
  the membership-scoping block, which must be untouched.

Phase 3 — docs
- Apply the four doc edits listed above.
