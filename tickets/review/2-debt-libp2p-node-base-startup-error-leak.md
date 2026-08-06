description: A peer-to-peer node that failed partway through starting up used to keep running with its network port still open; it now shuts itself down cleanly and reports the original error.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/startup-rollback.spec.ts
difficulty: medium
----

## What changed

`createLibp2pNodeBase` starts the libp2p node early (`await node.start()`) and then runs roughly
930 lines of async wiring against the already-started node. Any throw in that span used to reject
out of the factory while the node kept running — the caller got an error and **no node handle**, so
it could not stop the node either. The TCP listener stayed bound and the leaked handles kept the
host process alive.

Three changes, all inside `packages/db-p2p/src/libp2p-node-base.ts`:

**1. One rollback for the whole post-start body.** Everything from `await node.start()` to the
`return` is now inside a `try`; the `catch` calls `node.stop()` (guarded, so a rollback failure is
logged via the existing `wiringLog` and never masks the real error) and rethrows the original error.

**2. The three ad-hoc stop-and-rethrow blocks are gone**, since the outer rollback subsumes them:
the `networkManager.setReputation` injection, the cohort-topic FRET-unavailable hard-fail, and the
`createCohortTopicHost` failure. The errors they raised are unchanged; only the
`try`/`catch`/`await node.stop()` scaffolding was deleted, and `host` went back to being a plain
`const`.

**3. Two teardown wrappers moved next to the resources they release.** `node.stop()` is
progressively decorated by stop wrappers, each capturing the previous `node.stop`. A rollback
therefore only unwinds resources whose wrapper was *already installed* when the throw happened, so a
wrapper trailing its resource by hundreds of lines leaks it:

- the `clusterMember` dispose wrapper moved up to immediately after `clusterImpl` is assigned
  (previously ~500 lines later);
- the cohort-topic / reactivity / matchmaking teardown wrapper moved up to immediately after
  `createCohortTopicHost` returns (previously ~240 lines later, at the very end of the block). The
  bindings it releases (`unsubscribeCohortBridge`, `offInboundNotify`, `pushStateGossip`,
  `reactivityRotation`) are now `let … | undefined` declared ahead of the wrapper and
  undefined-guarded inside it — the same idiom the existing `offOwnedBlockFeed?.()` wrapper uses —
  so it tears down exactly what exists at the throw point.

## How to read the diff

The rollback `try` re-indents ~930 lines by one tab. **Read it with `git diff -w`** — that reduces
it to ~130 lines and shows only the real changes. I verified `git diff -w` contains nothing beyond
the four intended edits (rollback wrapper, ad-hoc-block deletions, two wrapper moves, the `let`
conversions) plus the tripwire comment below.

## Validation performed

```
cd packages/db-p2p
yarn build                       # exit 0
npx tsc --noEmit                 # exit 0
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter spec
                                 # 1544 passing, 44 pending, 0 failing, exit 0, ~1m wall clock
```

(The ticket warned the full suite might exceed a 5-minute budget; it did not — it finished in about
a minute with the `spec` reporter.)

New spec `packages/db-p2p/test/startup-rollback.spec.ts`, two cases, both passing:

- **`persistence.load()` throws** — the first throwable step after `node.start()`, and the site the
  ticket reproduced the leak at. Asserts the factory rejects with the *original* error
  (`'corrupt persisted state'`, not a rollback error) and that the listener port is bindable again.
  This is the class test: it pins "a post-start failure releases the port" for any setup step added
  to this factory later.
- **cohort-topic host construction fails** — `cohortTopic.host.protocols` is given two entries
  sharing one protocol id, so libp2p's registrar rejects the duplicate inside
  `createCohortTopicHost`. Asserts the rejection is specifically `DuplicateProtocolHandlerError` on
  `/optimystic/cohort-topic/1.0.0/register` (so the case cannot silently start passing because the
  node rejected earlier for an unrelated reason) and that the port is released. This case was green
  before the fix too — deliberately: it guards the deletion of the ad-hoc stop block at that seam.

The spec carries a `NOTE:` recording the operational hazard: when the port assertion *fails*, the
leaked node keeps mocha alive so `yarn test` hangs at exit rather than returning. Debug such a run
with `--exit`; `--exit` was **not** added to the package's `test` script.

Normal-stop coverage for the moved wrappers already exists and stayed green:
`cohort-topic/host-node-activation.spec.ts` ("teardown: node.stop() releases the bridge subscription
and stops the host"), `spread-on-churn-node-wiring.spec.ts`, `rebalance-monitor-node-wiring.spec.ts`.

## Known gaps — please scrutinise these

**Teardown ordering shifted on the normal stop path.** Stop wrappers run last-installed-first, so
moving the `clusterMember` dispose wrapper earlier means `dispose()` (which clears the member's
expiration/cleanup intervals and pending transaction timeouts) now runs *later* in the chain — just
before the transports close, rather than immediately after the cohort teardown. I found nothing that
depends on that relative order (the monitors do not touch `clusterImpl`, and `dispose()` is pure
timer/state cleanup), but it is a real behaviour change on every clean shutdown, not only on
rollback. Worth a second opinion.

**The two wrapper moves have no direct regression test.** Nothing proves that a throw *between* a
resource and its old wrapper position now clears that resource — because neither span is
failure-injectable through `NodeOptions`. In the cohort span specifically, every step after
`createCohortTopicHost` is either an infallible constructor or one of the `register*Handler` helpers,
which call `node.handle` fire-and-forget (see the tripwire below) and so cannot throw synchronously.
Both moves are justified by reading the wrapper chain plus the normal-stop tests staying green; a
reviewer who can find an injection point should add the case.

**`node.unhandle` on never-registered protocols.** The hoisted cohort wrapper unconditionally
unhandles the reactivity and matchmaking protocol lists, which on a mid-wiring rollback may include
protocols that were never registered. That is safe because libp2p's registrar `unhandle` is a plain
`Map.delete` per protocol (verified in `libp2p/dist/src/registrar.js`, `unhandle`), so I did not add
per-registration flags. If a reviewer prefers not to depend on that, flags are the alternative.

**Tripwire parked in code, not filed as a ticket.** The four `register*Handler` helpers (reactivity
notify / push-state-gossip / recover, and the matchmaking query handler) all call `node.handle(...)`
with a bare `void`, so a rejected registration escapes the new rollback as an unhandled rejection
instead of failing node creation. It is unreachable in practice today — every id involved is a fixed
constant registered once — so I recorded it as a `NOTE:` at the composition root in
`libp2p-node-base.ts`, immediately above the `registerNotifyHandler` call, with the condition that
would make it real (any of those ids becoming caller-configurable, or a helper growing a genuinely
fallible registration). Not filed as a ticket.

## Review findings

- Tripwire: the reactivity/matchmaking `register*Handler` helpers register protocols
  fire-and-forget, so a registration failure would bypass the new rollback. Parked as a `NOTE:` in
  `packages/db-p2p/src/libp2p-node-base.ts` above the `registerNotifyHandler` call.
