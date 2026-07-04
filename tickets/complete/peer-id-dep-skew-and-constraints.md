----
description: Aligned one package's identity-library version with the rest of the project and added an automated guard that fails the build if shared dependency versions ever drift apart again.
prereq:
files: yarn.config.cjs, package.json, packages/reference-peer/package.json, packages/db-core/package.json, packages/db-p2p/package.json, packages/quereus-plugin-crypto/package.json, packages/quereus-plugin-optimystic/package.json, yarn.lock, AGENTS.md
difficulty: medium
----

Completed. Origin: review finding eh-3 (dependency-drift), via `tickets/fix/peer-id-dep-skew-and-constraints.md`.

## What shipped

- **`@libp2p/peer-id` in reference-peer `^5.1.8` → `^6.0.4`** — aligns onto the single major every other workspace uses. reference-peer imports no `@libp2p/peer-id` in source (string peerIds only), so zero code risk.
- **`uint8arrays` declarations `^5.1.0` → `^6.1.1`** in reference-peer, db-core, db-p2p, quereus-plugin-crypto, quereus-plugin-optimystic — makes declarations match the root `resolutions` that already forced `^6.1.1`.
- **`yarn.config.cjs`** (new, Yarn 4 constraints) + `@yarnpkg/types@^4.0.1` root devDep. Two tiers:
  - `SINGLE_RANGE` (autofixable via `dep.update()`): `@libp2p/peer-id` → `^6.0.4`, `uint8arrays` → `^6.1.1`.
  - `SHARED_MAJOR` (major-only, `dep.error()`, not autofixable): `@libp2p/interface` → major 3, `@libp2p/crypto` → major 5.
- **`AGENTS.md`** — added a "Dependencies" section documenting the guard and `yarn constraints` / `--fix` workflow (was undocumented; contributors bumping shared deps need to know it can block them).

## Deviation from fix ticket (upheld in review)

The fix ticket sketched a single-range `@libp2p/interface: ^3.2.4`. The implementer instead made interface/crypto **major-only**, because forcing all packages onto `^3.2.4` resurfaces the deliberate 3.1/3.2 structural-typing split (`@libp2p/interface` 3.1.x pulls `uint8arraylist@^2`+`multiformats@^13`, 3.2.x pulls `^3`+`^14`; db-p2p builds only against the 3.1 line). This honors the fix ticket's own stated preference ("prefer enforcing a shared major") and the sibling ticket `optimystic-db-p2p-libp2p-dep-skew`. Reviewer confirms: sound, and interface/crypto declarations are byte-for-byte unchanged from HEAD.

## Review findings

Adversarial pass over the implement diff (yarn.config.cjs, six package.json files, yarn.lock, ticket docs). Reviewed from correctness, DRY, maintainability, coverage, and robustness angles.

- **Version alignment — correct.** `git show` confirms reference-peer peer-id `^5.1.8`→`^6.0.4` and the five uint8arrays bumps; yarn.lock's v5 peer-id entry dropped the direct `^5.1.8` pin (survivors purely transitive). No unintended edits.
- **Guard rejects violations — verified both tiers (implementer claimed only SINGLE_RANGE).** Probed non-destructively then reverted: setting reference-peer peer-id to `^5.1.8` → `Invalid field dependencies["@libp2p/peer-id"]; expected "^6.0.4", found "^5.1.8"` (exit 1); setting db-p2p interface to `^4.0.0` → `@libp2p/interface must stay within major ^3 (found ^4.0.0)...` (exit 1). Tree confirmed clean after both probes.
- **peerDependency autofix risk — none.** `Yarn.dependencies()` spans peerDeps, and `SINGLE_RANGE` calls `dep.update()`. Checked all package.json: no workspace declares `@libp2p/peer-id` or `uint8arrays` as a peerDependency, so no peer range gets clobbered. The storage-ns/rn/web packages declare interface/crypto in both deps and peerDeps, but those go through `SHARED_MAJOR` (report-only) and are all within major.
- **Coverage — complete.** Every workspace declaring the four guarded idents is within range; guard iterates all workspaces so new packages are covered automatically. db-p2p-storage-fs declares none of them.
- **Docs — was stale, fixed inline.** The guard was undocumented; added AGENTS.md "Dependencies" section. Other docs (docs/*.md) are conceptual/architecture and don't reference dependency ranges — no update needed.
- **Tripwire (from implementer, upheld):** transitive v4/v5 `@libp2p/peer-id` copies persist in yarn.lock (from `@libp2p/peer-id-factory` and the libp2p stack) beyond the guard's declaration-level reach. Parked as a `NOTE:` in yarn.config.cjs. Only actionable if a runtime `instanceof`/identity failure is traced to a transitive-vs-workspace peer-id copy; fix would be a root `resolutions` entry. Not a ticket.
- **`majorOf()` exotic-range robustness (tripwire):** regex `/^\D*(\d+)/` handles `^`/`~`/plain/`3.x`/`>=3 <4`; a url/git dep would parse to `null` and trip the guard as a *loud* error (not silent-wrong) — acceptable failure mode, and none exist for these idents today. Recorded here; no code change.
- **CI wiring — moot.** Implementer flagged `yarn constraints` isn't in CI; the repo has no CI workflows at all (only `.yarnrc.yml`), so there is nothing to wire into. No ticket.

### Validation (this review pass)

All streamed with `tee`, run from repo root.

- `yarn constraints` — exit 0 (clean). Both bad-pin probes → exit 1, then reverted; tree clean.
- `yarn build` (full topological) — exit 0. No `@libp2p/interface` structural-typing regression.
- `yarn test` (all workspaces) — exit 0, ~6m40s. Zero failures.
- `yarn lint` — exit 0.

**No major findings; no new tickets filed.** One minor fix applied inline (AGENTS.md docs). Two conditional concerns recorded as tripwires (transitive peer-id skew in yarn.config.cjs `NOTE:`; `majorOf` exotic ranges, noted above).
