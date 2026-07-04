----
description: One package requires an older major version of a shared identity library than the rest of the project, which can make runtime identity checks fail; align it and add an automated check so shared dependency versions can't drift apart again.
prereq:
files: packages/reference-peer/package.json, packages/db-core/package.json, packages/db-p2p/package.json, packages/quereus-plugin-crypto/package.json, packages/quereus-plugin-optimystic/package.json, package.json, .yarnrc.yml, yarn.lock
difficulty: medium
----

Origin: review finding eh-3, dependency-drift portion (`docs/review.html`, Section 9 "Cross-cutting engineering health"). This is the implement handoff from `tickets/fix/peer-id-dep-skew-and-constraints.md`.

## Problem (confirmed)

`@libp2p/peer-id` resolves to **three** majors at once in `yarn.lock`:

- `^4.2.4` — transitive (via `@libp2p/peer-id-factory`)
- `^5.0.0, ^5.1.8, ^5.1.9` — `^5.1.8` is `reference-peer`'s direct pin; the others are transitive from the libp2p stack
- `^6.0.0, ^6.0.1, ^6.0.4, ^6.0.10` — every other workspace package (`db-core`, `db-p2p`, `db-p2p-storage-*`)

When two majors of `@libp2p/peer-id` load at runtime, a peer-id object minted by one copy fails `instanceof` against the class from the other copy → intermittent, hard-to-diagnose identity/routing failures.

### Two facts that shape the fix

1. **`reference-peer` does not import `@libp2p/peer-id` in its source.** Grep of `packages/reference-peer/src` finds only string peerIds (`mesh.ts:59-96`), no `peer-id` import, no `PeerId` type use. Its `^5.1.8` direct dependency is therefore removable *or* bumpable without touching code. Primary approach: **bump to `^6.0.4`** to match the workspace (ticket-specified end state). If the bump surfaces any friction, removing the unused direct dep is a valid fallback — note which you did in the review handoff.

2. **The `^5.0.0`/`^5.1.9` transitive v5 copy may persist** even after `reference-peer` is aligned, because it comes from the libp2p stack, not from the direct pin. That transitive v5 (and the v4 from `peer-id-factory`) is **out of scope** for this ticket — record it as a tripwire (see below), do not chase it here. The ticket target is eliminating the *workspace-declared* major divergence.

### Related, already-done

`optimystic-db-p2p-libp2p-dep-skew` (complete) resolved a `protons-runtime` v5/v6 skew and deliberately left an `@libp2p/interface` split in place. That ticket noted an `@libp2p/interface` major bump in `db-p2p` reintroduced a peer-id-vs-db-p2p **structural-typing split in tests**. Guard against re-triggering it: `@libp2p/interface` is currently all `^3.x` across the workspace (`^3.1.0` in db-p2p / quereus-plugin-optimystic / storage-*; `^3.2.4` in db-core / reference-peer). The constraints guard below must normalize **within the existing `^3` major** — it must NOT bump `@libp2p/interface` across a major boundary, or the structural-typing split can return.

## Current declared-version map (for reference)

`@libp2p/peer-id`:
- reference-peer `^5.1.8`  ← the outlier to fix
- db-core, db-p2p, db-p2p-storage-rn/web/ns `^6.0.4`

`@libp2p/interface` (all `^3`, minor drift only):
- db-core, reference-peer `^3.2.4`
- db-p2p, quereus-plugin-optimystic, db-p2p-storage-rn/web/ns `^3.1.0`

`uint8arrays` (declared `^5.1.0` but root `resolutions` force `^6.1.1`):
- reference-peer, db-core, db-p2p, quereus-plugin-crypto, quereus-plugin-optimystic `^5.1.0`

`@libp2p/crypto` (all `^5`, minor drift only): mostly `^5.1.13`, db-p2p `^5.1.19`.

## Approach

**Alignment edits** — bring divergent declarations onto the workspace-shared range:
- `reference-peer` `@libp2p/peer-id`: `^5.1.8` → `^6.0.4`.
- `uint8arrays` declarations `^5.1.0` → `^6.1.1` (match the root `resolutions` reality) in reference-peer, db-core, db-p2p, quereus-plugin-crypto, quereus-plugin-optimystic. The behavior is already `^6.1.1` via resolutions; this only makes the declaration honest so the constraints guard passes.

