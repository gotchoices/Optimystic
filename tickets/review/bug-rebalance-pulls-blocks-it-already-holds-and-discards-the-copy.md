description: A background process that keeps copies of data in sync across machines was fetching a copy of data it already had, then throwing that copy away instead of using it — now it doesn't fetch at all.
architecture: docs/arachnode-ring-handoff.md
files:
  - packages/db-p2p/src/cluster/block-transfer.ts
  - packages/db-p2p/src/cluster/rebalance-monitor.ts
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/src/storage/ring-shift-coordinator.ts
  - packages/db-p2p/test/block-transfer.spec.ts
  - packages/db-p2p/test/rebalance-committed-holders.spec.ts
  - packages/db-p2p/test/rebalance-reaction.spec.ts
  - packages/db-p2p/test/cohort-growth-heals-single-holder.spec.ts
  - packages/db-p2p/test/rebalance-monitor-node-wiring.spec.ts
  - docs/internals.md
  - docs/arachnode-ring-handoff.md
----

# What changed

`BlockTransferCoordinator.handleRebalanceEvent` no longer reacts to `RebalanceEvent.gained` at all.
Previously, when `RebalanceMonitor` reported a node newly responsible for a block, the reaction called
`RestorationCoordinator.restore(blockId)` (a fetch over `/db-p2p/sync`) and discarded whatever it
returned — nothing was written to storage. Since `RebalanceMonitor`'s tracked-block set is built
entirely from blocks the node already stores (its own commits, received replicas, and repaired
blocks — see the updated `RebalanceEvent.gained` doc comment), the fetch could never supply a missing
block and, since it discarded the result, could never refresh a stale one either. It was pure waste:
one restore round-trip per gained block, uncapped, worst on every restart (the whole stored set reads
as `gained` on the first post-restart check).

## Removed

- `BlockTransferCoordinator.pullBlocks`, `executePull`, and the now-unused `withTimeout` helper
  (only caller was `executePull`).
- The `restorationCoordinator` constructor parameter on `BlockTransferCoordinator` — **this is a
  breaking constructor signature change**; every call site in `src` and `test` was updated
  (see `files:` above).
- The `pulled` field on `RebalanceReactionResult`.
- The `ownedBlocks.add(blockId)` loop over `event.gained` in `libp2p-node-base.ts` — it was already a
  no-op (a gained block is definitionally already in `ownedBlocks`, since that set is what
  `trackedBlocks` is fed from), and removing it is what exposes that this was documented as load-bearing
  ("added immediately … before its next commit/replica touches the feed") when it never was.

## Kept unchanged

- `RebalanceEvent.gained` itself is still reported (doc comment corrected to describe it as a
  responsibility signal, not a transfer trigger) — nothing consumes it for a transfer, but it's still
  useful for logs/monitoring and the monitor's own bookkeeping.
- `restorationCoordinatorV2` (the same `RestorationCoordinator` instance) stays wired as
  `newRestoreCallback` for `BlockStorage` — that's the *read-time* repair path (a reader that finds its
  own copy behind), a completely different mechanism from the removed rebalance-reaction fetch. Do not
  conflate the two if reviewing the `RestorationCoordinator` usages in `libp2p-node-base.ts`.
- A node that gains responsibility for a block it does **not** already hold still receives it — via a
  holder's cohort-growth push (the `grown` arm) or via repair on first read. Neither of those paths
  touched by this change.

## Left a hook for the future

