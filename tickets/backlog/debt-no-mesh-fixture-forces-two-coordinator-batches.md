description: Every fake-network test spreads all of a write's data across all its nodes, so the code that handles a write split across two different groups of nodes has never actually run in a test — three separate places in the writing code now carry a comment saying exactly that.
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (createMesh, MockMeshKeyNetwork.findCluster, responsibilityK, and the block-to-node helper near the bottom of the file)
  - packages/db-core/src/transactor/network-transactor.ts (consolidateCoordinators — the greedy grouping that collapses; cancelAbandonedSweepBlocks — its `confirmed` filter and the NOTE above it; cancelBatch — the seed round)
  - packages/db-p2p/test/torn-commit-cancels-abandoned-blocks.spec.ts (the spec whose own comment records that it cannot reach the case)
  - packages/db-p2p/test/reset-does-not-strand-its-own-pend.spec.ts (same limitation, from the cancel side)
difficulty: medium
tradeoffs: Every one of the uncovered branches is small, individually reviewed, and only reachable on a failure path, so a maintainer could reasonably say the cost of standing up a differently-shaped fake network outweighs pinning three `if`s that have never been reported wrong.

# No test fixture ever produces a write that spans two groups of nodes

## The plain version

When a client writes several blocks at once, it does not contact every node separately. It first
asks, for each block, which nodes are responsible for it, then picks the smallest set of contact
points that covers all the blocks — usually **one** node, because in the fake network used by the
tests every node is responsible for every block. The write then goes out as a single request.

Everything downstream of that grouping has two shapes: the one-request shape, and the
more-than-one-request shape where the requests can succeed and fail independently. **Only the
one-request shape has ever run in a test.** The multi-request shape is where partial failure lives —
one group answers, the other does not — and that is precisely the shape the failure-handling code
was written for.

## The three places that say so in their own comments

Each of these was noticed independently, by a different change, and each carries a comment recording
that no test can reach it. That is three instances of one missing fixture, not three problems:

- **Deciding which blocks a half-finished write abandoned.** After a write that committed some
  blocks and lost the rest, the client cancels the ones that never confirmed. The filter that
  separates confirmed from abandoned can only ever do real work when the write went out as more than
  one request; with one request the set is empty and the filter is a no-op. The comment above it in
  `cancelAbandonedSweepBlocks` says this in full and names what a fixture would need.
- **The first cancel round after a failed write.** The cancel reuses the contact points the failed
  write already talked to. Where the write went out as several requests and some of them were
  themselves retried onto a different node, the reused mapping can under-cover — the retried request
  is remembered by only one of the blocks it carried, so the others fall through to the next cancel
  round instead of being cancelled immediately. Correct, but a round slower, and untested.
- **Aggregating a partial commit.** The error a partly-failed commit reports is assembled across
  requests; with one request there is nothing to assemble.

## What a fixture has to do

Force a write whose blocks are not all covered by any single node. The fake network already has the
knob — `createMesh`'s `responsibilityK` makes each block's responsible set the K nodes nearest it by
address distance rather than all of them — so this is a matter of choosing a node count, a K, and
block identifiers whose responsible sets do not overlap, then asserting that the write really did go
out as more than one request before asserting anything else. Two constraints to respect: consensus
needs at least two nodes per block, and the grouping step is a greedy cover, so a single node
appearing in both blocks' responsible sets is enough to collapse it back to one request and make the
test silently vacuous again.

The fixture belongs in the shared harness rather than in one spec, because all three sites above
want it. `debt-torn-commit-mesh-coverage-drops-no-blocks` is already arguing about which layer the
shared failure-injection helpers belong at; whoever picks this up should read that ticket first and
land the fixture beside them.

## What this is not

It is not a claim that any of the three sites is wrong. They were each read carefully and two of
them have direct unit-level coverage of their own logic. This is about the composed behaviour on a
real network shape, which nothing exercises.

## Arm, 2026-09-06 — a second limitation of the same harness, at the same spec: it cannot express TIMING

Added during a tending pass, verifying the claims of `complete/1-a-failed-attempt-must-discharge-its-own-pend`
rather than trusting them. This is a **different** limitation from the one the body describes — that
one is about topology (no write ever spans two coordinator batches), this one is about ordering under
latency — but it lands on the same fixture and the same spec, so it belongs here rather than in a
third mesh-harness ticket.

### The finding

`reset-does-not-strand-its-own-pend.spec.ts` test **C** is written to guard one specific change: the
pend failure path was changed from firing its cancel as an unawaited background microtask to
`await`ing it. The test says so in its own failure message:

```
expect(attempts.length, `attempt 2 must land — a wasted attempt means the cancel was not awaited.`)
```

**It does not catch that.** Measured, not inferred:

| `network-transactor.ts` pend-failure arm | `reset-does-not-strand-its-own-pend.spec.ts` |
| --- | --- |
| `await this.cancelBatch(...)` (as shipped) | 4 passing |
| reverted to `void Promise.resolve().then(() => this.cancelBatch(...))` | **4 passing** |

Full `yarn workspace @optimystic/db-p2p test` under the reverted form: 2581 passing, 0 failing. The
change can be undone in its entirety and nothing anywhere goes red.

### Why the harness hides it

The defect is a race between two things that, on a real deployment, run at very different speeds: a
background cancel that must complete a network round trip, and the caller's immediate retry. On the
mesh the cancel is an in-process call, and `writeWithRetries` defaults `delayMs` to 0 but still
awaits `source.transact`, which yields many microtask ticks before attempt 2's pend reaches the
members. The unawaited cancel simply wins every time. So the ordering the test names is not merely
unobserved — it is **unreachable**, exactly as the body's topology case is unreachable.

Note this is the second time this spec has recorded something it cannot reach; the body already
cites it "from the cancel side" for the topology gap.

### What would close it

Whatever shape the fixture work takes, it needs a way to make a peer's RPC *slow* rather than only
*broken*. The existing gate can take a transport down and heal it; it cannot make one respond late.
A per-method injectable delay on the mesh's peer transport would make both this ordering and any
other "A must land before B" claim expressible, and would let test C assert what its message
already promises.

Until then, treat test C as covering the *outcome* (a lost pend reply costs one attempt, not the
write) and **not** the *mechanism* (that the cancel is awaited). The `await` is still correct — the
reasoning at the site stands on the documented obligation that a writer discharges its own pending
records — but it is currently held in place by that reasoning alone, and a future refactor that
"optimizes" it back to a background microtask would go green.

### Verification

`repro: verified` for this arm. Disarmed the shipped `await` by hand to the exact prior expression,
ran the spec alone and the whole `db-p2p` suite, restored, and confirmed the tree clean afterwards.
The completed ticket's own validation section is consistent with this: it records that the
implementer proved discrimination by neutering the *`cancel` completeness check* (round cap 1, throw
replaced by a log) — which is test D's defect — and states plainly that this evidence "was reviewed
but not re-run". The awaited-cancel arm was never separately demonstrated to fail without its fix.
