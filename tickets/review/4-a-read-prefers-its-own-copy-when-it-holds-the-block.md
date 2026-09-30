description: A machine that stores a block now answers its own reads of that block from its own storage, instead of sending them to another machine, so an app polling a quiet table no longer pays a network round trip per poll. Review the new selection step, its test, and the doc changes.
prereq:
architecture: docs/internals.md#quereus-vtab-read-path--pull-on-read-is-shape-independent
files:
  - packages/db-p2p/src/libp2p-key-network.ts (`selfReadVerdict`, new; `findCoordinator`'s read tier ahead of the cache check and the `reusableAssembly` hand-off into the first cohort attempt; `recordCoordinator` doc)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (new describe "findCoordinator() — a read prefers this node's own replica when it holds the block")
  - packages/db-core/src/network/i-key-network.ts (`CoordinatorIntent` and `FindCoordinatorOptions.intent` docs)
  - docs/internals.md (§ Quereus vtab read path — idle-poll cost paragraph)
  - docs/transactions.md (§ Lazy read-repair window — new "On a machine responsible for the block…" paragraph and a corrected routing sentence in "A cohort member that sends a read…"; § Coordinator Selection and Network Resilience — priority list and the Read row)
  - packages/db-p2p/docs/cluster.md ("Self-Coordination Is Never Memoized" bullet)
----
# A read prefers this machine's own copy when it holds the block

## What was built

`Libp2pKeyPeerNetwork.findCoordinator` has a new first tier for `intent: 'read'`, run before the coordinator cache. It returns this node when all of these hold (`selfReadVerdict`):

- this node is not in `excludedPeers` (checked with the existing `isSelectable`, which also checks reputation bans — self can never be banned in production);
- this node is in the key's serving cohort, from the same `assembleServingCohort` every other tier uses;
- `shouldAllowSelfCoordination('read')` returns `allow: true` (with or without `warn`).

A pick is logged `findCoordinator:done … source=self-read` and never cached (`recordCoordinator` still refuses self). A guard denial — deferrable or hard — logs `findCoordinator:self-read-declined` and leaves selection to the old tiers unchanged, so a node whose guard calls it partitioned still routes to a reachable cohort member, and the isolation-gated read degrade stays the only path that hands a read to a refused self. An assembly failure is caught, logged `findCoordinator:self-read-assembly-failed`, and falls through. The assembly the tier made is reused by the first cohort attempt, so a read that falls through does not assemble twice (and the existing attempt-counting tests are unaffected). Writes are untouched.

Why the reads went remote before, confirmed by the measurement below: the coordinator cache is consulted first and holds only remote picks, fed by commits and by redirect/cluster hints, so a key once routed remotely kept its reads remote for 30 minutes; and the cohort tier's proximity ranking puts self first for only some keys.

## Tests added

- `libp2p-key-network.spec.ts` › "a responsible node reads locally ahead of a cached remote pick; excluding self, a write, or a non-member still routes remote". One fixture: cohort `[remote, self]`, remote connected and nearest, remote already cached for the key, guard allowing self (bootstrap, high-water mark 1). Pins four arms of the new branching: a read returns self; a read with self excluded (the transactor's second-chance retry) returns the remote; a write (intent unset, as a pend passes it) returns the cached remote; with `clusterSize` 1 (self not in the cohort) a read returns the cached remote.

No other test. The currency rules a self-served read inherits (read-repair window, floors, doubt markers) are already pinned in `CoordinatorRepo`'s suites.

## Validation run

- `yarn build` (root): clean. `db-p2p`'s tsconfig includes `test/`, so the spec is type-checked too.
- `yarn test` in `db-p2p`: 3153 passing, 63 pending, 0 failing. In `db-core`: 1845 passing.
- `yarn test:integration` in `db-p2p` (real TCP meshes, real `Libp2pKeyPeerNetwork`): 44 passing, 2 pending. Not run for `quereus-plugin-optimystic`.
- `yarn lint:docs`: all resolve. `eslint` on the three touched source/spec files: clean.

## Measurement

The mesh harness cannot show this: its `MockMeshKeyNetwork.findCoordinator` is shared by every node, has no notion of which node is asking, and picks the nearest non-excluded node for every intent. It passes `intent` through (`makeNodeKeyNetwork`), and no mesh spec failed.

The real-socket spec `routing-key-convention-divergence.integration.spec.ts` ("a production-shaped transactor: where writes go, where they land, and what reads cost", 6 nodes, `clusterSize` 2) already counts remote `get` calls for 24 single-block reads from one reader. Run once with the tier switched off by a temporary environment check (since removed; the source has no trace of it) and once with it on: remote gets 24 of 24 → 9 of 24. An earlier full run with the tier on showed 7 of 24; node identities are random per run, so which blocks the reader is responsible for varies. All 24 reads were correct in every run. The remaining remote reads are presumably blocks outside the reader's cohort; that was not checked per block. The ticket's specific shape — an idle `update()` on a two-member cohort whose reader holds both blocks — was not measured, and no harness was built for it.

## Edge cases, as checked

- Retry after a bad local answer: the exclusion check makes the retry skip the tier (test arm 2).
- Guard denies while connected: unchanged; the existing "a READ still prefers a reachable peer over degraded self while any connection is live" passes.
- Self not in the cohort, or not serving: tier does nothing (test arm 4; a non-serving self is never in the cohort by `assembleServingCohort`'s rule).
- Assembly throws: caught and logged, falls through (inspection).
- Restart with a stale disk: `CoordinatorRepo.lastSeenCommitMs` is an in-memory `LruMap`, so after a restart no block is marked seen and the first self-served read of each block consults the cohort (inspection; stated in `docs/transactions.md`).
- Commit that reached a majority without this node (cohort ≥ 3): served as the older local copy for at most `readRepairWindowMs` after the window was last armed, the same as a remote coordinator that missed it; floored reads consult at once. Stated in `docs/transactions.md` § Lazy read-repair window.

## Known gaps and judgement calls for the reviewer

- When the tier declines because of a guard denial, the first cohort attempt evaluates the guard again, so `shouldAllowSelfCoordination` runs (and logs its `self-coord-blocked` line) twice for that read. Both evaluations are local reads; I did not thread the decision through, since the attempt re-evaluates per attempt on purpose (connections can land between attempts).
- The tier assembles the cohort on every read even when the cache would have answered; recorded as a `NOTE:` at `selfReadVerdict` with the memoization remedy.
- I dropped a per-read "warn" log line the ticket did not ask for: on any connected node that has seen more than one peer the guard's ordinary answer is `allow` with `warn` (reason `extended-isolation`), and the guard already logs that on every call.
- The mesh harness now routes reads differently from production (always the nearest node, never "self first"). Mesh specs still exercise the remote-coordinator read path, which production still uses for non-members and for retries, but no mesh spec exercises the self-first path. Its doc says it mirrors production placement, not read routing, so I left it; decide whether that fidelity gap is worth a `debt-` ticket.
- `docs/transactions.md` used to say a just-connected node may not coordinate for itself during the 30 s grace period. `shouldAllowSelfCoordination` applies the grace-period denial only at zero connections, so that sentence was wrong regardless of this ticket; it now names the denials that actually keep a responsible node's reads remote (partition, suspicious shrinkage, or the retry after its own answer came back behind).

## Tripwires recorded

- `NOTE:` at `selfReadVerdict` — per-read cohort assembly; memoize "self is in this key's cohort" with a short TTL if it shows in profiles.
- `NOTE:` at `selfReadVerdict` — a `Collection`-level "known current" mark (the plan's option A) would save only the in-process `CoordinatorRepo.get`; consider it if in-process refreshes show in profiles.

The rule for "a live read may use local state without network confirmation" is already appended as an arm on `backlog/more-design/a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds`.
