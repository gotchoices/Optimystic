description: Aligned one package's identity-library version with the rest of the project and added an automated guard that fails the build if shared dependency versions ever drift apart again.
prereq:
files: yarn.config.cjs, package.json, packages/reference-peer/package.json, packages/db-core/package.json, packages/db-p2p/package.json, packages/quereus-plugin-crypto/package.json, packages/quereus-plugin-optimystic/package.json, yarn.lock
difficulty: medium
----

Implement handoff for review. Origin: review finding eh-3 (dependency-drift), via `tickets/fix/peer-id-dep-skew-and-constraints.md`.

## What was done

### 1. Version alignment (the actual fix)

- **`@libp2p/peer-id` bumped, not removed.** `packages/reference-peer/package.json` `^5.1.8` → `^6.0.4`, matching every other workspace package. I chose **bump** over remove (the ticket offered both) because it's the ticket-specified end state and reference-peer imports no `@libp2p/peer-id` in source (only string peerIds), so the bump carried zero code risk. `yarn.lock` confirms the direct `^5.1.8` pin dropped: the v5 lock entry went from `^5.0.0, ^5.1.8, ^5.1.9` to `^5.0.0, ^5.1.9` (the survivors are purely transitive — see tripwire).
- **`uint8arrays` declarations `^5.1.0` → `^6.1.1`** in reference-peer, db-core, db-p2p, quereus-plugin-crypto, quereus-plugin-optimystic. This only makes the declaration honest: the root `resolutions` in `package.json` already forced every install to `^6.1.1`, so nothing about the resolved tree changed — the guard just needs the declarations to match reality.

### 2. Constraints guard (`yarn.config.cjs`, new file at repo root)

Yarn 4 `defineConfig({ constraints })`. Added `@yarnpkg/types@^4.0.1` as a root devDependency for the typed API. Two tiers:

- **`SINGLE_RANGE` (hard-pinned, autofixable via `dep.update()`):** `@libp2p/peer-id` → `^6.0.4`, `uint8arrays` → `^6.1.1`. Any workspace declaring a different range fails `yarn constraints`; `yarn constraints --fix` rewrites it.
- **`SHARED_MAJOR` (major-only, reported via `dep.error()`, NOT autofixable):** `@libp2p/interface` → major `3`, `@libp2p/crypto` → major `5`. Enforces "stays within this major" while allowing minor drift. A future `^4`/`^6` bump trips the guard; a minor difference does not.

`yarn constraints` passes clean. Verified the guard *fails* by temporarily setting reference-peer's peer-id back to `^5.1.8` — it reported `Invalid field dependencies["@libp2p/peer-id"]; expected "^6.0.4", found "^5.1.8"` — then reverted the probe.

### DEVIATION FROM TICKET — read this

The ticket sketched a single-range constraint with `@libp2p/interface: '^3.2.4'` for all four idents. **That approach resurfaces the exact structural-typing split the ticket warned about**, and I changed the design because of it. Details:

- `@libp2p/interface@3.1.0` depends on `uint8arraylist@^2` + `multiformats@^13`.
- `@libp2p/interface@3.2.4` depends on `uint8arraylist@^3` + `multiformats@^14`.

So even though `3.1.0` and `3.2.4` are both major `3`, they drag in **different transitive majors** of `uint8arraylist` (2 vs 3) and `multiformats` (13 vs 14). db-p2p's source + its `it-length-prefixed` / `uint8arraylist@^2` deps build only against the 3.1.x line; db-core/reference-peer build against 3.2.x. When I first followed the ticket sketch literally (unify all to `^3.2.4` via `yarn constraints --fix`), db-p2p's build failed with `Stream is not assignable to Iterable<Uint8Array | Uint8ArrayList>` — a `Uint8ArrayList` v2-vs-v3 mismatch. That is the split the completed ticket `optimystic-db-p2p-libp2p-dep-skew` **deliberately left in place**.

Resolution: I reverted interface/crypto to their original per-package ranges and made the guard enforce **major-only** for those two idents. This honors the ticket's own stated preference ("prefer enforcing a shared major ... rather than an exact version") and its explicit fallback ("if that split does reappear ... back it off to ^3"). Net effect: the diff touches **only** peer-id + uint8arrays declarations (plus the guard file and the `@yarnpkg/types` devDep) — interface/crypto declarations are byte-for-byte unchanged from HEAD.

