description: The FRET library (the ring-routing package this project depends on) still declares the older versions of two small byte-handling packages, so its working copy can no longer be linked into this repository for side-by-side development, and one type assertion here papers over the difference. FRET needs a release on the newer versions before either can be undone.
architecture: README.md#local-co-development-against-sibling-repos-opt-in
files:
  - package.json (`resolutions`: the `p2p-fret` portal entry was removed; `dev:link` script)
  - README.md (the "cannot be linked this way at present" paragraph)
  - packages/db-p2p/src/cohort-topic/stream-util.ts (`readFrame`, the one assertion)
  - packages/db-p2p/package.json (`p2p-fret` range)
  - scripts/shared-majors.cjs ("WHAT IS DELIBERATELY NOT HERE")
  - outside this repository: Fret/packages/fret/package.json and Fret/yarn.lock
----
# The FRET checkout cannot be linked while it is on the libp2p 3.1 line

**Blocked on a dependency outside this repository: a `p2p-fret` release that declares `uint8arraylist` ^3 and `it-length-prefixed` ^11 and is built against `@libp2p/interface` ^3.3.** Once that release exists, the three follow-ups under "What unblocks" are ordinary work in this repository.

## What happened

Ticket `a-relayed-dial-is-cut-off-by-libp2ps-per-address-timeout` moved this repository from libp2p 3.1.3 to 3.3.11. libp2p 3.3 types its streams with `uint8arraylist` 3, so `@optimystic/db-p2p` had to move its own `uint8arraylist` (2 → 3) and `it-length-prefixed` (10 → 11) to compile against a stream at all.

`p2p-fret` 1.0.0 declares `uint8arraylist` ^2.4.8 and `it-length-prefixed` ^10.0.1 as dependencies. Two things follow.

**1. The working copy can no longer be portal-linked.** The root `package.json` used to redirect `p2p-fret` to `../Fret/packages/fret` with a `portal:` resolution. Yarn installs a portal's dependencies into the package it is linked into, and refuses when they conflict with that package's own:

```
YN0071: Cannot link p2p-fret into @optimystic/db-p2p … dependency it-length-prefixed@npm:10.0.1 conflicts with parent dependency it-length-prefixed@npm:11.0.1
YN0071: Cannot link p2p-fret into @optimystic/db-p2p … dependency uint8arraylist@npm:2.4.8 conflicts with parent dependency uint8arraylist@npm:3.0.2
```

The install then ends "Failed with errors". So the `p2p-fret` portal entry was removed and the package now comes from npm (1.0.0, published from the same commit the checkout is on, so nothing was lost today). `yarn dev:link` fails the same way for FRET; the README says so and tells a developer to link Quereus alone.

A second problem sits behind the first and would remain even if Yarn linked it. With the portal in place and db-p2p on libp2p 3.3, db-p2p's build had 25 type errors of the shape "`PeerId` is not assignable to `PeerId`", one side from `packages/db-p2p/node_modules/@libp2p/interface` (3.3.0) and the other from `Fret/packages/fret/node_modules/@libp2p/interface` (3.1.0). TypeScript treats two installed copies of a package as one only when name and version both match, so linking worked before only because both repositories' lockfiles held 3.1.0. The FRET checkout's own lockfile has to hold the same `@libp2p/interface` version this repository does.

**2. One type assertion in db-p2p.** db-p2p reads cohort-topic and reactivity frames through FRET's exported `readFramed`. FRET 1.0.0 declares that function's source as an iterable of `uint8arraylist` 2 lists; a libp2p 3.3 stream yields `uint8arraylist` 3 lists. The two do not unify as types. At run time they do: both majors mark a list with the same global symbol (`Symbol.for('@achingbrain/uint8arraylist')`) and accept each other's lists, and for a real stream FRET reads through `@libp2p/utils`' `byteStream` without touching its own list class. All of db-p2p's reads now go through one function, `readFrame` in `packages/db-p2p/src/cohort-topic/stream-util.ts`, which holds the single assertion and a `NOTE:` naming this ticket.

## Proposed (recommended default)

In the FRET repository: move `uint8arraylist` to ^3.0.2, `it-length-prefixed` to ^11.0.1 and `multiformats` to ^14; raise the `@libp2p/interface` and `libp2p` peer and dev ranges to ^3.3.0 and ^3.3.11 (its two exact pins, `@libp2p/identify` 4.0.10 and `@libp2p/circuit-relay-v2` 4.1.3, need looking at there); regenerate its lockfile; run its suite; release. This raises FRET's peer floor, so it is at least a minor release.

## What unblocks, in this repository

- Raise `p2p-fret` in `packages/db-p2p/package.json` and `packages/substrate-simulator/package.json` to the new release.
- Remove the assertion in `readFrame` (keep the function: one seam for every framed read is worth having).
- Remove the README paragraph, confirm `yarn dev:link` installs and `yarn build` passes with FRET linked, then `yarn dev:unlink` before committing.
- Re-check `scripts/shared-majors.cjs`: with FRET moved, `multiformats` 13 has no remaining source in the tree and can join the guarded list if `yarn lint:deps` passes with it in. `uint8arraylist` 2 will still come from `@chainsafe/libp2p-noise` and `@chainsafe/libp2p-yamux` (backlog ticket `debt-noise-and-yamux-are-on-their-last-chainsafe-releases`).

## Alternatives rejected

- **Keep the portal with scoped Yarn resolutions (`p2p-fret/uint8arraylist`) and a TypeScript `paths` entry for `@libp2p/interface`.** Both make a tool report something other than what FRET runs with: Yarn would record FRET on `uint8arraylist` 3 while its checkout runs 2, and TypeScript would type FRET against an interface version its own install does not hold.
- **Keep db-p2p on `it-length-prefixed` 10.** It cannot decode a libp2p 3.3 stream without a cast at every protocol service, client and test that reads one.
- **Re-implement the framed read in db-p2p.** FRET's `readFramed` carries the overall deadline, the truncation and over-size errors and the stream-versus-iterable split; a second copy would drift.

## If nothing is done

Users and CI are unaffected: they install `p2p-fret` from npm, as this repository now does, and every suite passes that way. What is lost is developing FRET and Optimystic side by side through the portal, and the assertion stays. Everything here is reversible.

## Resolution (2026-10-05)

Resolved by `p2p-fret` 1.0.1 (uint8arraylist ^3.0.2, it-length-prefixed ^11.0.1, multiformats ^14, built for libp2p 3.3). Here: `p2p-fret` raised to ^1.0.1 in db-p2p and substrate-simulator; the `p2p-fret` portal entry restored in root `resolutions` beside Quereus's (installs cleanly, `yarn build` passes linked); the assertion in `readFrame` removed; the README "cannot be linked" paragraph removed; `multiformats` 14 added to `scripts/shared-majors.cjs` (`yarn lint:deps` passes) and the "not here" note narrowed to `uint8arraylist`.
