description: Quereus 4.24 lets a table module say how slow its storage is to read, by naming a category such as local disk or network. The SQL plugin should declare the category that matches its configured storage, and let a deployment override it, so the query planner stops costing network-backed tables as if they were in memory.
architecture: packages/quereus-plugin-optimystic/README.md
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/cost-profile.ts (new), packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/test/access-plan-estimates.spec.ts, packages/quereus-plugin-optimystic/test/cost-profile.spec.ts (new), packages/quereus-plugin-optimystic/README.md, packages/quereus-plugin-optimystic/package.json, packages/quereus-plugin-optimystic/src/transaction/quereus-version.ts (generated), packages/quereus-plugin-crypto/package.json, packages/rn-bundle-check/package.json, packages/upgrade-check/package.json, yarn.lock, .release-notes.pending.md, ../quereus/packages/quereus/src/vtab/cost-profile.ts, ../quereus/packages/quereus/src/planner/nodes/reference.ts, ../quereus/packages/quereus/src/planner/rules/join/index-nested-loop.ts
----
## Background

Quereus 4.23 and 4.24 removed `VirtualTableModule.expectedLatencyMs` and replaced it with `costProfile?: ModuleCostProfile` — `{ firstRowLatencyMs?, perRowLatencyMs? }`, in milliseconds, with an omitted field read as 0 (`@quereus/quereus/src/vtab/cost-profile.ts`). Quereus publishes five named categories in `COST_PRESETS`: `memory` (0 / 0), `localDisk` (0.05 / 0.004), `browserIdb` (1 / 0.01), `network` (40 / 0.04) and `distributed` (100 / 0.2), and asks modules to pick a category rather than invent a number. `COST_PRESETS`, `resolveModuleCostProfile` and the `ModuleCostProfile` type are all exported from the `@quereus/quereus` root.

The planner reads `module.costProfile` each time it plans a table reference (`TableReferenceNode.computePhysical` in `@quereus/quereus/src/planner/nodes/reference.ts`) and turns it into the leaf's `expectedLatencyMs` / `expectedRowLatencyMs`. That number feeds three things:

- The index-nested-loop join price. One seek costs `firstRowLatencyMs + rowsPerSeek × perRowLatencyMs` (`perSeekLatencyMs` in `@quereus/quereus/src/planner/rules/join/index-nested-loop.ts`). For this module that number describes something real: every `query()` call pulls from the log first (`collection.update()`), so on a remote table each seek costs at least one round trip.
- The parallel, batched-outer and eager-prefetch rules, which only fire at or above 25 ms (`tuning.parallel.*ThresholdMs`). `network` and `distributed` are above that threshold. The in-process categories are below it.
- Nothing about results. The cost is a hint only.

`OptimysticModule` declares nothing today. Three comments in `packages/quereus-plugin-optimystic/src/optimystic-module.ts` explain why and name the field that no longer exists:

- the "`expectedLatencyMs` is deliberately NOT declared" paragraph in the class doc above `concurrencyMode`;
- the accepted-tradeoff `NOTE:` in `OptimysticVirtualTable.initialize`, which points at that paragraph ("the same reasoning that made this module decline to declare `expectedLatencyMs`");
- the `NOTE:` above `tableRowCount` in `getBestAccessPlan`, which says a per-read cost, not an inflated row count, is the right way to make network scans look expensive.

## Design (settled)

### Where the transactor kind comes from: the plugin config, read once at `register`

`register` in `plugin.ts` builds exactly one `OptimysticModule` per plugin registration. The module's profile comes from the **default transactor**, resolved the same way `resolveBinding` resolves it today: `aux['default_transactor']`, else `'network'`. Pull that expression out of `resolveBinding` into a small exported function in `optimystic-module.ts` (for example `defaultTransactorOf(aux)`). `resolveBinding` keeps its per-table `args['transactor'] || …` in front of it, and `register` calls it to choose the profile. That way the two can never pick different defaults.

Rejected: a getter that reads the transactors the factory has actually opened. Tables initialize lazily, on first touch, so the first statement against a session would be planned before any transactor exists. After that, the same SQL would get different costs depending on which tables happened to have opened, and a statement prepared earlier keeps the plan it was given. A deterministic value at registration avoids all of this.

### The mapping

Put a pure function in a new `src/optimystic-adapter/cost-profile.ts`, next to `offline-config.ts`, which plays the same role for another config key: `moduleCostProfile(defaultTransactor: string, declared: unknown): ModuleCostProfile | undefined`.

| default transactor | profile | why |
|---|---|---|
| `network` | `COST_PRESETS.distributed` | A read can leave the machine, and a coordinator answering outside its read-repair window consults its cohort before it answers. |
| `test`, `mesh-test` | none (same as `memory`) | Both run in process. |
| `local` | none | With no `rawStorageFactory` it is `MemoryRawStorage`. With one, the factory is an opaque function and the plugin cannot tell disk from IndexedDB from MMKV, so it does not guess. The host declares it (below). |
| anything else (a host-registered or custom transactor) | none | The plugin knows nothing about it. The host declares it. |

