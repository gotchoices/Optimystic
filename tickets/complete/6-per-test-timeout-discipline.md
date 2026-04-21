description: Per-test Mocha timeout discipline standardized across db-core (5s), db-p2p (10s), and quereus-plugin-optimystic (10s). Redundant defensive overrides removed; legitimate ones annotated.
dependencies: none
files:
  - packages/db-core/.mocharc.json
  - packages/db-p2p/.mocharc.json
  - packages/quereus-plugin-optimystic/.mocharc.json
  - packages/quereus-plugin-optimystic/package.json
  - packages/db-p2p/test/transaction-state-store.spec.ts
  - packages/db-p2p/test/cluster-coordinator.spec.ts
  - packages/db-p2p/test/block-transfer.spec.ts
  - packages/db-p2p/test/fresh-node-ddl.spec.ts
  - packages/db-p2p/test/fresh-node-ddl-libp2p.spec.ts
  - packages/quereus-plugin-optimystic/test/distributed-quereus.spec.ts
  - packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts
  - packages/quereus-plugin-optimystic/test/index-support.spec.ts
----

## What was built

Each Mocha-driven package now carries a `.mocharc.json` at its root declaring the
package-appropriate per-test timeout:

| Package | Default | Rationale |
| --- | --- | --- |
| `db-core` | 5000 ms | Pure unit tests — no network, no boot |
| `db-p2p` | 10000 ms | Mesh harness setup dominates; per-op work is fast |
| `quereus-plugin-optimystic` | 10000 ms | Quereus engine + plugin boot dominate |

The obsolete `--timeout 10000` flag was removed from `quereus-plugin-optimystic`'s
`test` and `test:verbose` scripts in `package.json` (mocharc supplies it now).

## Override audit — kept (all annotated with one-line rationale)

- `db-p2p/test/cluster-coordinator.spec.ts` — 15s (real setTimeout retry windows ~4.5s/case)
- `db-p2p/test/block-transfer.spec.ts` concurrency-limiting `it` — 5s (tighter: forcing-function for deadlock)
- `db-p2p/test/fresh-node-ddl.spec.ts` describe-level — 5s (tighter: forcing-function for solo-node DDL hang)
- `db-p2p/test/fresh-node-ddl-libp2p.spec.ts` — 30s (real libp2p boot + TCP + arachnode init)
- `quereus-plugin-optimystic/test/distributed-quereus.spec.ts` — 120s (3-node real libp2p mesh)
- `quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts` — 120s (3-node mesh + fs storage + cross-peer validation)
- `quereus-plugin-optimystic/test/index-support.spec.ts` Index-optimization `beforeEach` — 30s (table + 3 indexes + 100 rows)

## Override audit — removed (matched new default, no signal)

- `db-p2p/test/transaction-state-store.spec.ts` — dropped `this.timeout(10000)` in both
  `ClusterCoordinator recovery` and `ClusterMember recovery` describes
- `db-p2p/test/fresh-node-ddl.spec.ts` — deduped per-it 5s overrides by lifting
  `this.timeout(5_000)` to describe level (behaviorally identical via inheritance)

## Validation

Full per-package test runs during implement stage:
- `packages/db-core` → 287 passing, ~1s wall
- `packages/db-p2p` → 396 passing, ~21s wall
- `packages/quereus-plugin-optimystic` → 182 passing + 1 pending, ~3min wall

Review verification:
- Three `.mocharc.json` files confirmed in place with correct values
- No stray `--timeout` flags in any package's `test` scripts
- All kept overrides carry explanatory comments; removed overrides confirmed absent
- `fresh-node-ddl.spec.ts` has a single describe-level 5s override (no per-it duplicates)

## Usage

Running `yarn test` in any of the three packages picks up the mocharc automatically
(mocha auto-discovers from cwd). To sanity-check a kept budget, temporarily lower it
and confirm a "Timeout of Xms exceeded" failure fires on the targeted test.

## Out of scope (stayed out)

- Rewriting any slow test to be faster
- Per-assertion timeouts in helper utilities (`waitFor(..., { timeout })`)
- CI summary step flagging specs running near their budget (low priority; deferred)
