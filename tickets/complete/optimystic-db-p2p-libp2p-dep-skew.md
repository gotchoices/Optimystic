description: Eliminated the duplicate-dependency "streamMessage not found" bundler warnings in the db-p2p package by upgrading its protocol-buffer runtime library and aligning a few related library versions across the project.
prereq:
files: packages/db-p2p/package.json, package.json, yarn.lock, packages/db-core/package.json, packages/db-p2p-storage-ns/package.json, packages/db-p2p-storage-rn/package.json, packages/db-p2p-storage-web/package.json, packages/quereus-plugin-optimystic/package.json, packages/reference-peer/package.json
----

## Summary

The root cause was a `protons-runtime` v5/v6 skew in `packages/db-p2p`: gossipsub pulled in `protons-runtime@5.6.0` while `@libp2p/autonat`/`@libp2p/dcutr` (and their nested `@libp2p/crypto@5.1.19`) required v6, leaving nested v6 copies whose v6-only `streamMessage` export produced "export not found" bundler warnings downstream.

The fix:
- Added `protons-runtime: ^6.0.0` as a direct dependency of `packages/db-p2p` (makes v6 the top-level copy in db-p2p's `node_modules`).
- Added `protons-runtime: ^6.0.0` to the **root** `resolutions` so gossipsub's `^5.5.0` requirement also resolves to v6 within the workspace (gossipsub only uses `decodeMessage`/`encodeMessage`/`MaxLengthError`/`message`, all present in v6, and never calls `streamMessage`).
- Bumped `@libp2p/crypto` `^5.1.13 → ^5.1.19` in `packages/db-p2p` to eliminate the nested crypto copies under autonat/dcutr.
- Bumped `@libp2p/interface` `^3.1.0 → ^3.2.4` in `db-core`, the three storage packages (`ns`/`rn`/`web`), and `quereus-plugin-optimystic`; and `^2.10.5 → ^3.2.4` in `reference-peer`. `packages/db-p2p` itself stays at `^3.1.0` (a `^3.2.4` bump there reintroduces a peer-id-vs-db-p2p split that breaks TypeScript structural typing in tests).

## Review findings

### Verified working (checked)
- **Core deliverable.** Installed tree confirmed: top-level `protons-runtime@6.0.2`; no nested `protons-runtime` or `@libp2p/crypto` under `@libp2p/autonat` or `@libp2p/dcutr`. The skew that produced the warnings is gone.
- **gossipsub runtime safety.** gossipsub resolves to the hoisted `protons-runtime@6.0.2`; its `dist/` never references `streamMessage`; v6 exports every symbol it does use (`decodeMessage`, `encodeMessage`, `MaxLengthError`, `message`). Confirmed by grep over the installed `dist`.
- **Builds.** `db-p2p`, `db-core`, and `reference-peer` all build clean (`tsc` exit 0).
- **Tests.** `yarn test:db-p2p` → **848 passing, 29 pending**, exit 0.
- **reference-peer v2→v3 interface jump** (unmentioned in the handoff): builds clean after a proper `yarn workspaces focus @optimystic/reference-peer`; `reference-peer/src` imports `@libp2p/interface` nowhere directly, so the major bump only aligns a transitive/type dep with the rest of the monorepo — low risk.

### Found and fixed inline (minor)
- **Lockfile/manifest inconsistency.** The committed `yarn.lock` recorded `@libp2p/interface: npm:^3.2.4` for the `db-p2p` workspace while `packages/db-p2p/package.json` declares `^3.1.0` (the implementer reverted the manifest line but not the lockfile). This would make `yarn install --immutable` (CI) fail. Fixed by regenerating the lockfile with `yarn install --mode=update-lockfile`, which changed exactly one line back to `^3.1.0`. db-p2p build + tests re-confirmed green afterward.

### Handoff inaccuracies (no code impact, recorded for the record)
- The handoff's "Changes made" section listed only `packages/db-p2p/package.json` and the root `package.json`, and stated `@libp2p/interface` was "intentionally kept at `^3.1.0`." In fact the same commit also bumped `@libp2p/interface → ^3.2.4` in **six** other packages (`db-core`, `db-p2p-storage-ns/rn/web`, `quereus-plugin-optimystic`, `reference-peer`). The "kept at `^3.1.0`" note is true only for `db-p2p` itself.
- Ticket spec said `^3.2.3`; the actual bump landed on `^3.2.4` (a newer compatible patch within v3). Acceptable.

### Not individually rebuilt (residual, low risk)
- The three storage packages and `quereus-plugin-optimystic` carry the `@libp2p/interface` bump in **devDependencies** only and were not each rebuilt; the change is a compatible minor within v3, and `db-core` (the foundational library with the heaviest interface usage) builds clean at `^3.2.4`, so the line is exercised. A full `yarn install` (which would let `yarn build`/`yarn test` run across every package) remains blocked by the pre-existing quereus `uint8arrays` conflict (below), so per-package validation used `yarn workspaces focus`.

### Out of scope / incidental (no action)
- `yarn.lock` also shows `inheritree ^0.3.4 → ^0.4.0` and `uint8arrays ^5.1.0 → ^6.1.1` inside the `@quereus/quereus` **portal** soft-dependency block. This is drift from the externally portal'd `../quereus/packages/quereus` repo picked up during install, not part of this ticket's intent; it is benign and is the source of the pre-existing `YN0071` quereus link conflict that makes a plain `yarn install` exit 1.

### No new tickets filed
All findings were either verified-good or fixed inline. The one defect (lockfile inconsistency) was a minor one-line fix applied in this pass. The reference-peer major bump and the storage/plugin minor bumps were validated (or are compatible minors backed by db-core's clean build), so no follow-up fix/plan ticket is warranted.
