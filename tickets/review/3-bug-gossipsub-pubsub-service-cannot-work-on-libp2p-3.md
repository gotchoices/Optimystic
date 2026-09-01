description: Removed the dead gossipsub broadcast service from every Optimystic node's default service set, because it silently drops every message on this repo's networking library version and nothing in the codebase uses it.
files:
  - packages/db-p2p/src/libp2p-node-base.ts (removed `gossipsub` import and `pubsub: gossipsub({...})` service registration, left a `NOTE:` at the site)
  - packages/db-p2p/test/node-service-set.spec.ts (`EXPECTED_SERVICE_KEYS` literal no longer has `pubsub`, header comment updated)
  - packages/db-p2p/test/foreign-peer-interop.integration.spec.ts (dropped stale `/meshsub/…` mention from a comment)
  - packages/db-p2p/docs/repo.md (dropped stale `/meshsub/…`/`/floodsub/…` mentions, added a line noting `pubsub` is not registered and why)
  - packages/db-p2p/package.json (dropped `@chainsafe/libp2p-gossipsub` dependency and the `"gossipsub"` keyword)
  - packages/quereus-plugin-optimystic/package.json (dropped the same unused dependency)
  - yarn.lock (refreshed via `yarn install`)
difficulty: easy
----

# Gossipsub `pubsub` service removed from default node service set

Implements the decision from `tickets/fix/bug-gossipsub-pubsub-service-cannot-work-on-libp2p-3.md`
(now deleted; see that ticket's body, preserved in git history at commit `77a821fe`, for the full
root-cause writeup). Summary of the defect: `@chainsafe/libp2p-gossipsub` (newest published
version, 14.1.2) is built against `@libp2p/interface@^2`, whose `Stream` type had `.sink`/`.source`.
This repo's libp2p is v3, where `Stream extends MessageStream` (event target + `AsyncIterable`) and
has neither. `it-pipe`'s `isDuplex` check on the outbound stream then fails, so
`OutboundStream`'s constructor throws `fns.shift(...) is not a function` synchronously — before
gossipsub's own `.catch` can attach — every time it tries to open an outbound stream. Gossipsub
logs and swallows the error, so the service looked alive (registered, no startup exception) while
`publish()` always resolved with zero recipients: it could never actually deliver a message to any
peer. No production code in this repo used `services.pubsub` — every real broadcast path (cohort
gossip, push-state gossip, etc.) is a hand-registered protocol via `node.handle`, not pubsub — so
this dead service had nothing depending on it.

## What changed

- `libp2p-node-base.ts`: removed the `gossipsub` import and the `pubsub: gossipsub({...})` entry
  from the `services` map every node type builds (default TCP, browser/WS-only, the `/rn`
  React-Native entrypoint, and the relay variant — they all share this one factory). Left a `NOTE:`
  comment at the former call site explaining why, so nobody re-adds it against the same broken
  combination; re-adding is fine once ChainSafe ships a gossipsub release built for libp2p 3.
- Left the unrelated `services:` field type cast at `libp2p-node-base.ts:544` and its own `NOTE:`
  untouched — that cast is caused by a different, still-live problem (a 3.1.0-vs-3.2.3
  `@libp2p/interface` minor-version split unrelated to gossipsub), tracked separately as
  `debt-libp2p-interface-version-drift-guard`. Confirmed via `yarn why @libp2p/interface` after
  this change that no `@libp2p/interface` 2.x copy remains (gossipsub's whole v2-pinned subtree —
  `@libp2p/pubsub`, `@libp2p/interface-internal@2.x`, `@libp2p/peer-collections@6.x`,
  `@libp2p/utils@6.x`, `@libp2p/logger@5.x`, plus their own `@libp2p/interface@2.11.0` — is gone);
  the 3.1.0-vs-3.2.3 split is still present, as expected.
