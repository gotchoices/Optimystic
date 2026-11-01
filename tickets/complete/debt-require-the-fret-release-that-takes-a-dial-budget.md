description: A node now hands FRET the dial deadline a host sets for slow relayed links, but the FRET release that reads it is not on npm yet, so our published packages still allow the older FRET that ignores it. When that FRET release ships, raise our minimum FRET version so every install gets it.
architecture: docs/releasing.md
files: packages/db-p2p/package.json, packages/substrate-simulator/package.json, package.json (the `portal:../Fret/packages/fret` resolution), packages/db-p2p/src/libp2p-node-base.ts (the `fretService({ … dialTimeoutMs })` construction)
tradeoffs: Nothing to do until FRET publishes; a caret range already lets a fresh install pick up the new FRET, so the only install left behind is one whose lockfile pins FRET 1.0.2.
----
# Require the FRET release that takes a dial budget

Background: after a restart two relay-only machines (phones) never reconnected, because FRET's maintenance dial was cut off at 2 s while a relayed dial on a slow link takes about 9 s (found by Sereus, gotchoices/sereus#44). FRET main fixed its half by bounding each maintenance redial with `FretConfig.dialTimeoutMs`. Our half landed in `ticket(implement): fret-dial-timeout-from-the-node-dial-timeout`: `createLibp2pNodeBase` passes FRET the node's resolved whole-dial deadline (`resolveLibp2pDialTimeoutMs` in `packages/db-p2p/src/rpc-deadline.ts`), so a host that raises `connectionManager.dialTimeout` or declares `linkRoundTripMs` raises FRET's too.

What is left: `p2p-fret` is declared `^1.0.2` in `packages/db-p2p/package.json` and `packages/substrate-simulator/package.json`. This repository resolves it through the `portal:` link to the FRET checkout, so builds and tests here run against FRET main, which has the field. FRET 1.0.2, the newest on npm, does not read `dialTimeoutMs` and ignores it; a host whose lockfile holds 1.0.2 keeps the 10 s redial whatever it configured, with no error.

Expected:

- Once FRET publishes the release containing `dialTimeoutMs` (FRET ticket `maintenance-redial-off-the-tick`), both declared ranges name that version as their floor, and `yarn lint:deps` passes.
- This must happen before (or with) the first optimystic release published after FRET's, not after it.

## Done

FRET 1.1.0 published (tag v1.1.0 = FRET 12b509a plus version bump). `p2p-fret` raised to `^1.1.0` in `packages/db-p2p/package.json` and `packages/substrate-simulator/package.json`; `yarn install` and `yarn lint:deps` clean. Release note added under "Unreleased — since v1.14.0" in `.release-notes.pending.md` (the previous "Unreleased — since v1.13.0" section relabelled `v1.14.0`, which is on npm).
