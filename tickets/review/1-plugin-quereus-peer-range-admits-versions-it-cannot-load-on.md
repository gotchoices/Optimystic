description: Both Quereus plugins declared a Quereus peer/engine range wide enough to admit versions they cannot actually run on; both are now raised to the version that already backs their dev dependency, so the published metadata matches reality.
files:
  - packages/quereus-plugin-optimystic/package.json (`peerDependencies['@quereus/quereus']`, `engines.quereus`)
  - packages/quereus-plugin-crypto/package.json (same two fields)
  - yarn.lock (workspace entries for both plugins)
----

# What changed

Both plugins declared `peerDependencies['@quereus/quereus']: '^4.3.0'` and `engines.quereus: '^4.3.0'`, while their `devDependencies['@quereus/quereus']` had already been bumped to `^4.19.4` (commit `9060cdc0`, "Quereus bump") to pick up the schema-differ type-alias fix (`561195502`, released in Quereus `v4.19.4`; see `tickets/complete/quereus-differ-treats-type-aliases-as-a-retype.md`). The peer/engine ranges never followed, so:

- `quereus-plugin-optimystic/src/optimystic-module.ts` imports `collectTableConstraintNames`, which Quereus first exports in `4.12.0` — a consumer on `4.3.0`–`4.11.x` would pass `npm install`'s peer check and then fail to load the plugin.
- A consumer on `4.12.0`–`4.19.3` would load the plugin fine but hit the type-alias retype defect the `4.19.4` bump exists to avoid.

## The fix

Raised both plugins' `peerDependencies['@quereus/quereus']` and `engines.quereus` from `^4.3.0` to `^4.19.4`, matching each plugin's already-bumped `devDependency`. Ran `yarn install` (picked up the new ranges in `yarn.lock`'s two workspace soft-link entries for these packages), then `yarn lint:deps` and `yarn constraints` — both clean, no new warnings.

### Why crypto was raised too, not just optimystic

`quereus-plugin-crypto/src/plugin.ts` only imports `Database`, `SqlValue`, `FunctionFlags`, `TEXT_TYPE`, `INTEGER_TYPE`, `BOOLEAN_TYPE` from `@quereus/quereus` — all present since Quereus `v4.3.0` (checked with `git show v4.3.0:packages/quereus/src/index.ts` in the sibling `../quereus` checkout). Nothing in crypto's own source requires newer than `4.3.0`, and crypto provides no vtables, so the schema-differ retype bug this bump was originally chased for doesn't even apply to it.

Raised it anyway, to `^4.19.4`, because the maintainer already treats the two plugins' Quereus dependency as kept in lockstep — commit `9060cdc0` bumped crypto's `devDependency` from `^4.19.2` to `^4.19.4` in the same commit as optimystic's, with no crypto-specific justification recorded. Diverging the peer/engine range now (crypto looser, optimystic tighter) would reintroduce exactly the kind of quiet drift the ticket was filed to close, for a package that has no real reason to support older Quereus separately. This is a judgment call, not a hard requirement — if a future crypto-only consumer genuinely needs to run against Quereus 4.3–4.19.3, loosening just `quereus-plugin-crypto`'s range back down is safe (nothing in its source depends on `4.19.4`).

### Docs / READMEs

Neither plugin's `README.md`, nor anything under `docs/`, states a minimum Quereus version anywhere — they only show `import` examples with no version number attached. `docs/review.html` mentions a `4.3.0` dev version in passing, but it's a dated, archived report ("Optimystic Code & Design Review — July 2026"), not a live doc; left untouched. So there was nothing to update in step 4 of the ticket.

### yarn.config.cjs / constraints

`@quereus/quereus` is not listed in `yarn.config.cjs`'s `SINGLE_RANGE` or in `scripts/shared-majors.cjs`'s `SHARED_MAJOR` — there is no cross-workspace constraint tying its peer range to its dev range. `yarn constraints` produced no output (clean) after the bump, so nothing needed loosening or satisfying beyond the `package.json` edits themselves.

## Validation performed

- `yarn install` — clean; `yarn.lock` diff is exactly the two workspace entries' `peerDependencies` line, `^4.3.0` → `^4.19.4`, for both plugins.
- `yarn lint:deps` — `check-libp2p-majors`: 5 guarded packages, 10 installed versions, each on its expected major. `check-undeclared-deps`: 927 files across 12 packages, every import declared. No new findings.
- `yarn constraints` — no output, no violations.
- No source change, no new test, per the ticket's own scope — this is package metadata only.

## Gaps / things the reviewer should double-check

- I did not run each plugin's own `test`/`typecheck` scripts (e.g. `quereus-plugin-optimystic`'s mocha suite + smoke test) — the ticket scoped this as metadata-only and the workspace-level `lint:deps`/`constraints` pair was the stated check. If the reviewer wants extra confidence, `yarn workspace @optimystic/quereus-plugin-optimystic run typecheck` and the equivalent for crypto would confirm the bumped dev dependency still typechecks cleanly (it already did before this ticket, since only the dev range changed hands here, not this run).
- I did not audit every other `@quereus/quereus` import across the codebase (e.g. `quereus-sync` in the sibling `../quereus` repo isn't part of this workspace) — out of scope, ticket named only these two plugins.
- The "kept in lockstep" call for crypto is a judgment call, documented above with its reasoning and an explicit reversal path, not a hard constraint — flagging in case the reviewer weighs it differently.
