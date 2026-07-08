description: The system looks up which network nodes are responsible for each block repeatedly during a single save; cache that lookup so it happens once per block per transaction.
prereq: txn-perf-parallel-phases
files:
  - packages/db-core/src/transactor/network-transactor.ts (consolidateCoordinators ~lines 311-404, pend recordCoordinator hint ~lines 447-452, commitBlocks ~lines 582-616)
  - packages/db-core/src/network/i-key-network.ts (findCluster / recordCoordinator ~lines 10-34)
  - packages/db-p2p/src/libp2p-key-network.ts (coordinatorCache, recordCoordinator/getCachedCoordinator ~lines 302-322)
  - packages/db-p2p/src/cluster/client.ts (duck-typed recordCoordinator hint ~lines 77-87)
difficulty: medium
----

# Perf (c): cache per-block cluster lookups for the pend→commit window

Prereq note: chained after `txn-perf-parallel-phases` only to serialize edits to
`network-transactor.ts`. No logical dependency; assume (b) has landed.

## Problem

`NetworkTransactor.consolidateCoordinators` (lines 325-332) calls
`keyNetwork.findCluster(blockIdToBytes(bid))` **per block on every pend**, with no
caching. A follow-up `commit` then re-resolves the same blocks: `commitBlocks`
(line 582) → `batchesForPayload` → `findCoordinator` per block. The only thing
carrying pend's resolution forward to commit today is a best-effort, optional,
duck-typed hint:

- After pend, `NetworkTransactor.pend` calls
  `this.keyNetwork.recordCoordinator?.(blockIdToBytes(b.blockId), b.peerId)`
  (lines 447-452) — an *optional* interface method (`i-key-network.ts:33`).
- `ClusterClient` records the same hint via `pn = this.peerNetwork as any;
  if (typeof pn?.recordCoordinator === 'function') pn.recordCoordinator(...)`
  (`client.ts:85-86`).
- The Libp2p implementation stores it in a 30-minute-TTL `coordinatorCache`
  (`libp2p-key-network.ts:302-322`), which `findCoordinator` reads.

So coordinator *resolution* is loosely cached, but `findCluster` (used by pend's
consolidation) is not cached at all, and the hand-off relies on an optional,
duck-typed method that silently no-ops on implementations that don't provide it
(e.g. the Quereus adapter's key network, `key-network.ts:58`).

## Fix direction

Cache cluster lookups for the **pend→commit window, keyed by block id**, so a
block's cluster is resolved once per transaction.

Two viable shapes — pick one and document the tradeoff in the review handoff:

1. **Per-transaction cache passed through the call.** Give the transactor (or the
   coordinator that drives pend→commit) a short-lived `Map<BlockId, ClusterPeers>`
   (or `Map<BlockId, PeerId>` for the coordinator) that lives for one
   transaction. `consolidateCoordinators` populates it; `commit`/`commitBlocks`
   reads it before falling back to `findCoordinator`. Lifetime = one commit, so
   there is no staleness/TTL problem — the cache is thrown away when the
   transaction ends. Safest.

2. **Formalize the existing hint.** Add an in-transactor `findCluster` memo with a
   short TTL and promote the optional/duck-typed `recordCoordinator` to a
   first-class part of the flow, removing the `as any` in `client.ts`. Larger
   blast radius (touches the key-network contract); staleness bounded by TTL.

Prefer (1) unless there is a reason the coordinator/commit split makes threading a
per-transaction cache awkward — it avoids the membership-churn staleness that any
TTL cache carries.

Whatever the shape:
- The cache key is the block id (equivalently its `blockIdToBytes` digest — match
  whatever the existing coordinator cache keys on; see `client.ts:70-75` note).
- A cache miss must fall back to a live `findCluster` / `findCoordinator`, never
  fail.
- Do not extend the lifetime beyond one transaction for shape (1); for shape (2)
  keep the TTL bounded (the existing 30-min coordinator TTL is the ceiling).

## NOTE tripwire to leave in code

`consolidateCoordinators` already does `Promise.all` over blocks; if a future
change makes clusters churn *within* a single transaction (e.g. very long-running
commits), a per-transaction cache could serve a stale cohort. Fine now
(transactions are short); leave a `// NOTE:` at the cache site saying the cache
assumes cluster membership is stable for the transaction's lifetime.

## Expected behavior

A block's cluster/coordinator is resolved **once per transaction**; commit reuses
pend's resolution without a duck-typed optional hop. No behavioral change on a
cache miss (falls back to live resolution).

## TODO

- Add a per-transaction (or short-TTL) cluster/coordinator cache keyed by block id
  spanning pend→commit; wire `consolidateCoordinators` to populate and
  `commitBlocks`/`commit` to read it.
- If shape (1): thread the cache through the pend→commit call path; drop reliance
  on the optional `recordCoordinator?.` for the common in-process case.
- If shape (2): remove the `pn as any` duck-type in `client.ts` by making
  `recordCoordinator` first-class; keep TTL bounded.
- Leave the `// NOTE:` tripwire at the cache site (membership-stability
  assumption).
- Add a test: a pend followed by a commit for the same blocks resolves each
  block's cluster/coordinator exactly once (mock key network counts
  `findCluster` + `findCoordinator` calls).
- Build + test db-core (and db-p2p if the key-network contract changes); stream
  output with `tee`.
