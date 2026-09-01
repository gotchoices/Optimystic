description: The dead message-broadcast service that silently dropped every message was removed from every Optimystic node, along with the unused library behind it; reviewed, tests and lint pass.
files:
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/test/node-service-set.spec.ts
  - packages/db-p2p/test/foreign-peer-interop.integration.spec.ts
  - packages/db-p2p/docs/repo.md
  - packages/db-p2p/package.json
  - packages/quereus-plugin-optimystic/package.json
  - yarn.lock
----

# Gossipsub `pubsub` service removed from the default node service set

## What shipped

`createLibp2pNodeBase` no longer registers a `pubsub` service. `@chainsafe/libp2p-gossipsub`
(newest published release 14.1.2) is built against `@libp2p/interface@^2`, whose `Stream` carried
`.sink`/`.source`. This repo runs libp2p 3, where `Stream extends MessageStream` and has neither, so
`it-pipe`'s `isDuplex` check fails and gossipsub's `OutboundStream` constructor throws
`fns.shift(...) is not a function` synchronously on every outbound stream. Gossipsub logs and
swallows that, so the service reported healthy while `publish()` always resolved with zero
recipients. No production code used `services.pubsub` — every real broadcast path in this repo is a
hand-registered protocol via `node.handle` — so the service was removed rather than repaired.

A `NOTE:` at the former registration site records the full reason and the re-add condition (a
gossipsub release built for libp2p 3). The `@chainsafe/libp2p-gossipsub` dependency was dropped from
`packages/db-p2p` (where it was used) and `packages/quereus-plugin-optimystic` (where it was already
unused); 20 packages left the lockfile, all of them gossipsub's own subtree. Stale doc/comment claims
that a node advertises `/meshsub/…` and `/floodsub/…` were corrected in `packages/db-p2p/docs/repo.md`
and `foreign-peer-interop.integration.spec.ts`.

`node-service-set.spec.ts` — the lock spec pinning the complete service-key set with a written-out
literal — lost its `'pubsub'` entry. That spec is the mechanism that catches an accidental re-add or
an accidental drop of some *other* key.

## Review findings

**Checked:** the implement diff read before the handoff summary; every remaining reference to
gossipsub/meshsub/floodsub/pubsub across the tree (source, tests, docs, all `package.json`s,
`yarn.lock`, workspace `node_modules`); whether the change touched a published *type* as well as a
runtime shape; whether any doc other than `repo.md` enumerates the service set or the stock protocol
ids; whether `test/util/protocol-ids.ts` carried a now-dead pubsub allowlist; whether the board
already claimed these sites; the accuracy of every claim in the implementer's validation section.

**Fixed inline (minor):**

- `node-service-set.spec.ts` — the new pubsub explanation had been inserted *between* two bullets of
  the service-key list, orphaning the `networkManager` / `fret` bullet below a full paragraph. Moved
  it below the complete list.
- `libp2p-node-base.ts` — the 10-line `NOTE:` ran straight into the `// Circuit relay server`
  comment with no blank line, so the two read as one block. Separated.

**Filed (major → human inbox):** one ticket, `tickets/blocked/communicate-pubsub-removal-outward.md`,
with two arms that share one root — communicating this removal outside the repository, which no agent
should do unilaterally. Arm 1: reply to the reporter on `gotchoices/Optimystic` issue #9 (the
fix-stage ticket asked for this; it was never done). Arm 2: get the removal into the next release
notes. `@optimystic/db-p2p` is published (0.24.2) and notes are generated from commit subjects
(`docs/releasing.md` step 4), which the runner writes with no breaking-change marker — so the
implementer's request for a `BREAKING CHANGE:` trailer could not be honored from inside the pipeline
and needed a durable home. Confirmed while filing that the change is runtime-shape-only: the service
map is never exposed through a published type naming `pubsub` (`libp2p-node-base.ts:723` casts the
whole map), so no consumer gets a compile error — which is precisely why the release note matters.

**Tripwires:** none recorded. The one conditional concern here — "re-add gossipsub once ChainSafe
ships a libp2p-3 build" — is already a `NOTE:` at the exact call site, put there by the implementer;
adding a second one would duplicate it.

**Declined / out of scope, deliberately:** the `services:` cast and its `NOTE:` at
`libp2p-node-base.ts:723` stay untouched — that cast is a separate `@libp2p/interface` 3.1.0-vs-3.2.3
minor-version split, tracked by `debt-libp2p-interface-version-drift-guard`, which named this ticket
as its prereq and already describes the post-removal lockfile state correctly (no edit needed). No
opt-in flag or config surface for `pubsub` was added; the fix stage weighed and rejected that, and
there is no working version to opt into.

**Not re-verified:** the fix stage's standalone two-node repro (its scripts were deleted before
implementation began). The static equivalent was re-run instead and is clean —
`grep -rn "pubsub" packages/*/src` finds only the explanatory `NOTE:`, confirming production code
never depended on the key. The service-set lock spec passing without `pubsub` is the positive
assertion that the key is gone.

**Nothing else found.** No dead allowlists, no stale docs, no orphaned dependency, no type break, no
other doc enumerating the removed protocol ids.

## Validation

Foreground, unredirected, after the inline fixes:

- `yarn lint` (root) — clean.
- `yarn workspace @optimystic/db-p2p typecheck` / `build` — clean.
- `yarn workspace @optimystic/quereus-plugin-optimystic typecheck` — clean.
- `yarn workspace @optimystic/db-p2p test` — **2391 passing, 49 pending** (pending are pre-existing).
- `yarn workspace @optimystic/db-p2p test:integration` — **30 passing, 2 pending** (pre-existing
  `unimplemented`/mock-tier notes).
- Dependency removal confirmed at three levels: no `gossipsub` in any `package.json`, none in
  `yarn.lock`, and none under either workspace's `node_modules/@chainsafe/`.

No test failures, pre-existing or otherwise.