**Why `distributed` and not `network` or nothing, given that small groups read locally.** When a node is one of a block's responsible peers, it answers a read from its own replica (`selfReadVerdict` in `packages/db-p2p/src/libp2p-key-network.ts`). In a group no larger than one cohort, which includes the ordinary one- and two-machine deployments, network reads therefore usually run at local speed, and `distributed` overstates them. The plugin cannot see the group's size at registration. The two possible errors do not cost the same:

- **Overstating** costs a little planner overhead: scans preferred over seeks, plus the parallel and prefetch rules firing on reads that turn out to be cheap.
- **Understating** brings back one round trip per outer row on a genuinely remote table.

So the default leans toward the cheaper error. Record this as a `NOTE:` at the mapping, and document the override for small deployments.

### The override: `cost_profile` in the plugin config

The plugin cannot know the right answer for `local` with host storage, or for host-registered transactors, so the override is needed now. Accepted shapes:

- a preset name, verbatim from Quereus: `'memory' | 'localDisk' | 'browserIdb' | 'network' | 'distributed'`;
- a `ModuleCostProfile` object, so a host can follow Quereus's spread-and-override pattern itself: `cost_profile: { ...COST_PRESETS.network, perRowLatencyMs: 0.02 }`. Like `cohort_topic` and `rawStorageFactory`, an object can only be passed through `register()`.

When present, the override replaces the mapping entirely. Bad input throws at `register`, matching how `offline` and `link_round_trip_ms` refuse a wrong value instead of silently running a different configuration:

- an unknown preset name;
- an object with a key other than the two fields;
- a field that is not a finite, non-negative number;
- any other type.

Quereus would otherwise replace a bad field with 0 and log a warning (`resolveModuleCostProfile`). Refusing up front is stricter, and that is deliberate.

### The module

`OptimysticModule` gains `readonly costProfile?: ModuleCostProfile`, set from a new optional third constructor parameter. The two specs that build the module with two arguments (`access-plan-estimates.spec.ts`, `ordering-claim-guard.spec.ts`) keep compiling unchanged. `register` computes `moduleCostProfile(defaultTransactorOf(config), config.cost_profile)` and passes it in. A plain field is enough, since the value never changes after registration.

### Several transactors in one database: an accepted residual, not a blocker

`costProfile` belongs to the module, not the table, so a table that names a different transactor gets the module's profile. This happens through `using optimystic(…, transactor=…)`, or through a session's `default_vtab_args` that differs from `default_transactor`. Accept this and record it as a `NOTE:` at the declaration. The reasoning: the binding is never persisted, and `hydrate` binds every table the same way from the session or plugin config (README § *Warm Restart*). A production database therefore runs every table on one transactor. Mixed transactors in one database are a test and development arrangement, and a cost hint that is wrong there changes no result. The note's revisit condition: a deployment that genuinely mixes transactors and shows bad plans. That would need a per-table cost from Quereus, which is an upstream request and should go to `blocked/` if it ever comes up.

### The three comments

- **Class doc.** Replace the "deliberately NOT declared" paragraph with what is declared, where the category comes from, the override, and the mixed-transactor residual. The residual's `NOTE:` can live here or at the field, but in one place only.
- **`initialize` accepted-tradeoff `NOTE:`.** Keep its substance: un-damped retry, no basis for choosing a window, damp in the transactor layer if storms show up. Replace the parenthetical pointer with the actual reason, which is that this layer has no measured basis for a window. The cost profile is a category, not a measurement, so it supplies no number for a window either. Do not leave a pointer to a paragraph that no longer argues the point.
- **`getBestAccessPlan` `NOTE:`.** Say the per-read cost is now declared (`costProfile`, chosen at registration), and keep the instruction never to inflate the row count. The backlog pointer `feat-optimystic-persisted-planner-statistics` stays.

`UNKNOWN_TABLE_ROWS` and the rest of `getBestAccessPlan` do not change.

### Quereus range bump to `^4.24.0`

Move every `@quereus/quereus` dev range, peer range and `engines.quereus` to `^4.24.0`:

- `packages/quereus-plugin-optimystic/package.json`: dev, peer and engines;
- `packages/quereus-plugin-crypto/package.json`: dev, peer and engines;
- `packages/rn-bundle-check/package.json` and `packages/upgrade-check/package.json`: their `@quereus/quereus` ranges.

`yarn.config.cjs` requires a peer range to equal its dev range and `engines.quereus` to equal the peer range. Run `yarn install` so `yarn.lock` records the new ranges. The root resolves `@quereus/quereus` through `portal:../quereus/packages/quereus`, which is already 4.24.0. Then run `yarn lint:deps`.

