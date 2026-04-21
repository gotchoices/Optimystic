description: Per-test Mocha timeout discipline enforced in db-core (5s), db-p2p (10s), and quereus-plugin-optimystic (10s) via `.mocharc.json` defaults. Explicit per-suite/per-test overrides audited; redundant defensive ones removed, legitimate ones annotated.
dependencies: none
files:
  - packages/db-core/.mocharc.json (new)
  - packages/db-p2p/.mocharc.json (new)
  - packages/quereus-plugin-optimystic/.mocharc.json (new)
  - packages/quereus-plugin-optimystic/package.json (removed duplicate --timeout 10000)
  - packages/db-p2p/test/transaction-state-store.spec.ts (removed redundant 10s overrides on 2 suites)
  - packages/db-p2p/test/cluster-coordinator.spec.ts (annotated 15s override)
  - packages/db-p2p/test/block-transfer.spec.ts (annotated 5s tightening)
  - packages/db-p2p/test/fresh-node-ddl.spec.ts (lifted 5s to describe-level, annotated)
  - packages/db-p2p/test/fresh-node-ddl-libp2p.spec.ts (annotated 30s override)
  - packages/quereus-plugin-optimystic/test/distributed-quereus.spec.ts (annotated 120s override)
  - packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts (annotated 120s override)
  - packages/quereus-plugin-optimystic/test/index-support.spec.ts (annotated 30s override)
----

## What shipped

Each of the three Mocha-driven packages now has a `.mocharc.json` at its root
declaring a per-test timeout default appropriate to the work the package does:

- `packages/db-core/.mocharc.json` — `5000` ms. Pure unit tests.
- `packages/db-p2p/.mocharc.json` — `10000` ms. Mesh harness setup is the slow part;
  individual ops should finish in seconds.
- `packages/quereus-plugin-optimystic/.mocharc.json` — `10000` ms. Quereus engine
  boot + plugin registration dominate; SQL operations themselves are fast.

The `--timeout 10000` flag was removed from the quereus-plugin-optimystic `test` /
`test:verbose` scripts in `package.json` since the mocharc now supplies it.

## Explicit overrides audit

Kept (each has a one-line comment explaining why):

| File | Budget | Reason |
| --- | --- | --- |
| `db-p2p/test/cluster-coordinator.spec.ts` | 15s | Real setTimeout delays totaling ~4.5s per case across sequential retries |
| `db-p2p/test/block-transfer.spec.ts` (concurrency limiting / `it`) | 5s | Tighter than 10s default — forcing-function for concurrency deadlock |
| `db-p2p/test/fresh-node-ddl.spec.ts` (describe-level) | 5s | Tighter than 10s — forcing-function for solo-node DDL hang (ticket 4/5) |
| `db-p2p/test/fresh-node-ddl-libp2p.spec.ts` | 30s | Real libp2p boot + TCP listener + arachnode init |
| `quereus-plugin-optimystic/test/distributed-quereus.spec.ts` | 120s | 3-node real libp2p mesh + distributed SQL |
| `quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts` | 120s | 3-node real libp2p mesh + fs storage + cross-peer transaction validation |
| `quereus-plugin-optimystic/test/index-support.spec.ts` (`beforeEach`) | 30s | Table + 3 indexes + 100 row inserts |

Removed as redundant (matched the new package default exactly and added no signal):

- `db-p2p/test/transaction-state-store.spec.ts` — `ClusterCoordinator recovery` and
  `ClusterMember recovery` describe blocks: `this.timeout(10000)` removed.
- `db-p2p/test/fresh-node-ddl.spec.ts` — per-it 5s overrides deduped by lifting
  `this.timeout(5_000)` to the describe level.

## Validation

Full test matrix was run from each package directory after the changes:

- `packages/db-core` → **287 passing** (~1s wall)
- `packages/db-p2p` → **396 passing** (~21s wall)
- `packages/quereus-plugin-optimystic` → **182 passing + 1 pending** (~3min wall)

All green. No per-test timeouts triggered.

## Review focus

- Verify the three `.mocharc.json` files are picked up by each package's `yarn test`
  (mocha auto-discovers them from cwd — the runs above confirm no regressions, but
  an explicit sanity check is to flip any kept budget temporarily and confirm a
  timeout fires with the expected "Timeout of Xms exceeded" message).
- Sanity-check the removed overrides in `transaction-state-store.spec.ts`: these
  tests only exercise `MemoryKVStore` + `PersistentTransactionStateStore`, so 10s
  is far beyond what's needed and the package default is sufficient.
- The `fresh-node-ddl.spec.ts` lift from per-test to describe-level is behaviorally
  identical (mocha inherits describe timeouts to nested its) but makes the "tighter
  than default" intent visible in one place.

## Out of scope (stayed out)

- Rewriting any slow test to be faster.
- Per-assertion timeouts (e.g. `waitFor(..., { timeout })`).
- CI summary step flagging specs that run near their budget (ticket called this
  optional / low priority; not implemented).
