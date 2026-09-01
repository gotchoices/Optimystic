description: When two writes want the same data at once, a cluster node runs a bookkeeping pass that both drops abandoned reservations and drops the loser of the contest. Two of that pass's behaviours have no test, so a future edit could break either and every test would still pass.
files: packages/db-p2p/src/cluster/cluster-repo.ts (findConflict ~2190; ClusterMemberComponents ~191; clusterMember factory ~216; ClusterMember constructor ~317; lastUpdate write ~606; persistParticipantState ~2380), packages/db-p2p/test/cluster-repo.spec.ts (describe 'conflict detection' ~577), packages/db-p2p/test/supermajority-coupling.spec.ts (only non-factory `new ClusterMember(`), packages/db-p2p/src/cluster/race-resolution.ts (resolveRace ordering — read-only reference), packages/db-p2p/src/cohort-topic/topic-router.ts (injectable-clock precedent)
difficulty: medium

# Test the reservation scan's expiry ordering and its multi-conflict continue

## What the code does

`ClusterMember.findConflict` (`cluster-repo.ts` ~2190) is the pass a node runs before voting on a
write. It walks `activeTransactions` — the table of writes this node currently holds open — and per
entry does four things, in this order:

- **Skips the record against itself** (`existingHash === record.messageHash`).
- **Expires abandoned entries.** Anything whose `lastUpdate` is older than a hardcoded 2000 ms is
  cleared, freeing its blocks. This check sits *above* the conflict test, so an abandoned write
  never wins a contest it should not be in.
- **Decides the contest** for a still-live overlapping entry, via `operationsConflict` then
  `resolveRace` (both in `race-resolution.ts`, both already unit-tested).
- **Clears the loser and `continue`s** — the incoming write may overlap more than one held entry, so
  a `break` here would let it proceed past a second, still-live conflicting reservation.

## The gap (what is NOT covered)

The existing `describe('conflict detection')` block already covers same-block/different-block
detection, "a lost race is answered with a conflict vote naming the winner", and "a conflict-voted
loser does not keep holding its blocks". Missing:

**1. Expiry ordering.** Nothing asserts a stale entry is dropped, and specifically dropped *before*
the race is decided. Moving the staleness check below `operationsConflict` would let an abandoned
write win a contest and block a live one for the rest of its life, with every test still green.

**2. `continue`, not `break`.** Nothing asserts a write that beats one held entry is still blocked by
a second, independently conflicting held entry. Swapping `continue` for `break` keeps every existing
test green while admitting a write over a live reservation.

**3. Self-skip.** `existingHash === record.messageHash` appears unreachable through the public
surface: `getTransactionPhase` only calls `findConflict` when `!record.promises[ourId]`, and a
record only enters `activeTransactions` from the `shouldPersist` branch *after* the phase loop
recorded our vote (or from `recoverTransactions`, restoring a record persisted through that same
branch). Confirm that during implementation — if you find a path that persists a record without our
vote in `promises`, that path is the test; otherwise leave the guard as defensive code and say so in
the handoff.

## Design decision: injectable clock

Gap 2 needs nothing new — it is reachable through `update()` alone. Gap 1 needs one of: a real >2 s
sleep (this repo carries a standing complaint about wall-clock sleeps in tests), a cast into the
private method (deliberately removed from `cluster-repo.spec.ts` when the race rule was extracted),
or injectable time. **Injectable time** — the repo already has the pattern in
`cohort-topic/topic-router.ts` (`this.clock = options.clock ?? (() => Date.now())`).

**Critical detail:** `lastUpdate` is *stamped* with `Date.now()` at line 606 and *measured* against
`Date.now()` at line 2191. If only the read is injected, an injected clock on a different time base
makes `now - lastUpdate` wildly negative and nothing is ever stale. **Both sides must use the same
clock.** Convert exactly three sites:

- line ~606 — `lastUpdate: Date.now()` on the `activeTransactions.set` in the `shouldPersist` branch
- line ~2191 — `const now = Date.now()` in `findConflict`
- line ~2380 — `lastUpdate: Date.now()` in `persistParticipantState` (same field; `recoverTransactions`
  restores it straight back into `activeTransactions`, where `findConflict` measures it)

**Out of scope — leave alone:** `setupTimeouts` (~2173/2177; real timers need real time),
`queueExpiredTransactions` (~2302), `recoverTransactions` (~2390), the expiration guard (~771),
`executedAt` (~1771), `appliedInvalidations` (~2064), `executedTransactions` (~2434). Sweeping every
`Date.now()` in this file is a separate, larger change.

## Interfaces

```ts
// cluster-repo.ts, near the other module constants
/** How long a held reservation may go untouched before the conflict scan sweeps it. */
export const CONFLICT_STALE_THRESHOLD_MS = 2000;

interface ClusterMemberComponents {
	// ...existing fields...
	/** Monotonic clock (unix ms); injectable for tests. Default `Date.now`. */
	now?: () => number;
}

class ClusterMember {
	private readonly now: () => number;

	constructor(
		// ...existing 16 positional params, unchanged order...
		private readonly deriveExpectedCluster?: DeriveExpectedClusterCallback,
		now?: () => number
	) {
		this.now = now ?? ((): number => Date.now());
	}
}
```

Append `components.now` as the last argument in the `clusterMember()` factory (~216). The only other
construction site is `test/supermajority-coupling.spec.ts:20`, which passes 10 positional args and
needs no change.

## Test recipes (both go in `describe('conflict detection')`)

