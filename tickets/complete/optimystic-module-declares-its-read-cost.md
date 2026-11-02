description: The SQL plugin now tells the query planner how slow its storage is to read, by naming a storage category that matches its configured default transactor (network-backed tables count as slow), and a deployment can override the category.
architecture: packages/quereus-plugin-optimystic/README.md
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/cost-profile.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/test/cost-profile.spec.ts, packages/quereus-plugin-optimystic/test/access-plan-estimates.spec.ts, packages/quereus-plugin-optimystic/README.md, packages/quereus-plugin-optimystic/package.json, .release-notes.pending.md, packages/quereus-plugin-crypto/package.json, packages/rn-bundle-check/package.json, packages/upgrade-check/package.json, yarn.lock, packages/quereus-plugin-optimystic/src/transaction/quereus-version.ts
----
## What was built

Quereus 4.24 replaced `VirtualTableModule.expectedLatencyMs` with `costProfile?: ModuleCostProfile` and publishes storage categories in `COST_PRESETS` (`@quereus/quereus/src/vtab/cost-profile.ts`). `OptimysticModule` now declares one, chosen once by `register` in `packages/quereus-plugin-optimystic/src/plugin.ts` as `moduleCostProfile(defaultTransactorOf(config), config.cost_profile)`, before anything is built, so a bad value refuses registration with no side effects.

- `defaultTransactorOf` in `optimystic-module.ts` is the one `default_transactor || 'network'` rule; `resolveBinding` uses it too, so a table's binding and the cost profile share one default.
- `moduleCostProfile` in `optimystic-adapter/cost-profile.ts`: with no `cost_profile`, `network` → `COST_PRESETS.distributed`, every other transactor → `undefined` (plans like memory). A `cost_profile` replaces the mapping: a preset name (own-property check, so `'toString'` is refused) or an object with only `firstRowLatencyMs` / `perRowLatencyMs`, each finite and ≥ 0, returned as a frozen copy. Anything else throws. Since review, `undefined`, `null` and `''` all mean unset.
- `OptimysticModule.costProfile` is a `readonly` field set from a third constructor parameter; its doc carries the mixed-transactor accepted-residual `NOTE:`. The old "deliberately NOT declared" paragraph and the two `NOTE:`s that cited it were rewritten.
- Quereus `^4.24.0` in the four manifests (dev, peer, `engines.quereus`); `QUEREUS_ENGINE_ID` is now `quereus@4.24.0`. README § Plugin-Level Configuration has a `cost_profile` row; `.release-notes.pending.md` has an `# Unreleased` section with the planner-cost and Quereus-version entries.

Tests: `test/cost-profile.spec.ts`, one case per branch of `moduleCostProfile`; a sibling case in the GitHub #44 describe of `test/access-plan-estimates.spec.ts` that registers with `cost_profile: 'distributed'` and asserts the module carries the preset and the join still plans `HASHJOIN`.

## Review findings

Read the diff of `ticket(implement): optimystic-module-declares-its-read-cost` first, then the handoff, then Quereus's `cost-profile.ts`, its manifest type (`@quereus/quereus/src/vtab/manifest.ts`) and the quoomb-web settings form that consumes it.

- **Correctness / happy path.** Checked that Quereus reads `module.costProfile` on every plan (`resolveModuleCostProfile` in the planner) and once with a warning sink at `registerModule`, so a constructor-set readonly field is the right shape. Mapping, override and refusal paths read correct. No defect.
- **Docs that should have been touched — fixed.** The plugin manifest's `quereus.settings` list in `packages/quereus-plugin-optimystic/package.json` (what Quereus plugin loaders and the quoomb settings form show as the plugin's options) did not list `cost_profile`. Added it as a `select` with options `''`, `memory`, `localDisk`, `browserIdb`, `network`, `distributed`, default `''`.
- **Edge case — fixed.** A settings form sends an empty field as `''`, and SQL config can carry `null`. Both used to throw at `register` (`cost_profile '' is not a preset`), which would break any loader that offers the new setting and leaves it blank. They now mean unset, the same way `default_transactor` treats `''`. Added one test case (`reads an empty cost_profile as no declaration`); README row updated to say so.
- **Edge case — fixed.** A byte array (`Uint8Array` is a valid `SqlValue`) passed the object test: an empty one silently declared memory, a non-empty one threw a confusing `cost_profile.0 is not a cost profile field`. It now takes the "must be a preset name or an object" refusal, and the message names it as a byte array.
- **Type safety, DRY, modularity.** Validation is in its own small file beside `offline-config.ts`; the default-transactor rule exists once. No `any`. Nothing to change.
- **Tests.** Kept all eight `cost-profile.spec.ts` cases: each pins one branch of logic that has real branching. Kept the #44 sibling case: it is the only check that the override reaches the module Quereus plans with, and that the GitHub #44 plan does not regress under the category every `network` deployment now gets. Neither restates the implementation or verifies a mock.
- **Resource cleanup, performance.** Nothing allocated per plan; the profile is computed once per `register`. Nothing to change.
- **Tripwires / accepted tradeoffs.** The two `NOTE:`s the implementer added (network → distributed in small groups, at `transactorCostProfile`; mixed transactors priced as the default, at `OptimysticModule.costProfile`) say what was declined, why and when to revisit. Left as they are. No new tripwires.
- **Not in scope, left alone.** The manifest's `provides.functions` lists `StampId` but not `CommitOutlook`. That gap was there before this change.

## Validation

- `yarn workspace @optimystic/quereus-plugin-optimystic build` and `typecheck`: clean. ESLint over the changed source and spec files: clean. `yarn lint:docs`, `yarn constraints`: clean.
- Plugin `yarn test`: 1213 passing, 14 pending, 0 failing; smoke `quereus@4.24.0`.
- `yarn check:rn`: passed. The implementer had not run it.
- Not run: `yarn test:integration`, whose specs register `network` and so now plan with `distributed`. It runs too long for an agent. The implementer's one-off run with every transactor forced to `distributed` covered that planning path over the unit suites.
