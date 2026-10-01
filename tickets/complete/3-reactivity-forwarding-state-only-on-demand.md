description: A machine that sends change announcements used to keep a replay buffer and gossip about every collection it stores, whether or not anyone was listening; it now does so only for collections someone has subscribed to, so turning the feature on for one table no longer makes every other table pay for it.
prereq: network-collection-watch-service
architecture: docs/reactivity.md#forwarder-cohort-state-per-collection-served
files: packages/db-p2p/src/reactivity/forwarder-host.ts, packages/db-p2p/test/reactivity/forwarder-host.spec.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, packages/db-p2p/src/testing/reactivity-mesh-harness.ts, docs/reactivity.md, docs/internals.md
----

# Keep per-collection forwarding state only where someone subscribed

## What landed

`ReactivityForwarderHost` (`packages/db-p2p/src/reactivity/forwarder-host.ts`) builds a topic's `PushState` (replay ring, dedupe window, per-subscriber queues) only when the topic has demand — at least one direct subscriber (`hasDemand`). Before, the first notification for any topic built it, and every built state was gossiped every round. `resolveServed` checks, in order: the memo; the Edge gate (`mayServeAsReactivityForwarder`, memoized as `null`); the demand check (not memoized, so the first ingest after a registration builds state). No change to node wiring was needed — the existing `directSubscribers` dependency is the demand signal.

The review pass added a release of per-topic maps that every collection, watched or not, was paying for (see findings).

Tests: `forwarder-host.spec.ts` "builds no forwarding state for a topic nobody subscribed to…" (the new branch) and "releases a drained tail no recover request ever asked about…" (the review fix); the child-cohort test and the real-libp2p resume integration test were adjusted to register a subscriber first.

Docs: `docs/reactivity.md` § Forwarder-cohort state (when state is built, what a late subscriber gets) and § Tail rotation step 2 (when a drained tail is released); `docs/internals.md` "Now end-to-end live" bullet.

## Review findings

Read the implement diff (`ticket(implement): reactivity-forwarding-state-only-on-demand`) first, then the whole of `forwarder-host.ts`, its node wiring in `libp2p-node-base.ts`, `ReactivityOriginationManager`, the recover serve's use of `pushStateFor` / `pushStateForCollection`, the push-state gossip driver, and `findServing` in the cohort-topic host.

**Correctness of the change — no defect found.**
- Gate order (Edge before demand) is right: an Edge node memoizes `null` and never re-scans; a no-demand answer stores nothing.
- `requireForwarderPushState` re-checks the gate it follows; harmless, and it turns a future reordering into a loud error rather than an Edge forwarder.
- Rotation interaction is an improvement, not a regression: a backfill's redirect is keyed on the collection's current served tail, and the new tail's state now forms only once a subscriber re-registers there, so the old tail's `kind:"rotated"` redirect stays reachable for that whole interval instead of vanishing on the new tail's first commit. `docs/reactivity.md` § Backfill already describes it in those terms.
- Inbound push-state gossip for a topic with no state was already ignored before this change; unchanged.
- Cost: `hasDemand` costs exactly what one fan-out's subscriber read cost before (in the node wiring, `findServing` is a scan over served cohort engines, not one lookup), and now runs once per stateless ingest instead of on every ingest of every topic — never more work than before. The JSDoc and `docs/reactivity.md` said "one registry lookup"; corrected to describe the scan.

**Minor — fixed in this pass: per-topic maps grew with the commit count for every collection.** Both are pre-existing, but they are exactly the "every other table pays" cost this ticket set out to remove:
- `ingestTails` got one entry per topic ever ingested — every collection this node originates for, one topic per filled log tail block (so roughly one per 32 commits) — and was only deleted on a rotation release. `ingest` now drops the entry once its chain settles with nothing queued behind it.
- `rotationGates` (and any served state behind them) were released only when a recover request asked about that old tail after its window closed. `ReactivityOriginationManager` calls `markRotated` for every collection's rotation, watched or not, and nobody sends a recover request for a collection nobody watches, so the gates accumulated one per filled log block. `markRotated` now sweeps every gate whose drain window has closed (`releaseDrainedTopics`, sharing `releaseDrainedTopic` with `rotationRedirectFor`); the gate set is now bounded by rotations within the last `T_drain` (60 s). Pinned by the new "releases a drained tail…" test, which fails without the sweep.
- Removed an unused `NodeProfile` import in `forwarder-host.spec.ts`.

**Tripwires recorded.**
- The served state outlives its last subscriber until a rotation releases it — `NOTE:` at `served` (from implement; its wording was updated to name the new release point).
- The mock mesh harness still builds `PushState` at `registerCollection`, so it buffers commits made before anyone subscribed — `NOTE:` at `makePushState` in `packages/db-p2p/src/testing/reactivity-mesh-harness.ts`.

**Not covered by a test, checked by reading the code (no ticket — no defect found):** cohort members other than the primary build state only after the registration record reaches them over cohort gossip; until then a backfill reaching one of them declines and the recover transport tries the next member. A raw `createReactivitySubscriber` consumer outside the watch service that starts at a real revision sees the late-subscriber gap; whether escalation wakes it depends on its own wiring — the watch service, the only host consumer today, wakes on it and on its tick.

**Tests reviewed.** The implementer's new test pins the one new branch and stays. The two adjusted tests were adjusted correctly — their old setup relied on state being built with no subscriber. No test was cut.

**Docs.** Every doc the change touches was re-read against the code: `docs/reactivity.md` (two paragraphs corrected, see above), `docs/internals.md` (accurate). `yarn lint:docs` clean.

**Validation.** `yarn build`, `yarn typecheck`: clean. `yarn workspace @optimystic/db-p2p test`: 3162 passing, 64 pending, 0 failing. db-p2p `test:integration` (`OPTIMYSTIC_INTEGRATION=1`): 45 passing, 2 pending. eslint on the changed files: clean. The `quereus-plugin-optimystic` integration suite was not re-run in review (the review edits are confined to the forwarder host's per-topic bookkeeping, which that suite reaches only through the db-p2p paths already run).

The working tree also holds uncommitted edits this review did not make (`connection-monitor.ts`, `libp2p-node-base.ts`, `rpc-deadline.ts`, `packages/db-p2p/readme.md`, `link-deadlines.spec.ts`); they were left untouched.
