description: A fresh clone now installs from published npm packages with no sibling repositories required; local-folder overrides are opt-in via yarn link.
prereq:
files: package.json, packages/substrate-simulator/package.json, packages/quereus-plugin-crypto/package.json, packages/quereus-plugin-optimystic/package.json, yarn.lock, README.md
difficulty: medium
----

## What this ticket did

Removed the two on-disk sibling-repo dependency overrides (`portal:` locators pointing
*outside* the repo) so `git clone` + `yarn install` works with no other repos checked
out, defaulting both to their published npm versions. Made the sibling-folder overlay
opt-in via yarn's built-in `yarn link` / `yarn unlink`.

## Changes made (verify each)

- **`package.json`** — deleted the two `portal:` entries from `resolutions`
  (`@quereus/quereus`, `p2p-fret`); kept `protons-runtime` + `uint8arrays`. Added two
  scripts: `dev:link` (`yarn link -r ../quereus/packages/quereus ../Fret/packages/fret`)
  and `dev:unlink` (`yarn unlink ../quereus/packages/quereus ../Fret/packages/fret`).
- **`packages/substrate-simulator/package.json`** — `p2p-fret` changed from
  `portal:../../../Fret/packages/fret` to `^0.6.0`. **Also added** `@libp2p/interface ^3.1.0`,
  `@libp2p/peer-id ^6.0.4`, `libp2p ^3.1.3` to `dependencies` — see "Extra side-effect" below.
- **`packages/quereus-plugin-crypto/package.json`** — `peerDependencies["@quereus/quereus"]`
  and `engines.quereus` bumped `^0.16.2` → `^4.3.0` (the devDependency was already `^4.3.0`).
- **`packages/quereus-plugin-optimystic/package.json`** — same peer/engines bump `^0.16.2` → `^4.3.0`.
- **`yarn.lock`** — regenerated: `@quereus/quereus@npm:^4.3.0` (→ 4.3.0) and `p2p-fret@npm:^0.6.0`
  (→ 0.6.0); **zero** `portal:` locators remain.
- **`README.md`** — new "Installation" section: default install needs no siblings; the
  sibling-checkout layout for co-development; the `dev:link` / `dev:unlink` opt-in and the
  "don't commit the portal lines" caveat. Includes a `NOTE:` HTML comment recording the
  pre-commit-guard tripwire.

## Extra side-effect handled (NOT anticipated in the implement ticket)

The implement ticket only foresaw the `@quereus/quereus` peer warnings. Switching
substrate-simulator's `p2p-fret` from `portal:` to `npm:` surfaced a **second**, harder
side-effect the ticket missed:

- Under `portal:`, `p2p-fret` was a **symlink** to the sibling Fret repo, so its runtime
  imports of `@libp2p/peer-id` / `@libp2p/interface` / `libp2p` resolved via the *sibling's
  own* `node_modules`.
- Under `npm:`, `p2p-fret` is a **real copy** in substrate-simulator's tree, and its peer
  deps must be satisfied locally. Importing *any* symbol from `p2p-fret` loads its index,
  which transitively imports `@libp2p/peer-id` — so the mock's tests died with
  `Cannot find package '@libp2p/peer-id'` even though the mock only uses non-libp2p exports
  (`DigitreeStore`, `hashKey`, `xorDistance`, `assembleCohort`, `estimateSizeAndConfidence`).

Fix: added the three libp2p peer deps to substrate-simulator's `dependencies` (versions
copied from `p2p-fret@0.6.0`'s `peerDependencies`). This both fixed the runtime failure and
cleared the yarn `YN0002` peer warnings. **Reviewer: sanity-check that these versions are
the right ones** (they match p2p-fret's declared peer ranges and quereus-plugin-optimystic's
existing `@libp2p/interface ^3.1.0` / `libp2p ^3.1.3`).

## Validation performed

- `yarn install` — succeeds; resolution swaps `+ @quereus/quereus@npm:4.3.0, p2p-fret@npm:0.6.0`,
  drops both portal locators.