**Constraints guard** — Yarn 4 (this repo is `yarn@4.12.0`) uses `yarn.config.cjs` with `defineConfig({ constraints })`. Create it at repo root. Encode a single shared range per cross-package libp2p/uint8arrays dep so any future divergent pin fails `yarn constraints` (and `yarn constraints` is CI-runnable). Enforce, at minimum:
- `@libp2p/peer-id` → `^6.0.4`
- `uint8arrays` → `^6.1.1`
- `@libp2p/peer-id` and `uint8arrays` kept single-range across all workspaces

For `@libp2p/interface` and `@libp2p/crypto`, prefer enforcing a **shared major** (or a single agreed caret range) rather than an exact version, and explicitly do NOT push `@libp2p/interface` past `^3` — see the structural-typing caution above. If encoding "same major, allow minor drift" is awkward in constraints, normalizing each to a single caret range that stays inside the current major (e.g. `@libp2p/interface` → `^3.2.4`, `@libp2p/crypto` → `^5.1.19`) is acceptable — just confirm it does not cross a major boundary.

Sketch (Yarn 4 constraints API):

```js
// yarn.config.cjs
/** @type {import('@yarnpkg/types')} */
const { defineConfig } = require('@yarnpkg/types')

const SHARED_RANGES = {
  '@libp2p/peer-id': '^6.0.4',
  'uint8arrays': '^6.1.1',
  '@libp2p/interface': '^3.2.4', // MUST stay ^3 — bumping past major reintroduces peer-id/db-p2p test split
  '@libp2p/crypto': '^5.1.19',
}

module.exports = defineConfig({
  async constraints({ Yarn }) {
    for (const [ident, range] of Object.entries(SHARED_RANGES)) {
      for (const dep of Yarn.dependencies({ ident })) {
        // workspace: deps excluded automatically (different ident); guard prod+dev+peer
        dep.update(range)
      }
    }
  },
})
```

Verify the exact `@yarnpkg/types` import/return shape against the installed Yarn 4 API before finalizing; `dep.update()` is the documented autofix path so `yarn constraints --fix` can repair drift.

## Validation

Stream all long output with `2>&1 | tee` (never silent redirect — idle-timeout kills the run).

- `yarn install` after edits (reconciles lockfile; expect v5 direct pin to drop, transitive v5/v4 may remain — that's the tripwire, not a failure).
- `yarn constraints` — must pass clean. Deliberately introduce a bad pin locally to confirm it *fails*, then revert that probe.
- Build + test `reference-peer` specifically (it's the changed-behavior package): `yarn workspace @optimystic/reference-peer build` then `... run test`.
- Full `yarn build` + `yarn test` to confirm the peer-id alignment did not resurface the `@libp2p/interface` structural-typing split flagged by the completed dep-skew ticket. If that split *does* reappear, that is a signal the constraints guard bumped `interface` across a major — back it off to `^3`.

## Tripwire to record (do NOT file as a ticket)

Transitive `@libp2p/peer-id` v5 (`^5.0.0`/`^5.1.9`) and v4 (`^4.2.4`, via `@libp2p/peer-id-factory`) will likely still resolve after this ticket, because they come from the libp2p stack, not workspace declarations. This is fine now (single major within workspace-authored code); it only becomes work if a runtime `instanceof`/identity failure is traced to a transitive-vs-workspace peer-id copy. Park as a `NOTE:` comment in `yarn.config.cjs` near the `@libp2p/peer-id` entry, and add one line to the review's `## Review findings`.

## TODO

- [ ] Bump `@libp2p/peer-id` in `packages/reference-peer/package.json` `^5.1.8` → `^6.0.4` (or remove the unused direct dep — note which).
- [ ] Align `uint8arrays` declarations `^5.1.0` → `^6.1.1` in reference-peer, db-core, db-p2p, quereus-plugin-crypto, quereus-plugin-optimystic.
- [ ] Create `yarn.config.cjs` at repo root encoding shared ranges for `@libp2p/peer-id`, `uint8arrays`, `@libp2p/interface` (stay `^3`), `@libp2p/crypto`; add `@yarnpkg/types` as a root devDependency if the API import needs it.
- [ ] Add `NOTE:` tripwire comment in `yarn.config.cjs` about persisting transitive v4/v5 peer-id copies.
- [ ] `yarn install`; confirm lockfile drops the reference-peer direct v5 pin.
- [ ] `yarn constraints` passes; verify a deliberately-bad pin makes it fail, then revert the probe.
- [ ] `reference-peer` build + test pass.
- [ ] Full `yarn build` + `yarn test` pass; confirm no `@libp2p/interface` structural-typing regression.
- [ ] Write the `review/` handoff: state which peer-id approach was used (bump vs remove), what constraints enforces, the tripwire, and any residual drift left intentionally.
