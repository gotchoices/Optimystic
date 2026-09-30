description: A machine that stores a block now answers its own reads of that block from its own storage, instead of sending them to another machine, so an app polling a quiet table no longer pays a network round trip per poll.
prereq:
architecture: docs/internals.md#quereus-vtab-read-path--pull-on-read-is-shape-independent
files:
  - packages/db-p2p/src/libp2p-key-network.ts (`selfReadVerdict`; `findCoordinator`'s read tier ahead of the cache and the `reusableAssembly` hand-off; `recordCoordinator` doc)
  - packages/db-p2p/test/libp2p-key-network.spec.ts (describe "findCoordinator() — a read prefers this node's own replica when it holds the block")
  - packages/db-p2p/src/testing/mesh-harness.ts (`buildNetworkTransactors` doc — review added a fidelity `NOTE:`)
  - packages/db-core/src/network/i-key-network.ts (`CoordinatorIntent`, `FindCoordinatorOptions.intent` docs)
  - docs/internals.md, docs/transactions.md, packages/db-p2p/docs/cluster.md
----
# A read prefers this machine's own copy when it holds the block

## What was built

`Libp2pKeyPeerNetwork.findCoordinator` gained a first tier for `intent: 'read'`, run before the coordinator cache (`selfReadVerdict`): it returns this node when this node is not excluded, is in the key's serving cohort (the same `assembleServingCohort` every tier uses), and `shouldAllowSelfCoordination('read')` allows it (with or without a warning). A self pick is never cached. A guard denial, an assembly failure, or self outside the cohort falls through to the old tiers unchanged; the assembly made by the tier is reused by the first cohort attempt so a fall-through does not assemble twice. Writes are untouched.

Measured by the implementer on the real-socket spec `routing-key-convention-divergence.integration.spec.ts` (6 nodes, `clusterSize` 2): remote gets for 24 single-block reads from one reader fell from 24 to 9 (7 on another run; node identities are random), all reads correct.

## Review findings

Read the implement diff (`ticket(implement): a-read-prefers-its-own-copy-when-it-holds-the-block`) before the handoff.

Checked, with result:

- **Retry reaches another machine.** Confirmed in `NetworkTransactor.get`: the second-chance round builds its exclusion set from the first batch's `peerId`, so a self-served answer that comes back doubted, below its floor, or unavailable is re-asked of a different coordinator, and `selfReadVerdict`'s `isSelectable` check skips the tier on that round. The docs' claim holds.
- **Self is served in-process, not dialled.** Both production `getRepo`s (`collection-factory.ts` and `reference-peer/src/cli.ts`) hand self the co-located `coordinatedRepo`, without the `stateHoldingsOnReads` wrapper, which is correct: a self-coordinated read has no consult of itself to replace.
- **Equivalence with the cohort tier's self admission.** The cohort tier also runs `filterByMembership`; for self that is `selfServes()`, and `assembleServingCohort` leaves a non-serving self out of the band, so the new tier cannot admit a self the cohort tier would have filtered. Reputation bans never apply to self (`refuseSelfReport`).
- **Guard semantics.** A deferrable denial falls through, so a node calling itself partitioned with live connections still routes to a reachable member; the isolated-read degrade at the cohort tier is unchanged. The double guard evaluation on a denial (tier, then first cohort attempt) is two local reads plus two debug log lines; accepted as the implementer described.
- **Assembly reuse.** `reusableAssembly` is cleared after the first use and on a thrown assembly the loop re-assembles; a cache hit simply discards it. No stale reuse across attempts.
- **Staleness.** The added paragraph in `docs/transactions.md` § Lazy read-repair window states the bound correctly: in a two-member cohort a commit cannot reach a strict majority without this node, and from three up a missed commit is served old for at most one window, as a remote coordinator that missed it would; floors consult at once; restart arms nothing.
- **Docs.** Read every file the change touched plus the mesh harness it should have touched. `internals.md`, `transactions.md` (priority list, Read row, the corrected grace-period sentence — `shouldAllowSelfCoordination` indeed applies the grace-period denial only at zero connections), `cluster.md` and the `i-key-network.ts` docs match the code. `yarn lint:docs`: all resolve.
- **Tests.** The one new test pins four arms of real branching (read → self; read excluding self → remote; write → cached remote; non-member read → cached remote) with a fixture where the pre-change code returns the cached remote for arm 1, so it would fail without the tier. Kept; nothing cut, nothing added — the currency rules a self-served read inherits are pinned in `CoordinatorRepo`'s suites.
- **Source hygiene.** `selfReadVerdict` is small and single-purpose; its comments state why (no added staleness, retry exclusion, guard fall-through), not what. Two tripwire `NOTE:`s there (per-read cohort assembly; a collection-level "known current" mark) are appropriate.

Found and done:

- **Minor — fixed:** `buildNetworkTransactors` in `packages/db-p2p/src/testing/mesh-harness.ts` says reads route by proximity, and the handoff asked whether that fidelity gap is ticket-worthy. It is not a defect (the harness is a fixture and the real-socket integration spec covers the self-first path), so it is parked as a `NOTE:` tripwire on that doc comment, naming the remedy (a per-node key network whose read picks `localNode` when it is in the cohort and not excluded) and its cost (specs that rely on reads reaching a particular coordinator would move). No ticket.

No major findings; nothing filed. No conditional concerns beyond the tripwires already recorded.

## Validation (review pass)

- `yarn build` in `db-p2p` after the comment edit: clean. `eslint` on `libp2p-key-network.ts` and `mesh-harness.ts`: clean. `yarn lint:docs`: all resolve.
- `yarn test` in `db-p2p`: 3153 passing, 63 pending, 0 failing.
- `yarn test` in `quereus-plugin-optimystic`: 1001 passing, 13 pending (the implementer had not run this package).
- `yarn test:integration` in `quereus-plugin-optimystic` (real sockets, real key network): 1006 passing, 8 pending (also not run by the implementer).
- `db-p2p` integration was run by the implementer (44 passing, 2 pending) and not re-run here; the review's only source change is a comment.
