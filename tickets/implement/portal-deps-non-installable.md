description: Make a fresh clone install without needing two unrelated sibling projects checked out next to it, by defaulting the two offending dependencies to their published npm versions and making the local-folder overlay opt-in.
prereq:
files: package.json, packages/substrate-simulator/package.json, packages/quereus-plugin-crypto/package.json, packages/quereus-plugin-optimystic/package.json, yarn.lock, README.md
difficulty: medium
----

## Problem (reproduced)

Root `package.json` `resolutions` force two dependencies to on-disk sibling checkouts via the `portal:` protocol (resolves to a path *outside* the repo):

- `package.json:13` — `"@quereus/quereus": "portal:../quereus/packages/quereus"`
- `package.json:14` — `"p2p-fret": "portal:../Fret/packages/fret"`

And `packages/substrate-simulator/package.json:36` declares `p2p-fret` directly as `portal:../../../Fret/packages/fret`.

`yarn.lock` pins the portal locators (`yarn.lock:1665` quereus portal, `yarn.lock:4420` fret portal, `yarn.lock:1651` substrate-simulator portal). A fresh `git clone` + `yarn install` therefore fails unless `../quereus` and `../Fret` are also checked out at compatible versions — breaking CI and new contributors.

## Research findings (settled — no human decision needed)

Both packages **are published to the public npm registry** at versions that match the semver ranges the workspace already declares, so the "consume published versions by default" remediation is available:

| package | latest on npm | range declared in sub-packages | local sibling version |
|---|---|---|---|
| `@quereus/quereus` | `4.3.0` | `^4.3.0` (`quereus-plugin-crypto`, `quereus-plugin-optimystic` devDeps) | `4.3.0` |
| `p2p-fret` | `0.6.0` | `^0.6.0` (`db-p2p`) | `0.6.0` |

The local sibling checkouts are at *exactly* the published versions, so replacing portal locators with npm resolutions is a clean swap — no version skew, no code changes to consumers (imports in e.g. `packages/db-p2p/src/cluster/*` are unaffected).

Because the sub-packages already declare correct semver ranges, only the **root `resolutions` overrides** and the **`substrate-simulator` direct dep** actually force `portal:`. Removing them lets normal semver resolution pull from npm.

### Unmasked side-effect (must handle in this ticket)

The global portal resolution currently satisfies, by fiat, the stale peer ranges in the two plugin packages:

- `packages/quereus-plugin-crypto/package.json:50` — `peerDependencies["@quereus/quereus"]: "^0.16.2"` and `:53` `engines.quereus: "^0.16.2"`
- `packages/quereus-plugin-optimystic/package.json:69` — `peerDependencies["@quereus/quereus"]: "^0.16.2"` and `:72` `engines.quereus: "^0.16.2"`

Both packages' **devDependency** is already `^4.3.0`. Once the resolution is removed, resolution follows the real ranges and `4.3.0` no longer satisfies `^0.16.2`, so yarn emits peer-dependency warnings. Fix: align these `peerDependencies` and `engines.quereus` entries to `^4.3.0`.

## Approach

**Default = published (required for clean install):**

1. Root `package.json`: delete the two `portal:` lines from `resolutions`; keep `protons-runtime` and `uint8arrays`.
2. `packages/substrate-simulator/package.json`: change `p2p-fret` from `portal:../../../Fret/packages/fret` to `^0.6.0` (match `db-p2p`).
3. `quereus-plugin-crypto` + `quereus-plugin-optimystic`: bump `peerDependencies["@quereus/quereus"]` and `engines.quereus` from `^0.16.2` to `^4.3.0`.
4. Regenerate `yarn.lock` via `yarn install` so portal locators are replaced by npm resolutions.

**Opt-in portal overlay for sibling co-development:**

Yarn 4 has no native "merge resolutions from a separate git-ignored file" mechanism, so do not invent a bespoke merge. **Recommended: use yarn's built-in `yarn link`**, which adds a `portal:` resolution to the root `package.json` on demand and removes it with `yarn unlink` — this *is* the opt-in overlay, no custom tooling. Wrap both siblings in convenience scripts:

- `dev:link` → `yarn link ../quereus/packages/quereus && yarn link ../Fret/packages/fret`
- `dev:unlink` → `yarn unlink ../quereus/packages/quereus && yarn unlink ../Fret/packages/fret`

Tradeoff: `yarn link` writes into the tracked `package.json`, so a co-developing dev must not commit those lines. Document this clearly in the README. (A pre-commit guard that rejects a `portal:` resolution is a reasonable future hardening but is a tripwire, not required here — leave a `NOTE:` if you add the scripts.)

Verify the exact `yarn link` argument form against the installed yarn (`4.12.0`) before finalizing the scripts; if `yarn link` proves awkward for a package nested inside a sibling monorepo, fall back to a documented manual step that adds/removes the portal resolutions by hand. Pick whichever actually works and document the chosen path.

**README:**

Add a short section documenting: (a) default `yarn install` needs no sibling repos; (b) the sibling-checkout layout expected for co-development — `../quereus/packages/quereus` and `../Fret/packages/fret` relative to this repo root; (c) the `dev:link` / `dev:unlink` opt-in steps and the "don't commit the portal lines" caveat.

## Validation

- Simulate a clean checkout without siblings: temporarily move/hide `../quereus` and `../Fret` (or use a throwaway clone elsewhere) and confirm `yarn install` succeeds pulling from npm. Restore siblings after. (Do not delete the siblings.)
- `yarn install` produces a `yarn.lock` with npm resolutions for `@quereus/quereus@npm:4.3.0` and `p2p-fret@npm:0.6.0` and no remaining `portal:` locators for these two.
- No peer-dependency warnings for `@quereus/quereus` after the peer/engines bump.
- Build still works: `yarn build` (stream output with `2>&1 | tee /tmp/build.log`).

## TODO

- [ ] Remove the two `portal:` entries from root `package.json` `resolutions`.
- [ ] Change `substrate-simulator` `p2p-fret` dep to `^0.6.0`.
- [ ] Bump `peerDependencies["@quereus/quereus"]` and `engines.quereus` to `^4.3.0` in `quereus-plugin-crypto` and `quereus-plugin-optimystic`.
- [ ] Add `dev:link` / `dev:unlink` scripts (or documented manual step) for the opt-in portal overlay; verify against yarn 4.12.0.
- [ ] Regenerate `yarn.lock` with `yarn install`; confirm portal locators gone.
- [ ] Document the default install + sibling-checkout layout + opt-in overlay in README.
- [ ] Validate a sibling-less install succeeds (hide, don't delete, the siblings) and `yarn build` passes.