## Residual drift left intentionally

- **`@libp2p/interface`:** `^3.1.0` (db-p2p, quereus-plugin-optimystic, storage-web/rn/ns) vs `^3.2.4` (db-core, reference-peer). This is the deliberate split above; the guard permits it (both major 3) and forbids crossing to `^4`.
- **`@libp2p/crypto`:** `^5.1.13` (most) vs `^5.1.19` (db-p2p). Minor drift within major 5; guard permits, forbids `^6`.

## Tripwire recorded (NOT a ticket)

Transitive `@libp2p/peer-id` v5 (`^5.0.0`/`^5.1.9`) and v4 (`^4.2.4`, via `@libp2p/peer-id-factory`) still resolve in `yarn.lock` after this change — they come from the libp2p stack and `@libp2p/peer-id-factory`, not from workspace `package.json` files, so the guard can't reach them. Fine now (workspace-authored code is single-major). Only becomes work if a runtime `instanceof`/identity failure is traced to a transitive-vs-workspace peer-id copy; fix then would be a root `resolutions` entry for `@libp2p/peer-id`. Parked as a `NOTE:` comment in `yarn.config.cjs` next to the `@libp2p/peer-id` entry.

## Validation performed

All streamed with `tee`. Commands run from repo root (`C:\projects\optimystic`) unless noted.

- `yarn install` — reconciled lockfile; direct v5 peer-id pin dropped as expected.
- `yarn constraints` — passes clean (exit 0). Bad-pin probe confirmed it fails, then reverted.
- `yarn build` (full topological, `yarn workspaces foreach -At run build`) — passes (exit 0). Confirms no `@libp2p/interface` structural-typing regression (the first attempt with the naive single-range constraint DID fail here — that's how the deviation above was caught).
- `yarn test` (full, all workspaces) — passes (exit 0). Totals: 1139 (btree) + 1146 (+36 pending) + 25 + 27 + 24 + 12 + 125 + 304 (+11 pending, integration mesh) + 6 + 258. Zero failures.

## For the reviewer — where to look / known gaps

- **Tests are a floor.** The peer-id bump is validated only indirectly: reference-peer imports no peer-id, so no test exercises "peer-id minted by v6 crosses an `instanceof` boundary." The real-world failure mode (two majors loaded at once) is what the tripwire is about — it isn't reproduced by any test here.
- **Guard coverage is declaration-level, not resolution-level.** `yarn constraints` checks what packages *declare*, not what `yarn.lock` *resolves*. It cannot catch transitive divergence (that's the tripwire). If you want lockfile-level enforcement, that's a separate, larger mechanism — out of scope here.
- **`SHARED_MAJOR` uses `dep.error()`, so `yarn constraints --fix` will not auto-repair a major mismatch** — by design (the guard can't know which minor a package needs). A future `^4` interface bump will *report* but not *fix*; a human must decide. Worth confirming you agree with that ergonomics choice.
- **`majorOf()` in `yarn.config.cjs`** parses the leading integer from the range string (`/^\D*(\d+)/`). It handles `^`, `~`, and plain ranges. It does NOT handle exotic ranges (`>=3 <4`, `3.x`, url/git deps) — none exist for these idents today, but a reviewer eyeballing robustness should note it.
- **CI:** `yarn constraints` is CI-runnable (exit 1 on violation) but nothing was wired into a CI config here — adding it to the pipeline is a follow-up if desired.

## Review findings

- Dependency-drift fix landed: `@libp2p/peer-id` and `uint8arrays` are now single-range across all workspaces, enforced by `yarn.config.cjs`. Deviated from the ticket's `@libp2p/interface: ^3.2.4` single-range sketch to a **major-only** guard for interface/crypto, because the single-range approach resurfaced the deliberate 3.1/3.2 structural-typing split (transitive `uint8arraylist`/`multiformats` major mismatch) — full analysis under "DEVIATION FROM TICKET" above.
- Tripwire: transitive v4/v5 `@libp2p/peer-id` copies persist in `yarn.lock` post-fix; parked as a `NOTE:` in `yarn.config.cjs`. Only actionable if a runtime identity failure is traced to a transitive-vs-workspace peer-id copy.
