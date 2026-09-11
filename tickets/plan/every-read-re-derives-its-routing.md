description: Reading a block we just wrote is cheap at the storage layer — the cache holds it — but every read still works out from scratch which machines are responsible for that block, and on a phone that bookkeeping appears to cost far more than the read itself. Nothing remembers the answer, even on a single-machine deployment where it cannot change.
prereq:
files:
  - packages/db-p2p/src/libp2p-key-network.ts:969 (`findCluster` — recomputed in full on every call; no result memo)
  - packages/db-p2p/src/libp2p-key-network.ts:608 (`recordCoordinator` — deliberately ignores a self pick, so a solo node caches nothing)
  - packages/db-p2p/src/libp2p-key-network.ts:282 (`coordinatorCache` — the one routing memo that exists, 30 min TTL)
  - packages/db-p2p/src/storage/cached-store-driver.ts:136 (the block cache's coherence contract — write-through, stores INTO the cache on write)
  - packages/db-p2p/src/repo/coordinator-repo.ts:723 (`findCluster` on the read path)
  - packages/db-p2p/src/repo/coordinator-repo.ts:2358 (existing NOTE: `getClusterSize` is a second `findCluster` for the same key)
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts (gate 4 already counts `findCluster` calls per commit)
difficulty: medium
tradeoffs: A cohort memo is a correctness-sensitive cache in a system where several past defects came from acting on a stale view of who holds a block. The conservative version (memoize only where the cohort is provably this node alone) is nearly free and helps exactly the deployments reporting pain, but buys nothing for the large networks where routing is genuinely expensive. The general version needs an invalidation story tied to membership change, and that is where the risk lives.
----

# Every read re-derives who holds the block, and nothing remembers the answer

## Where this came from

Raised by the maintainer while reviewing GitHub issue #8 (2026-09-10): *"Optimystic should already be caching the blocks of the current revision, so I don't understand why it would be expensive to read what we just wrote, unless we are tossing out the cache."*

The premise is right and the conclusion needs relocating. **We are not tossing the block cache.** `CachedStoreDriver`'s contract is write-through and explicitly stores each value *into* the cache as it writes, precisely so read-after-write hits — its own comment says a plain invalidate-on-write memo "cannot achieve at this seam: the hot reads exist to observe the writes, so invalidation lands between nearly every read". Reading a block we just wrote is a cache hit.

What is not cached is everything the coordinated path does *around* that read.

## The shape, from the reporter's own trace

One read, from `kjeib`'s device capture on issue #8 — a contiguous slice, annotated:

```
db-core:batch-coordinator  createBatches blockIds=1 batches=1 excluded=0   +407ms
db-p2p:storage-repo        get blockIds=1                                  +369ms
libp2p-key-network         findCluster:start  key=ZGVmYXVsdC9S
libp2p-key-network         findCluster:done   …
coordinator-repo           cluster-fetch:solo-self-skip { … }              +410ms
db-p2p:storage-repo        get blockIds=1                                    +7ms   ← the cache hit
db-core:network-transactor get:done blockIds=1 ms=25                         +25ms
```

The storage read that the cache serves is **7 ms**. The coordination bracketing it is not cached at all.

## What is recomputed per read, and why none of it is remembered

**`findCluster` has no result memo.** Every call re-runs `hashKey(key)`, `fret.assembleCohort(coord, wants)` against the live routing table, and — on the membership-scoped path, which is every real deployment — one peerStore read per cohort member to classify it as serving/foreign/unknown. The answer is recomputed from scratch for the same block id on every single read. There is no cache here to invalidate, stale or otherwise.

**The one routing memo that exists deliberately excludes the case that needs it most.** `recordCoordinator` ignores a pick of self, for a stated and correct reason: a self entry would pin the key to our own possibly-stale replica for the full 30-minute TTL and would return self without re-consulting `shouldAllowSelfCoordination`, letting a partitioned node silently serve its own data. Sound — but **on a solo node the coordinator is always self**, so a single-machine deployment gets zero benefit from the coordinator cache by construction, and re-derives on every read.

**And at least one path pays it twice.** An existing NOTE at `coordinator-repo.ts:2358` records that `getClusterSize` is a second `findCluster` for the same key that `executeClusterTransaction` is about to look up again. It is scoped to cancel today, with a stated revisit condition ("if wide multi-block cancels ever show up hot"). That condition has not tripped; do not treat it as this ticket's target, but do count it when measuring, because it means "findCluster calls" and "reads" are not 1:1.

## Why this is plausibly the bigger lever than the batch hooks

`feat-schema-batch-hooks-for-apply-schema` (in flight) reduces the *number* of coordinated operations a schema apply performs. This ticket reduces the *cost of each one*. They compose, and neither subsumes the other — but this one applies to every read the system ever does, not only to `APPLY SCHEMA`, and on a solo deployment the thing being recomputed cannot change between calls.

Supporting evidence from the same issue, and it is the strongest datum available: `risavian` cut their Hermes `TextDecoder` polyfill — the single largest JS frame on device, ~25% of CPU — by 54%, and one network create moved only 6–16% end-to-end. Their remaining unattributed bucket is 47.4%, which they describe as "where the native `rn-leveldb` bridge crossings and the orchestration live". Per-read *storage* cost has a demonstrated low ceiling. Per-read *orchestration* cost has not been isolated at all, and this is the largest uncached piece of it.

## Measure before building — the numbers here are not yet ours

**This ticket's premise is a hypothesis, and the plan stage's first job is to test it.** The timings above are debug-log deltas from one slow device with logging on, which both reporters measured as roughly doubling their run times. They establish the shape, not the magnitude. Do not design a cache against them.

What to measure first, on Node where we control everything:

- `findCluster` calls per read and per commit on a cold apply — gate 4 of `cold-apply-cost.spec.ts` already counts calls per commit, so extend rather than invent.
- Wall-clock and CPU share of `findCluster` against the storage read it brackets, on a solo cohort and on a mesh.
- How much of `findCluster`'s cost is `assembleCohort` versus the per-member peerStore reads, since the second scales with cohort size and the first does not.

If `findCluster` turns out to be cheap on Node and expensive only on device, say so plainly and state what makes it expensive there (peerStore backing store, bridge crossings) rather than optimizing the Node profile.

## What a design pass has to settle

**1. The conservative option first: is the cohort provably invariant?** When `findCluster` returns a cohort of exactly this node, on a node with no peers, the answer cannot change until a peer appears — and a peer appearing is an event we can observe. A memo scoped to that case is nearly free, carries almost no staleness risk, and covers every deployment currently reporting pain. Decide whether to ship this alone.

**2. The general option: what invalidates a cohort memo?** Membership changes, peers identify, the routing table shifts. A stale cohort is not a performance bug, it is a correctness bug of a class this repo has already paid for repeatedly. Candidate triggers: peerStore/identify events, routing-table change, a short TTL, or a generation counter bumped by anything that could move a cohort. Pick one and justify it; do not ship a TTL because it is easy.

**3. Whether the self-coordinator exclusion can be narrowed rather than lifted.** The reason `recordCoordinator` refuses self picks is about a *partitioned* node serving its own data. A node that has never had a peer is not partitioned. Determine whether those two can be distinguished safely — and note this is the same distinction `backlog/feat-solo-node-arms-its-own-freshness-window` (Sereus side) and the `shouldAllowSelfCoordination` tiers already wrestle with. Prefer one shared answer over a third independent one.

**4. Whether the win belongs at the memo or at the call count.** If a single read genuinely needs the cohort twice, fixing the double call is better than caching it. Check the read path for the same shape the `getClusterSize` NOTE describes before adding any cache.

## Edge cases and interactions

- **A cohort memo must not survive a network-membership change**, or a node re-joins under a different `protocolPrefix` and routes to peers that will refuse its dial.
- **The "unknown" mid-identify state is load-bearing.** `findCluster` deliberately never admits a not-yet-identified member, and re-includes it once identify completes. A memo taken during that window freezes a self-only cohort that would otherwise widen on the next call — which is exactly the recovery the read-repair arming comment at `coordinator-repo.ts:1184` relies on. Any memo must expire fast enough not to defeat it, or must be invalidated by identify.
- **A solo memo interacts with the read-repair window.** Both are per-block staleness bounds with their own clocks. Make sure a block cannot end up served from a memo-pinned self cohort *and* a freshness window that keeps re-arming off it.
- **`allowClusterDownsize` and the admission floor** both read cohort size; a memoized cohort changes what they see and when.
- **Mesh harness and `createMesh`** inject their own key networks; a memo added to `Libp2pKeyPeerNetwork` alone will not appear in mesh tests, which is how the read-cache gate previously drifted (see the warning in the schema-batch ticket about gates measuring a configuration nothing ships).

## Out of scope, parked deliberately

The maintainer also raised **using DHT peers during routing to serve a block directly when they already hold it**, noting it is a large-network optimization rather than one that helps the deployments reporting pain today. Not in this ticket. If the plan pass agrees it is separable, file it as `backlog/feat-routing-peers-serve-held-blocks` rather than growing this one.

## TODO

- [ ] Run the measurements above and record them in this ticket before designing. If the hypothesis does not hold, say so and close this rather than building a cache nobody needs.
- [ ] Settle questions 1–4; emit implement ticket(s), or route to `blocked/` if the invalidation question has no defensible default.
- [ ] Extend `cold-apply-cost.spec.ts` gate 4 to count `findCluster` calls per *read* as well as per commit, so whatever ships is guarded.
- [ ] Confirm the interaction with the in-flight `feat-schema-batch-hooks-for-apply-schema` work and state which of the two each measured improvement belongs to.
