description: A machine that already stores a block still sends its reads of that block to another machine, so an app polling a quiet table pays a network round trip on every poll. Let a read be answered by the machine's own storage when it is one of the machines responsible for the block; that storage already knows when to re-check with the others.
prereq:
architecture: docs/internals.md#quereus-vtab-read-path--pull-on-read-is-shape-independent
files:
  - packages/db-p2p/src/libp2p-key-network.ts (`findCoordinator`: the coordinator cache check at the top, the cohort tier's `isSelfAdmissible` and ranking, `shouldAllowSelfCoordination`, `recordCoordinator`'s self gate, `assembleServingCohort`)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (the `findCoordinator()` describe blocks, whose fixtures already build a FRET cohort, connections and the guard's inputs)
  - packages/db-core/src/network/i-key-network.ts (`CoordinatorIntent` doc — say what `'read'` now buys)
  - packages/db-core/src/transactor/network-transactor.ts (`get` — the only `intent: 'read'` caller; its second-chance retry excludes the first coordinator, which is what keeps this change safe; read only, no edit expected)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`get`, `markBlocksSeen`, `readRepairWindowMs`, `floorDemandsConsult` — the currency rules a self-served read inherits; read only)
  - docs/internals.md (§ Quereus vtab read path — the "an idle poll costs one per tree" paragraph)
  - docs/transactions.md (§ Lazy read-repair window, if it states who a read is routed to)
----
# A read prefers this machine's own copy when it holds the block

## Where this came from