- `node-service-set.spec.ts`: this is the lock spec that pins the *complete* key set of every
  service `createLibp2pNodeBase` registers, checked with a written-out literal (deliberately not
  derived from the code under test — see the spec's own header). Dropped `'pubsub'` from
  `EXPECTED_SERVICE_KEYS` and its accompanying bullet in the header comment; added a paragraph there
  explaining the removal and pointing at issue #9. This spec is the one that "moves" as a result of
  this ticket — it is exactly the mechanism that would catch an accidental re-add or an accidental
  drop of a *different* service key.
- Two doc/comment-only fixes for stale claims: `foreign-peer-interop.integration.spec.ts:71` and
  `docs/repo.md` both used to say an Optimystic node advertises `/meshsub/…`/`/floodsub/…` protocol
  ids (gossipsub's wire protocols) — no longer true, removed the mentions. `docs/repo.md` gained a
  short line noting `pubsub` is deliberately unregistered and why.
- Dependency cleanup: `@chainsafe/libp2p-gossipsub` dropped from both `packages/db-p2p/package.json`
  (where it was used) and `packages/quereus-plugin-optimystic/package.json` (where it was already
  unused — confirmed with a grep for any import of it in that package's `src/`, found none). Dropped
  the now-false `"gossipsub"` keyword from `db-p2p`'s package.json. Ran `yarn install` to refresh
  `yarn.lock`; 20 packages dropped out of the tree, all of them gossipsub's own dependency subtree.

## What did NOT change (read before treating as a gap)

- The `services:` cast and its `NOTE:` at `libp2p-node-base.ts:544` — deliberately untouched, see
  above. Do not fold that into this ticket's scope.
- No opt-in flag or config surface was added for `pubsub`. The fix-stage ticket considered and
  rejected both "keep it but make failure loud" and "make it opt-in" — there is no known-working
  gossipsub version for libp2p 3 to opt into, so a switch would only ever fail. If a human wants
  that reconsidered, it's a fresh decision, not a gap in this implementation.

## Validation performed

All run in the foreground, no output redirection:

- `yarn install` — 20 packages removed (gossipsub's subtree), no errors.
- `yarn why @libp2p/interface` — confirmed no 2.x copy remains; 3.1.0-vs-3.2.3 split still present
  (expected, tracked by the separate debt ticket).
- `yarn lint` (root) — clean, no output.
- `yarn workspace @optimystic/db-p2p build` — clean, no output.
- `yarn workspace @optimystic/db-p2p typecheck` — clean, no output.
- `yarn workspace @optimystic/quereus-plugin-optimystic build` — clean (tsup + DTS build succeeded).
- `yarn workspace @optimystic/quereus-plugin-optimystic typecheck` — clean, no output.
- `yarn workspace @optimystic/db-p2p test` — **2391 passing, 49 pending** (pending are pre-existing
  skips, not new). Includes the updated `node-service-set.spec.ts` — all four cases (default TCP,
  browser-shaped, `/rn` factory, `relay: true`) pass against the new literal without `pubsub`.
- `yarn workspace @optimystic/db-p2p test:integration` — **30 passing, 2 pending** (both pending are
  pre-existing, unrelated `unimplemented`/mock-tier notes, not new). Real-socket suites (two-node
  mesh, multi-coordinator write, cohort gossip, relay hand-off, churn re-replication, etc.) all pass.

No test failures, pre-existing or otherwise, were observed in this run.

## Gaps / things the reviewer should know

- **Breaking change to a published package, not yet stated in a commit.** `@optimystic/db-p2p` is
  published to a registry. A downstream consumer currently reading `node.services.pubsub` gets a
  gossipsub instance that silently drops every message it's asked to publish; after this change they
  get `undefined` on that key. That's strictly more diagnosable than silent message loss, but it is
  still a breaking change to the service map's shape and needs to be visible in the generated
  release notes (`docs/releasing.md` runs `gh release create v{version} --generate-notes`, which
  reads commit history). **Whoever creates the commit for this diff should include a
  `BREAKING CHANGE:` trailer/footer naming the removed `services.pubsub` key** — the implementer did
  not commit (runner handles commits), so this could not be done from here.
- **Human action outstanding, explicitly out of scope for any agent:** the fix-stage ticket asks for
  a reply on GitHub issue #9 (gotchoices/Optimystic, reporter `aarashrestha`) confirming the
  diagnosis and stating that gossipsub 14.1.2 is the newest published version, so there's nothing to
  upgrade to. That has not been done and should not be done by an agent — flagging it here so it
  isn't lost.
- Not independently re-verified in this stage: the fix-stage ticket's own repro (two real TCP libp2p
  nodes, gossipsub-only pubsub, connect + subscribe + publish, zero recipients) — that repro's
  scripts were already deleted before this ticket started, per the fix ticket's own note. This
  implementation trusts that diagnosis and removes the registration; it does not re-run the
  standalone repro. If a reviewer wants an independent check, the fastest one is: confirm
  `grep -rn "pubsub" packages/*/src` still returns nothing (production code never depended on the
  key), which was re-checked here and is clean.