The plugin build rewrites the committed `src/transaction/quereus-version.ts` from `'4.22.0'` to `'4.24.0'`, which changes `QUEREUS_ENGINE_ID` to `quereus@4.24.0`. That is the expected one-line diff of a Quereus bump. Mention it in the release note: machines that re-check transactions compare engine ids, so mixed builds disagree.

## Edge cases & interactions

- **The #44 seek-per-outer-row plan must not come back** (GitHub #44; `UNKNOWN_TABLE_ROWS`). By construction, a declared latency raises the price of a nested-loop seek and leaves the scan's row count alone. Verify with a **test**: a sibling case in the existing `Join plan over un-analyzed Optimystic tables (GitHub #44)` describe in `test/access-plan-estimates.spec.ts`. Register with `default_transactor: 'test'` and `cost_profile: 'distributed'`, run the same join, and assert the plan still has `HASHJOIN` and no `JOIN`. This also proves the override reaches the planner end to end through `register`, without building a network node.
- **Latency-gated rules start firing on network-backed plans.** At `distributed` the first-row latency of 100 ms is above the 25 ms gates, so Quereus may add parallel gathers, batched outers or eager prefetch over optimystic leaves. These issue concurrent `query()` calls on one connected table, which `concurrencyMode = 'reentrant-reads'` already promises are safe (the audit in the class doc). The test suites register `test` or host transactors, so none of them exercises this path. **Verify by a one-off run, not a committed test.** Temporarily make `moduleCostProfile` return `COST_PRESETS.distributed` for every kind, run the plugin package's full `yarn test`, then revert the hack. Report the outcome in the review handoff. Do not chase or record plan-shape differences, which are Quereus's business. A failure in results, a hang or a latch error is a real finding: fix it if it is in this repo, and file it otherwise.
- **The mapping and the override.** Verify with a **test**: a new `test/cost-profile.spec.ts` over `moduleCostProfile`. It should cover `network` → `distributed`; `test` → `undefined`; a preset-name override replacing the mapping; an object override passed through; and one refusal each for an unknown name, an unknown key, and a negative or non-finite field. This branching is the contract the ticket asked to pin: the profile follows the transactor. One spec, no per-kind duplication beyond what the branches need.
- **Default with no config at all.** `default_transactor` is absent, so the default is `network` and the profile is `distributed`, the same default `resolveBinding` uses. Verify **by inspection**: both go through the one extracted function.
- **Mixed transactors in one database.** Accepted residual; the `NOTE:` above. Verify **by inspection**.
- **`local` with host persistent storage.** No declaration unless the host passes `cost_profile`. The README tells hosts to declare `'localDisk'` (file, LevelDB, SQLite, MMKV) or `'browserIdb'`. Verify **by inspection**.
- **Quereus's registration warning** (`SchemaManager.registerModule` resolves the profile once and warns about bad fields). The override's own validation means it can never trigger for this module. Verify **by inspection**.
- **Plugin-crypto and the other workspaces** only change ranges. Verify with `yarn lint:deps` and the build.

## Documentation

- `packages/quereus-plugin-optimystic/README.md` § *Plugin-Level Configuration*: add a `cost_profile` row to the table. It should cover what is declared by default (the mapping above, in a sentence or two), the two accepted shapes, that bad values are refused at `register`, and when to override: a small group whose nodes hold every block (consider `'localDisk'` or `'network'`), `local` with persistent host storage, and a host-registered transactor. It should also say that the profile applies to every table registered through that plugin, whichever transactor a table names.
- `.release-notes.pending.md`: a new entry at the top, under an unreleased heading above `# v1.23.0` (that release already shipped). Cover the planner now costing network-backed tables by default, the `cost_profile` override, the Quereus 4.24 requirement (peer and engines range), and the engine id change.
- Citations follow AGENTS.md § Documentation citations: symbols, not line numbers. Run `yarn lint:docs`.

## TODO

- Extract the default-transactor expression from `resolveBinding` into an exported function in `optimystic-module.ts`, and use it there.
- Add `src/optimystic-adapter/cost-profile.ts` with `moduleCostProfile` (mapping, override parsing and refusals). Put the `NOTE:` explaining why `network` maps to `distributed` there.
- Give `OptimysticModule` an optional third constructor parameter and a `readonly costProfile` field. Wire it in `register` in `plugin.ts`.
- Rewrite the three comments in `optimystic-module.ts` as described, including the mixed-transactor `NOTE:`.
- Bump the `@quereus/quereus` dev range, peer range and `engines.quereus` to `^4.24.0` in the four package manifests; run `yarn install` and `yarn lint:deps`.
- Add `test/cost-profile.spec.ts` and the #44 sibling case in `test/access-plan-estimates.spec.ts`.
- Build the plugin (which rewrites `quereus-version.ts`), then run `yarn typecheck` and the plugin package's `yarn test`.
- Do the one-off run with every kind forced to `distributed`, revert the hack, and record the result in the handoff.
- Update the README configuration table and `.release-notes.pending.md`; run `yarn lint:docs`.
