description: Quereus 4.24 lets a table module say how slow its storage is to read, choosing from named categories such as local disk or network; the SQL plugin should declare the category its storage actually is, so the query planner stops costing network-backed tables as if they were in memory.
architecture: packages/quereus-plugin-optimystic/README.md
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/package.json, packages/quereus-plugin-crypto/package.json, packages/rn-bundle-check/package.json, packages/upgrade-check/package.json, ../quereus/packages/quereus/src/vtab/cost-profile.ts, ../quereus/packages/quereus/src/vtab/module.ts, ../quereus/packages/quereus/src/planner/nodes/reference.ts
----
## Background

Quereus 4.23 and 4.24 (released 2026-11-01) changed how a virtual-table module tells the planner what reading its tables costs:

- `VirtualTableModule.expectedLatencyMs` (one first-row latency number) is **removed**. In its place is `costProfile?: ModuleCostProfile` — `{ firstRowLatencyMs, perRowLatencyMs }` — in `@quereus/quereus/src/vtab/cost-profile.ts`.
- `COST_PRESETS` names five categories, and the Quereus docs say to pick the category rather than invent a number: `memory` (0 / 0), `localDisk` (0.05 / 0.004), `browserIdb` (1 / 0.01), `network` (40 / 0.04), `distributed` (100 / 0.2), in milliseconds (first row / per row).
- The planner reads `module.costProfile` each time it plans a table reference (`TableReferenceNode.computePhysical` in `@quereus/quereus/src/planner/nodes/reference.ts`), and once at registration to warn about a malformed value (`@quereus/quereus/src/schema/manager.ts`). Since it is read on every plan, a getter is allowed. The per-row cost is what moves join choices (a seek per outer row versus one scan) on remote tables.
- `getRowCount` (a module's in-memory row count) arrived as well. It is out of scope here: it must answer in constant time from memory, and this module keeps no row count per tree.

`OptimysticModule` declares no cost today. The `NOTE` on its `concurrencyMode` doc (in `optimystic-module.ts`) explains why: the module fronts transactors from in-memory (`test`) through local storage (`local`) to libp2p cohorts (`network`), and one static number per module would misestimate most deployments. Two other comments in the same file point at that note and name `expectedLatencyMs`: the accepted-tradeoff `NOTE` in `OptimysticVirtualTable.initialize`'s retry memo, and the `NOTE` above `tableRowCount` in `getBestAccessPlan`. Under Quereus 4.24 all three name a field that no longer exists.

Named categories weaken that objection, because the plugin knows which kind of transactor it is configured with. One `OptimysticModule` is built per plugin registration (`register` in `plugin.ts`), and the plugin config names the default transactor. But each table may name its own transactor in its `USING optimystic(...)` arguments, while `costProfile` belongs to the module, not the table.

## What to build

- The module declares a `costProfile` taken from `COST_PRESETS` by the transactor kind, so the planner sees roughly what reading costs. The plan stage settles where the kind comes from. The candidates are the plugin config's default transactor, read once in `register`, or a getter that reads the transactors the factory has actually opened. It also settles the mapping. Proposed: `test` and `mesh-test` → `memory`; `local` → `localDisk` on Node, `browserIdb` in a browser (whatever the factory can tell about its storage, without guessing); `network` → `distributed`, since a coordinator may consult its cohort before answering; a host-registered transactor → no declaration unless it supplies one.
- A deployment can override the category, or a measured field, through the plugin config (for example a `cost_profile` preset name), following the spread-and-override pattern in the Quereus docs. The plan decides whether this is worth adding now or should be left out.
- The three comments that name `expectedLatencyMs` are rewritten to describe what is actually declared and why. The accepted-tradeoff reasoning in `initialize` about damping windows should keep its substance, with its pointer corrected.
- Every `@quereus/quereus` range, peer range and `engines.quereus` moves to `^4.24.0`. `yarn.config.cjs` requires a peer range to equal its dev range and `engines.quereus` to equal the peer range, so they move together. `yarn lint:deps` must pass.
- `packages/quereus-plugin-optimystic/README.md` (or whichever doc owns the plugin's configuration) states what is declared and how to override it. `.release-notes.pending.md` gets an entry.

## Expected behavior

- A plugin configured for the `network` transactor plans a join between two optimystic tables with the network-category per-row cost present on the table references' physical properties. With the `test` transactor it plans as before (memory category, equal to declaring nothing). That is the one contract worth pinning in a test: the profile follows the transactor. Plan shapes are Quereus's business and are not asserted here.
- No change to results: the cost is a hint, and correctness never depends on it.
- The unknown-size row-count fallback in `getBestAccessPlan` (`UNKNOWN_TABLE_ROWS`, GitHub #44) stays as it is. Its `NOTE` already says a per-read cost, not an inflated row count, is the right way to make network scans look expensive. Check that the declared per-row latency does not bring back the seek-per-outer-row plan #44 fixed. `two-node-index-*` and the #44 regression spec in this package are the place to look.

## Open questions for the plan stage

- Tables in one database on different transactors (a `network` default with one `test` table, say) get the module's single profile. Decide whether that residual is acceptable, and record it as a `NOTE` at the declaration, or whether it calls for asking Quereus for a per-table cost. That would be an upstream dependency, which goes to `blocked/`.
