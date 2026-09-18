description: Both Quereus plugins declared a Quereus peer/engine range wide enough to admit versions they cannot actually run on; both are now raised to the version that already backs their dev dependency, and a dependency check now stops peer ranges drifting from the tested dev range again.
files:
  - packages/quereus-plugin-optimystic/package.json (`peerDependencies['@quereus/quereus']`, `engines.quereus`)
  - packages/quereus-plugin-crypto/package.json (same two fields)
  - yarn.lock (workspace entries for both plugins)
  - yarn.config.cjs (new peer-vs-dev and engines-vs-peer constraints)
  - AGENTS.md (§ Dependencies), docs/releasing.md (`yarn lint:deps` row)
----

# What changed

Both plugins declared `peerDependencies['@quereus/quereus']: '^4.3.0'` and `engines.quereus: '^4.3.0'` while their `devDependencies['@quereus/quereus']` had already moved to `^4.19.4` (commit `9060cdc0`, for the schema-differ type-alias fix released in Quereus 4.19.4). `quereus-plugin-optimystic` imports `collectTableConstraintNames`, first exported in Quereus 4.12.0, so a consumer on 4.3–4.11 passed the peer check and then failed to load; a consumer on 4.12–4.19.3 loaded but hit the type-alias retype defect.

Implement stage raised both plugins' peer range and `engines.quereus` to `^4.19.4` (matching dev) and refreshed `yarn.lock`. `quereus-plugin-crypto` was raised too, by judgment: its own source only needs 4.3.0, but the maintainer keeps the two plugins' Quereus dependency in lockstep. Loosening crypto alone later is safe as far as its source goes — but see the new constraint below, which would then also require lowering its dev range.

Review stage added a class-level guard in `yarn.config.cjs` (run by `yarn constraints`, hence `yarn lint:deps` and `yarn check`):

- every `peerDependencies` range must equal the same package's `devDependencies` range in that workspace, when both are declared;
- a workspace's `engines.quereus` must equal its `@quereus/quereus` peer range.

Both report via `error()` (no autofix — the guard cannot tell which side is stale). Documented in `AGENTS.md` § Dependencies and the `yarn lint:deps` row of `docs/releasing.md`.

## Review findings

**Diff read first** (`3de6cea3`): the two `package.json` edits and two `yarn.lock` peer lines are exactly as described; no stray changes.

**Correctness of the version claims — verified.** Parsed every named import from `@quereus/quereus` across both plugins' `src/` (38 names) and checked each against `packages/quereus/src/index.ts` at Quereus tags in the sibling `../quereus` checkout: at `v4.11.0` only `collectTableConstraintNames` is missing; at `v4.12.0` and later all are present. At `v4.3.0`, `ForeignKeyConstraintSchema` and `builtinCollationResolver` are also absent — all three are optimystic-only imports; every crypto import exists at 4.3.0. So the ticket's "4.12.0 is the hard floor for optimystic, crypto needs only 4.3.0" holds. (Text-level check of `index.ts`, not a type-resolution check; adequate for "is this exported at all".)

**Runtime relevance of `engines.quereus` — checked.** Nothing in this repo or in `../quereus` reads `engines.quereus`; it is manifest metadata only, so the change affects install-time advice, not load behavior.

**Class behind the instance — fixed inline (rung 3, boundary invariant).** Root cause of the drift: nothing tied the peer range to the dev range, and the root `upgrade:quereus` script uses `npm-check-updates`, which by default does not touch `peerDependencies` — so a routine Quereus bump moves dev and silently leaves peer behind. Rather than file a ticket, added the two constraints above. Before adding them, confirmed every workspace that declares a package as both peer and dev (the three `db-p2p-storage-*` packages on `@libp2p/crypto`/`@libp2p/interface`, and the two plugins) already has equal ranges, so the rule is clean on the tree today. Verified it fires: temporarily set crypto's peer range back to `^4.3.0`, `yarn constraints` exited 1 with both messages (peer≠dev, engines≠peer); restored the file and confirmed `git diff` showed no change to it. I did not change `upgrade:quereus` to include peer deps — `npm-check-updates` isn't a declared dependency so its flag set couldn't be verified here; the constraint catches the drift either way.

**Tradeoff introduced by the constraint:** a workspace can no longer deliberately advertise a peer range looser than what it tests against (e.g. crypto supporting Quereus 4.3+ while developing on 4.19.4). That is intended — an untested floor is exactly this bug — and the error message says how to satisfy it. If a looser peer floor is ever genuinely wanted, the constraint is the one place to carve an exception.

**Docs:** neither plugin README nor anything under `docs/` states a minimum Quereus version (confirmed, implementer's claim holds). Updated `AGENTS.md` § Dependencies and `docs/releasing.md` to describe the new check. `docs/review.html` mentions 4.3.0 in an archived dated report; left alone. `yarn lint:docs` clean.

**Validation run:**
- `yarn constraints` — clean; `yarn lint:deps` — clean (5 guarded libp2p packages on expected majors; 927 files, all imports declared).
- `yarn workspace @optimystic/quereus-plugin-crypto run typecheck` and `... quereus-plugin-optimystic run typecheck` — clean.
- `quereus-plugin-crypto` tests — 125 passing.
- `quereus-plugin-optimystic` tests — 997 passing, 13 pending; smoke test `smoke ok quereus@4.19.4`. (First run refused on a stale `db-core` `dist/` left by an earlier ticket's source change; rebuilt `db-core` — `dist/` is git-ignored — and reran.)

**Empty categories, with reason:** no source code changed (metadata + build config only), so SPP/DRY/performance/resource-cleanup/type-safety findings don't apply; no tests added beyond the manual constraint fire-check, since `yarn constraints` itself is the test and there is no harness for `yarn.config.cjs` rules (the existing `SINGLE_RANGE`/`SHARED_MAJOR` rules have none either). No tripwires recorded; no tickets filed.