`handleRebalanceEvent`'s doc comment and a `NOTE:` at the removed call site record that if
`trackedBlocks` ever grows a source that reports a block this node does *not* hold (a
declared-placement feed was the example given), a pull hook would belong there — but it would have to
persist and verify what it fetched (the way `cluster/reconcile-block.ts`'s corroborating repair does),
not adopt one unverified peer's answer the way the removed code did.

# Testing / validation

## New test

- `block-transfer.spec.ts`, `describe('reaction to gained blocks (responsibility signal only)')`: the
  single regression test the ticket asked for, replacing the deleted `pullBlocks` describe block. It
  wires `restoration.results` with a servable archive for the gained block (so if anything *did* still
  reach the restoration mock, this proves it) and asserts `restoration.restoreCalls` **and**
  `peerNetwork.connectCalls` both stay empty after `handleRebalanceEvent`, and that the result no
  longer carries a `pulled` property.

## Existing tests repointed (not new coverage, same property, different vehicle)

The following tests exercised generic `BlockTransferCoordinator` infrastructure (the semaphore, the
retry/backoff loop) via `pullBlocks` purely as a convenient vehicle — since `pullBlocks` is gone, I
rewrote them against `pushBlocks` instead, preserving what they actually verify:

- `block-transfer.spec.ts` → `concurrency limiting` → `'does not deadlock when all concurrent tasks
  retry'`: now fails two pushes' first dial attempt and lets the retry succeed, same
  maxConcurrency=2/2-block/call-count=4 shape as before.
- `block-transfer.spec.ts` → `concurrency limiting` → `'limits concurrent transfers to
  maxConcurrency'`: now pushes 6 blocks to 6 distinct owners with an instrumented `connect()` tracking
  peak concurrency, same maxConcurrency=2/6-block shape as before.
- `block-transfer.spec.ts` → `handleRebalanceEvent` → `'processes gained and lost blocks from a
  rebalance event'` renamed to `'confirms a lost block replicated to its new owner, and makes no
  restoration call for a co-reported gained block'`: kept the lost-block confirmation assertion, and
  the gained-block assertion is now that `restoration.restoreCalls` stays empty rather than that it
  contains the block.
- `rebalance-committed-holders.spec.ts`: the `transfersOf` helper's `pulls` field is renamed to
  `gainedReports` (it was never a transfer even before this ticket when holder evidence suppressed the
  report — see below) and its doc comment corrected. Assertion substance is unchanged per the ticket's
  instruction.
- `rebalance-reaction.spec.ts`: the topology-triggered gained-event test ('a topology-triggered gained
  event drives the coordinator to PULL via restoration') is rewritten to
  `'…reaches the coordinator but drives no fetch…'`. Since there's no longer a positive network/restore
  effect to poll for, I added a `reactions: Promise<unknown>[]` array to the `wire()` helper (the
  reaction promise is pushed synchronously alongside the event, in the same `onRebalance` callback), so
  the test can deterministically await the (now empty) reaction before asserting nothing was called.

## Removed with no replacement — flagging as a gap, not papering over it

- `block-transfer.spec.ts` → `idempotent block receipt` (pulling a block already present is a no-op via
  restoration) — pull-specific, no direct push analog exists (a push's own idempotency is that
  `executePush`'s `inFlight` set dedupes a concurrent call for the same block id, which the concurrency
  tests exercise incidentally but don't assert on directly).
- `block-transfer.spec.ts` → `timeout behavior` → `'times out slow transfers'` (the *whole-operation*
  `withTimeout` wrapper firing) — this tested the deleted `withTimeout` helper specifically. Push/confirm
  timeouts are enforced per-peer inside `pushBlockToPeers` (`dialTimeoutMs`/`responseTimeoutMs`), which
  is a materially different mechanism already covered elsewhere (`rpc-response-deadline.spec.ts`,
  `protocol-client-dial-timeout.spec.ts`) — not a coverage hole this ticket introduced, but I did not
  add a new push-specific "one peer hangs, the operation times out and retries" test to replace it
  one-for-one. If that specific shape (per-attempt timeout → retry → eventual failure, at the
  `BlockTransferCoordinator` level rather than the wire level) matters, it's worth a follow-up.

## Manual verification

- `yarn build` — clean.
- `yarn workspace @optimystic/db-p2p test` — 3109 passing, 0 failing, 63 pending (pre-existing
  env-gated/long-test skips, unrelated to this change).
- `yarn lint:docs` — all citations/links resolve (47 documents, 164 anchored citations, 670 mentions,
  390 links).
- `npx eslint` scoped to every file this ticket touched — clean.

# Known gaps / things the reviewer should specifically check

1. **Breaking constructor change blast radius.** `BlockTransferCoordinator`'s constructor dropped a
   positional parameter (`restorationCoordinator`, previously 3rd of 6). I grepped the whole repo
   (`*.ts`, all packages) for `new BlockTransferCoordinator(` and fixed every call site I found (4
   total: `libp2p-node-base.ts` + 3 test files). Worth a second grep pass in review in case something
   was missed (e.g. a `.js` file outside the indexed/grep-friendly set, though this is a TS-only repo).
2. I did not run `yarn test:integration` (the `OPTIMYSTIC_INTEGRATION=1`-gated suite) or
   `yarn check:rn` — out of scope for the ticket's explicit validation ask (`yarn build`, `yarn
   workspace @optimystic/db-p2p test`, `yarn lint:docs`), but worth knowing if the reviewer wants
   broader confidence, particularly since `libp2p-node-base.ts` wiring changed.
3. The doc edits in `docs/internals.md` § RebalanceMonitor → Holder evidence required more than a
   mechanical find-replace, since the "holder evidence suppresses `gained`" logic in
   `performRebalanceCheck` (`rebalance-monitor.ts`) is untouched by this ticket — only what happens
   *after* `gained` is reported changed. Worth double-checking my rewritten paragraph doesn't overstate
   or understate what evidence still does (it still suppresses the `gained` report itself; it no longer
   needs to suppress a *pull*, since nothing pulls regardless of evidence).