The plan ticket `feat-a-live-read-can-skip-a-refresh-the-cohort-already-told-it-about` (sereus's question 1: "must a live read refresh every tree from the network on every statement?") offered two options for making an idle live read cost zero network requests once `refresh-of-an-unchanged-collection-refetches-the-same-blocks` had brought it down to one request per tree:

- **A.** Keep a "known current" mark per collection in `Collection`, cleared by `onCollectionChange` events, and skip the refresh while the mark is set and younger than a window.
- **B.** Send the refresh's read to this machine's own storage when this machine is one of the peers responsible for the block.

This ticket builds **B** and does not build A. The reasons:

- **B adds no new staleness.** A read served by a remote coordinator is served from *that* machine's copy, under *its* lazy read-repair window (`readRepairWindowMs`, default 10 s): inside the window it answers from its own copy without consulting the cohort. A self-served read is under exactly the same rule on this machine's copy. So routing the read to self changes which cohort member answers, not what guarantee the answer carries. Floors (`BlockGets.floors`), the `unconfirmedAheadRev` doubt marker and the `unavailable` flag all ride along unchanged, and `NetworkTransactor.get`'s second-chance retry still re-asks a different coordinator when self's answer is below a floor, doubted, or unavailable.
- **B needs no new state.** The event A would listen for is a block landing in this machine's storage, and when it lands, a local read already sees it. A would duplicate the storage's knowledge in a second cache inside `Collection`, with its own window and its own invalidation bugs, for events that fire only on machines that store the block, which is exactly the set B covers.
- **A would save only an in-process call on top of B.** After B, an idle poll on a responsible machine costs one in-process `CoordinatorRepo.get` per tree, plus one cohort consult per block per `readRepairWindowMs`. A would remove the in-process call. Leave a `NOTE:` tripwire at the new tier (see TODO) rather than a ticket.

## What routes reads away from self today

The plan ticket's analysis assumed self was being *denied* on sereus's joining machine. Reading `findCoordinator` shows two other causes, either of which is enough on a healthy two-machine group:

1. **The coordinator cache is consulted before anything else.** `getCachedCoordinator(key)` runs first, for either intent. Any remote pick for the key is cached for 30 minutes (`recordCoordinator`), whether it came from a write (every commit resolves a coordinator for the log tail and the header) or from an earlier read. A self pick is never cached, so once a key has been routed remotely, its reads keep going remote for the life of the entry.
2. **The cohort tier ranks by reputation score, then by proximity.** Self has no reputation record and scores 0. So does every remote peer without penalties, and the stable sort then keeps proximity order. With two machines, self comes first for about half the keys.

A deferrable guard denial (`partition-detected` or `suspicious-shrinkage` against a high-water mark from an earlier, larger network) also drops self from the cohort tier while any connection is live. That is deliberate, and this ticket keeps it (see *Rule*).

## Rule

For `intent === 'read'`, before the coordinator cache is consulted, `findCoordinator` returns **self** when all of these hold:

- self is not in `excludedPeers`;
- self is in the key's serving cohort, from the same `assembleServingCohort` the cohort tier uses (so a machine that does not serve storage, or one that nearer serving peers outrank, is never picked);
- `shouldAllowSelfCoordination('read')` returns `allow: true`, whether or not it also sets `warn`.

If the guard denies, even deferrably, the new tier does nothing and selection proceeds exactly as today. The existing isolated-read degrade (`degradedRead` in the cohort tier and the last-resort tier) stays the only path that picks a denied self, and it still needs `connected.length === 0`. This keeps the standing rule that a read is not handed to a machine its own guard calls partitioned while a reachable cohort member exists (test "a READ still prefers a reachable peer over degraded self while any connection is live").

When the tier picks self, log it under a distinct source, `findCoordinator:done … source=self-read`, so a downstream run can count how many reads stayed local. Do not record the pick: `recordCoordinator` already refuses self, and that must not change. When the tier does not pick self, the rest of `findCoordinator` runs unchanged. It may reuse the assembly the tier just made for its first attempt, but it need not.

**Writes are untouched.** The pend already prefers the co-located node among equal covers (`NetworkTransactorInit.localPeerId`), and commit coordination has its own rules. Nothing in this ticket changes a write's coordinator.

## The rule this sets for "local state without network confirmation"

The plan ticket asked that this work and backlog `a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds` agree on one rule for when a live read may use local state without asking another machine. This ticket's rule: **a live read may be answered from this machine's own copy when the machine is in the block's cohort and its self-coordination guard allows it, and the answer is then subject to the coordinator's own currency rules (read-repair window, floors, doubt markers), exactly as a remote coordinator's answer is.** The isolated-node question is what happens when those currency rules cannot be met, because the consult reaches nobody and the block is missing locally. That question stays open. An arm recording this rule has been appended to that ticket.

## Edge cases & interactions

- **Retry after self answered badly.** `NetworkTransactor.get` retries with the first coordinator excluded. The tier's `excludedPeers` check must make the retry fall through to a remote cohort member. Otherwise a below-floor, doubted or unavailable local answer would be asked again of the same machine, and the floor mechanism (which exists to reach a second machine) would stop working. Verified by the contract test.
- **Guard denies while connected.** No self-first. Unchanged behaviour, already pinned by the existing "prefers a reachable peer over degraded self" test. Verify by running the existing suite.
- **Self not in the cohort** (a network wider than `clusterSize`, or `selfServes()` false): the tier does nothing and the cache still applies. Verified by inspection, and by the contract test's non-member case if it is cheap to add.
- **Assembly throws** (FRET unavailable): the tier catches, logs, and falls through. It must not turn a read that works today into a failure. Verify by inspection.
- **Freshly restarted machine with a stale disk.** Safe because read-repair freshness is in memory. After a restart no block is marked seen, so the first self-served read of each block consults the cohort. Verify by inspection of `markBlocksSeen` / the freshness map in `CoordinatorRepo`; say so in the handoff.
- **A commit that reached a majority without this machine** (cohorts of three or more). Self serves its older copy until its window expires, at most `readRepairWindowMs` after the window was last armed. A remote coordinator that missed the same commit behaves identically, so this is not a new exposure. But self is now the answering machine far more often, so state the bound in `docs/internals.md`. A refresh that walked a newer entry sets a floor, and a floored read makes the local coordinator consult at once (`floorDemandsConsult`), so the write path's own refresh is not affected.
- **This machine's own write.** The machine either applied the commit as a cohort member or reconciles it. A self-served read then sees it with no network hop. No change needed.
- **Per-read cost.** The tier assembles the cohort on every read call, where a cached remote pick used to skip that. `assembleServingCohort` is a hash, a FRET table lookup and peerStore reads, all local. Leave a `NOTE:` saying: if this shows up in profiles, memoize "self is in this key's cohort" with a short TTL (the responsibility check in `CoordinatorRepo` already keeps a 60 s one).
- **Mesh test harness.** `packages/db-p2p/src/testing/mesh-harness.ts` wraps the key network (`mesh-harness-wrap-key-network.spec.ts`). Confirm the wrapper passes `intent` through, and that mesh specs which count remote repo calls still pass. A spec that asserted reads go remote would have been pinning the old routing. If one fails for that reason, update it and say so in the handoff.

## Test

One contract test in `packages/db-p2p/test/libp2p-key-network.spec.ts`, beside the existing `findCoordinator()` describes, on the branching this adds:

- A cohort containing self and one connected remote peer, the remote ranked first by proximity, and a remote coordinator already cached for the key (`recordCoordinator`). The guard allows self (bootstrap, HWM ≤ 1, is the simplest input).
  - `intent: 'read'` → self.
  - `intent: 'read'` with self in `excludedPeers` → the remote peer.
  - `intent: 'write'` (or unset) → the cached remote peer, unchanged.

Nothing else. The currency rules a self-served read inherits are already pinned in `CoordinatorRepo`'s suites.

## Measurement for the handoff (not a test)

If a mesh spec can count repo `get` calls per peer, record the before and after for an idle `update()` on a two-member cohort whose reader holds both blocks: inside the read-repair window, remote `get` calls should drop to zero. If no spec can count them cheaply, say so; do not build a harness for it.

## TODO

- Add the read-intent self-first tier to `Libp2pKeyPeerNetwork.findCoordinator`, ahead of the coordinator-cache check, per *Rule*; log `source=self-read`; catch and log assembly failures and fall through.
- Add the `NOTE:` tripwires at the tier: the per-read assembly cost, and "a Collection-level known-current mark (option A of the plan) would save only the in-process call; consider it if in-process refreshes show up in profiles".
- Update the `CoordinatorIntent` doc in `packages/db-core/src/network/i-key-network.ts`: a `'read'` prefers this node's own replica when this node is in the cohort and the guard allows it.
- Add the contract test above.
- Check the mesh harness passes `intent` through; run the db-p2p suite and fix any spec that pinned remote read routing, noting each one in the handoff.
- Update `docs/internals.md` § Quereus vtab read path: on a machine in the block's cohort, an idle poll costs no network request inside the read-repair window, plus one cohort consult per block per window. State the staleness bound (the same as a remote coordinator's). Check `docs/transactions.md` § Lazy read-repair window for any claim about where reads are routed.
- Run `yarn build`, then `yarn test` in `db-p2p` and `db-core`, and `yarn lint:docs`.