- `yarn install --immutable` — **rc=0** (this is what CI / a fresh clone runs; proves the
  lockfile is complete and self-consistent).
- `grep portal: yarn.lock` → no matches. `grep` for `../quereus` / `../Fret` /
  `quereus/packages` / `Fret/packages` in yarn.lock → no matches. So the resolved graph
  references no sibling filesystem path at all.
- No `@quereus/quereus` peer warning after the bump; no substrate-simulator libp2p peer
  warnings after the dep add. Only remaining install warnings are pre-existing react-native
  `packageExtensions` notices (unrelated to this ticket).
- `yarn build` — full monorepo build, rc=0 (`tsc` + `tsup` DTS across all workspaces; this
  is the type-check floor).
- `yarn workspace @optimystic/substrate-simulator test` — **258 passing** (the direct
  `p2p-fret` consumer; validates npm resolution at runtime).
- `yarn workspace @optimystic/quereus-plugin-crypto test` — **125 passing** (validates the
  swapped npm `@quereus/quereus` resolves at runtime).
- `dev:link` / `dev:unlink` round-trip — verified live against yarn 4.12.0: `dev:link` writes
  relative `portal:../quereus/packages/quereus` + `portal:../Fret/packages/fret` resolutions
  and installs; `dev:unlink` removes them and restores `@npm:` locators; final `yarn.lock`
  portal count = 0. Working tree confirmed clean afterward.

## Use cases the reviewer should exercise

- **Fresh contributor / CI**: clone with no sibling repos → `yarn install --immutable` →
  `yarn build`. Should need nothing but this repo.
- **Sibling co-developer**: check out `../quereus/packages/quereus` and `../Fret/packages/fret`,
  run `yarn dev:link`, edit sibling source, see it reflected; `yarn dev:unlink` +
  `yarn install` to return to published versions before committing.
- **Peer-dep hygiene**: confirm `yarn install` emits no `@quereus/quereus` or p2p-fret
  libp2p peer warnings.

## Known gaps / honest flags (reviewer: treat as starting points)

- **Empirical sibling-less clean install NOT run.** The plan suggested hiding the sibling
  dirs and reinstalling; `mv ../quereus` failed with **`Permission denied`** (the sibling
  repo is locked by another process on this Windows box — likely the concurrent tess runner
  or an editor). I did **not** force it, so the siblings were never disturbed. Sibling-
  independence is instead proven *by construction* (zero portal/sibling-path references in
  `yarn.lock`) plus `--immutable` rc=0. If the reviewer wants empirical confirmation, do it
  in a **throwaway clone elsewhere** — do not move the in-place sibling repos.
- **Full monorepo test suite NOT run.** I ran targeted tests for the two directly-affected
  packages (substrate-simulator, quereus-plugin-crypto) plus the full build. The db-p2p
  integration suite (real libp2p / network) was not run — it is heavy/flaky and not
  agent-runnable, and this change is a version-*identical* dep-resolution swap (the sibling
  checkouts were at exactly the published versions), so no consumer code changed. Worth a CI
  run of `yarn test` to be thorough.
- **quereus-plugin-optimystic tests not run individually** — same reasoning as crypto
  (metadata-only peer/engines change; devDependency `@quereus/quereus ^4.3.0` unchanged;
  build passed). Reviewer may run `yarn workspace @optimystic/quereus-plugin-optimystic test`.

## Tripwire (parked, not a ticket)

`dev:link` writes `portal:` `resolutions` into the **tracked** `package.json`; a co-developer
must not commit those lines. A pre-commit hook that rejects a `portal:` resolution is
reasonable future hardening. Parked as a `NOTE:` HTML comment beside the `dev:link` docs in
`README.md` — not filed as a ticket because it is conditional (only bites if someone commits
while linked).

## Note investigated and dismissed

`.yarnrc.yml` contains a plaintext `npmAuthToken`, but the file is **git-ignored and untracked**
(`git check-ignore .yarnrc.yml` matches; `git ls-files` does not) — so no secret is committed.
Not a finding.
