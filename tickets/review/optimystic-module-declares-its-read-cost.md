description: The SQL plugin now tells the query planner how slow its storage is to read, by naming a storage category that matches its configured default transactor (network-backed tables count as slow), and a deployment can override the category. Needs a review pass.
architecture: packages/quereus-plugin-optimystic/README.md
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/cost-profile.ts (new), packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/test/cost-profile.spec.ts (new), packages/quereus-plugin-optimystic/test/access-plan-estimates.spec.ts, packages/quereus-plugin-optimystic/README.md, .release-notes.pending.md, packages/quereus-plugin-optimystic/package.json, packages/quereus-plugin-crypto/package.json, packages/rn-bundle-check/package.json, packages/upgrade-check/package.json, yarn.lock, packages/quereus-plugin-optimystic/src/transaction/quereus-version.ts (generated)
----
## What was built

Quereus 4.24 replaced `VirtualTableModule.expectedLatencyMs` with `costProfile?: ModuleCostProfile` (`{ firstRowLatencyMs?, perRowLatencyMs? }`) and publishes named categories in `COST_PRESETS` (`@quereus/quereus/src/vtab/cost-profile.ts`). `OptimysticModule` now declares one.

- **Where the category comes from.** `register` (`packages/quereus-plugin-optimystic/src/plugin.ts`) computes it once, as its first step, before anything is built, so a bad value refuses registration with no side effects: `moduleCostProfile(defaultTransactorOf(config), config.cost_profile)`.
- **`defaultTransactorOf`** (exported from `optimystic-module.ts`) is the `aux['default_transactor'] || 'network'` expression pulled out of `resolveBinding`, which now calls it behind its per-table `args['transactor']`. The binding and the cost profile therefore share one default.
- **`moduleCostProfile`** (new `src/optimystic-adapter/cost-profile.ts`, next to `offline-config.ts`). With no `cost_profile`, `'network'` maps to `COST_PRESETS.distributed` and everything else maps to `undefined` (plans like memory). A `cost_profile` replaces the mapping entirely. It can be a preset name, checked with `Object.hasOwn`, so `'toString'` is refused. Or it can be an object with only `firstRowLatencyMs` / `perRowLatencyMs`, each finite and ≥ 0, returned as a frozen copy holding only the given fields. Anything else throws. The `NOTE:` on why `network` maps to `distributed` sits at `transactorCostProfile`.
- **`OptimysticModule.costProfile`** is a plain `readonly` field, set from a new optional third constructor parameter. Its doc holds the mixed-transactor accepted-residual `NOTE:`, in one place only.
- **The three comments.** The class-doc "deliberately NOT declared" paragraph is replaced with a pointer to the field doc. The `initialize` accepted-tradeoff `NOTE:` now gives its own reason: no measured basis for a window, and a category supplies no number. The `getBestAccessPlan` `NOTE:` says the per-read cost is now declared and still forbids inflating the row count.
- **Quereus `^4.24.0`.** Dev, peer and `engines.quereus` ranges are bumped in the four manifests, and `yarn.lock` is updated. The build rewrote `quereus-version.ts` to `'4.24.0'`, so `QUEREUS_ENGINE_ID` is now `quereus@4.24.0`.
- **Docs.** The README § Plugin-Level Configuration table has a `cost_profile` row. `.release-notes.pending.md` has a new `# Unreleased` section above `# v1.23.0` with two entries: the planner cost, and "Requires Quereus 4.24.0", which includes the engine id change.

## Tests added

- `test/cost-profile.spec.ts`, seven cases over `moduleCostProfile`, one per branch: `network` → `distributed`; `test` → `undefined`; a preset name replacing the mapping; an object passed through; refusal of an unknown name (`'toString'`, which exercises the own-property check), an unknown key, and a negative or NaN field.
- `test/access-plan-estimates.spec.ts`: a sibling case in the GitHub #44 describe registers with `cost_profile: 'distributed'` over the `test` transactor. It asserts that the registered module carries `COST_PRESETS.distributed` and that the join still plans `HASHJOIN` with no `JOIN`. The table setup and plan collection moved into helpers (`openDatabase`, `planFilteredJoin`) shared with the existing case.

## Validation run

- `yarn workspace @optimystic/quereus-plugin-optimystic build` and `typecheck`: clean. Plugin `yarn test`: 1212 passing, 14 pending, 0 failing.
- `@optimystic/quereus-plugin-crypto` build and typecheck: clean. `packages/upgrade-check` `yarn test`: 213 passing.
- `yarn lint:deps` and `yarn lint:docs`: clean.
- **One-off run with every transactor forced to `distributed`** (hack in `transactorCostProfile`, since reverted and rebuilt). Plugin `yarn test`: 1211 passing, 14 pending, 1 failing. The one failure is the `cost-profile.spec.ts` case asserting `test` → `undefined`, which the hack breaks by design. There were no wrong results, hangs or latch errors. A probe under the same hack confirmed that the latency-gated rules really fire over optimystic leaves: `union all` of two tables planned `ASYNCGATHER`, and an equi-join planned `HASHJOIN > EAGERPREFETCH`, both returning the right rows. So the concurrent-`query()` path (`concurrencyMode = 'reentrant-reads'`) was actually exercised.

## Not run, and known gaps

- Root `yarn build`, root `yarn typecheck`, `yarn check:rn` and `yarn test:integration` were not run. No other package's source changed. `cost-profile.ts` uses `Object.hasOwn`, which db-core already uses, so the React Native bundle check should not be affected, but it was not run.
- The integration specs register `network`, so they now plan with `distributed`. That path was covered only by the forced-`distributed` run over the unit suites, not by running `test:integration`.
- Verified by inspection only, as the ticket allowed: the default with no config (both paths go through `defaultTransactorOf`); the mixed-transactor residual; `local` over host storage declaring nothing; and Quereus's registration warning being unreachable for this module, since the plugin refuses every bad field before Quereus sees it.
- The #44 sibling case shows the override reaches the module Quereus registers, and that the plan does not regress. It does not show a plan that *changes* because of the profile, since a declared latency can only push this join further from a nested loop. The probe above, which is not committed, is the evidence that the profile changes plans at all.