Use **5 peers** for both. `superMajority = Math.ceil(peerCount * 0.75)` (line ~895,
`DEFAULT_SUPER_MAJORITY_THRESHOLD` = 0.75), so 5 peers need 4 approvals to commit. That headroom
matters: a held record that reaches supermajority takes the commit branch, `shouldPersist` goes
false, and it is **cleared out of `activeTransactions`** — so every held rival must stay at 3
approvals or fewer, or it silently vanishes and the test asserts nothing. (With 3 peers the
threshold is 3, so a single co-signed approval already clears the rival — do not use 3.)

Existing helpers cover everything: `makeClusterPeers`, `createClusterRecord(peers, ops, promises)`
(the `messageHash` is computed over `message` only, so pre-seeded promises do not disturb it),
`makeSignedPromise(privateKey, record)`, `makePendOperationP(actionId, blockId, { txPriority })`.

### Gap 1 — stale entry is swept before the race is decided

```
let clockMs = Date.now();                     // same epoch as the un-injected Date.now() sites
const member = clusterMember({ ..., now: () => clockMs });
```

- Hold **A** on `block-shared` carrying two pre-signed approvals (peer2, peer3); with our own approve
  that is 3 of 5 — held, below the threshold of 4.
- `clockMs += CONFLICT_STALE_THRESHOLD_MS + 1`.
- Deliver **D** on `block-shared` with no pre-signed approvals.
- **Assert D's vote is `approve`.** The framing is what pins the ordering: on merits D (0 approvals)
  loses to A (3) outright, so an `approve` can only mean A was swept *before* `resolveRace` ran.
  Move the staleness check below `operationsConflict` and this flips to `conflict`.

Build this test with its own locally-constructed member (the shared `beforeEach` instance has no
injected clock); dispose it inside the test, or extend the suite's construction so `afterEach` still
disposes it.

### Gap 2 — one loser cleared, still blocked by a second live rival

`activeTransactions` is a `Map`, so iteration is insertion order. **Seed the loser first.**

- Hold **A** on `{block-a}` with no pre-signed approvals → 1 approval (ours).
- Hold **C** on `{block-c}` with one pre-signed approval (peer2) → 2 approvals, and a high
  `txPriority` via `makePendOperationP`.
- Deliver **D** touching both `block-a` and `block-c` (hand-build `Transforms` with both inserts, as
  `'does not reserve the blocks of a transaction it conflict-voted'` already does), carrying two
  pre-signed approvals (peer2, peer3) and default priority 0.
- `resolveRace` order: D(2) vs A(1) → `accept-incoming`, A cleared, loop continues. D(2) vs C(2) →
  approvals tie → priority tie-break → C wins → `keep-existing`.
- **Assert D's vote is `conflict` and `conflictWith === recordC.messageHash`.** Under a `break` the
  scan clears A, stops, returns `undefined`, and D comes back `approve` — cleanly distinguishable.

## Edge cases & interactions

- **Clock coherence.** Seed the test clock from a real `Date.now()` rather than a small counter, so
  the un-injected sites (`message.expiration`, `setupTimeouts`) stay in the same epoch. A counter
  starting at `1_000_000` makes `expiration - Date.now()` a huge negative timeout and
  `record.message.expiration < Date.now()` (line ~771) fire immediately.
- **Supermajority clearing the rival you are trying to hold.** Covered above; if a "held" record
  reaches 4 approvals it is gone from the table and the test passes vacuously. Assert the setup —
  e.g. that A's and C's own votes came back `approve` — so a miscount fails loudly instead of
  silently.
- **`maxAllowedRejections` at 5 peers is 1.** One conflict vote on D does not trip
  `ConflictSuperseded` (that needs `rejected + conflict > 1`). Do not add a rejecting peer to D.
- **Same-action escape.** `operationsConflict` returns false when both sides carry the same
  `actionId` — give A, C and D distinct action ids or nothing conflicts at all.
- **Signature validation on pre-seeded promises.** Foreign approvals are validated on the way in
  (`makeSignedPromise` signs over `messageHash + canonicalJson(message)`); sign against the exact
  record object being delivered, not a differently-built one.
- **Timer leakage.** `setupTimeouts` arms real `setTimeout`s per held record. The locally built
  member in gap 1's test must be `dispose()`d, or the suite leaks handles.
- **Do not regress the removed cast.** No `(member as any).findConflict(...)`, and no sleep longer
  than a few milliseconds anywhere in these tests.
- **`recoverTransactions` round-trip.** Converting site ~2380 changes what gets persisted; the
  restore path at ~2410 copies `state.lastUpdate` back verbatim. Existing state-store specs
  (`MemoryTransactionStateStore` users) must stay green — they construct via the factory with no
  `now`, so the default `Date.now` keeps behaviour identical.

## TODO

- Add exported `CONFLICT_STALE_THRESHOLD_MS = 2000` near the other module constants in
  `cluster-repo.ts`; use it in `findConflict` in place of the local `staleThresholdMs`.
- Add `now?: () => number` to `ClusterMemberComponents`, as the final positional constructor
  parameter, and as the final argument in the `clusterMember()` factory. Store as
  `private readonly now: () => number`, defaulting to `Date.now`.
- Convert the three `Date.now()` sites named above (~606, ~2191, ~2380) to `this.now()`. Leave every
  other `Date.now()` in the file alone.
- Confirm or refute the self-skip reachability claim; record the answer in the review handoff. Add a
  test only if a reaching path exists.
- Add the gap 1 test (stale entry swept before the race, rival would have won on merits).
- Add the gap 2 test (one loser cleared, still blocked by a second live rival, named by identity).
- Sanity-check both tests actually fail against the mutations they target: temporarily move the
  staleness check below `operationsConflict`, and temporarily swap `continue` for `break`. Revert
  both; report in the handoff that you did this.
- `yarn workspace @optimystic/db-p2p build` plus the package test suite, both green.
