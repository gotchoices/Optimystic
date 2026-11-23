description: A machine that starts watching a table for changes could have its registration recorded by the wrong group of machines, leaving it unnotified for about a minute and a half with nothing noticing. The watcher now re-reads which group is responsible — right after it registers, and on every later check-in — and registers again when the two disagree. Reported from Sereus (`sereus` `tickets/blocked/report-reactivity-registration-lands-outside-the-root-group`).
architecture: docs/reactivity.md#the-nodes-watch-service
files: packages/db-p2p/src/reactivity/collection-watch.ts, packages/db-p2p/src/reactivity/subscription-manager.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/test/reactivity/collection-watch.spec.ts, docs/reactivity.md
----

## What landed

A reactivity registration names the collection's log tail as its root key. The register walk resolves the tail's root group, dials its members in order, and the first that answers admits the registration — and that member's own view of the group was then latched on the handle for the registration's whole life. `ReactivitySubscriptionManager.followTail` compares root *keys* only, so a registration sitting at the right ring coordinate with the wrong member set was never made again, and every other repair path was closed: announcers read only their own local registry, cohort gossip merges a record delta only from a matching cohort epoch (a function of the member set), the holder keeps serving what it holds, and the keep-alive pings a deterministic primary that holds nothing and strikes out only after ≈ 90 s on Core. `isAttached` reported the collection as attached throughout.

The watch service now reads the root group **live** and registers again when the registration's member set is not the group's.

- **New seam** — `ReactivityCollectionWatchOptions.rootGroupMembers?: (rootKey: Uint8Array) => Promise<readonly string[]>`. Absent ⇒ the checks are inert and the service behaves exactly as before, which is why no existing unit test or mesh spec changed.
- **Bound on a node** (`createLibp2pNodeBase` in `packages/db-p2p/src/libp2p-node-base.ts`, the `reactivityWatch` construction) to the existing `resolveReactivityCohort` — `rootGroupAt(reactivityRootCoord(tailId))`, i.e. `keyNetwork.servingCohortAt`. Deliberately the placement rule read live, not the host's snapshot view.
- **On a landing** — `moveThenRecheck` ends with `verifyRootGroup(sub, /* confirm */ false)`, after the existing post-landing tail re-read, so the reading judges whichever registration is live after that re-read.
- **On a tick** — each subscription's step takes one reading and acts on the **second consecutive** mismatch (`MISMATCH_READINGS_BEFORE_REREGISTER = 2`): one reading is the shape of a momentary membership misread, a real move persists.
- **Skipped**: `treeTier ≥ 1` (its cohort is at `coord_d(P, topicId)`, so a different member set is correct), no `rootKey`, and an empty set on either side (an empty read means "not known", not "the group is empty").
- **Comparison** is order-independent (`memberSetKey`: peer-id strings sorted and joined), equivalent to comparing `cohortEpoch` without hashing. Handle `cohortMembers` bytes → strings via `bytesToPeerIdString`.
- **Refactor**: `moveTo`'s failure/close handling was lifted into `place`, which the re-registration shares. `ReactivitySubscriptionManager.register()` is the call used to re-place at an unchanged root key; `followTail`'s key-only early return is untouched and both are now documented as to why.
- **Observability**: a re-registration, and the "waiting for a second reading" case, each log the collection, the member set the registration names, and the set the group reads.

Implemented by `ticket(implement): reactivity-registration-held-outside-the-tail-root-group`; the review changes below are in the same working tree.

## Review findings

**Read first:** the implement-stage diff on its own, then the handoff. Checked by reading: the encoding chain for the comparison (host member bytes → wire base64url → `b64urlToBytes` → `bytesToPeerIdString`), the coordinate chain (`handle.rootKey` = `reactivityTailBytes` = `routingKeyForBlock`, hashed by `reactivityRootCoord` on one side and `addressing.rootCoord` on the other — the same value), the register walk's root step end to end (`WalkEngine.routeToTier` → `FretTopicRouter.routeToRoot` → `dialRootGroup`), the renewal failover's handle handling, `RootGroupSnapshots`, `Libp2pKeyPeerNetwork.servingCohortAt` and its cost, the mismatch counter's reset points against every path that reaches them, and the ticket board for a prior claim on these sites (none).

### Major — one finding, filed

**The detector and the repair read the root group by two different rules, so the immediate repair usually re-lands the same misplacement.** `verifyRootGroup` reads the group through `servingCohortAt`, which is uncached by design. The re-registration it then performs is an ordinary register walk, and on a node that serves root placement a walk's root step dials whatever `RootGroupSnapshots.ensure` holds — a cache whose max age is `DEFAULT_GOSSIP_INTERVAL_MS` (5 s). The landing check runs milliseconds after the walk it is reacting to, and that walk is what filled or refreshed the snapshot, so the repair is always inside the cache window: it is handed the same member list in the same order, the same member admits it, and the same wrong set is latched again. What repairs the registration is the *next* mismatched reading, by when the snapshot has been re-read.

Consequence: the real bound is a watch tick, not the "within one register walk" the handoff and `docs/reactivity.md` claimed. A caller that commits immediately after `watch` returns — the shape of the originating Sereus scenario — still sees no notification, so this ticket's own goal is probably not yet met end to end.

Filed as `tickets/fix/a-misplaced-registration-is-repaired-from-a-stale-group` (`repro: static` — read from the code, nothing measured; the ticket names what would confirm it). Filed at the invariant rather than the instance: one rule and one read for a placement's verification and its repair. Matchmaking registers at root-placed topics through the same router, so this is not reactivity-specific.

### Minor — fixed in this pass

- **The overstated bound, in all four places it was written.** `docs/reactivity.md` (the attach bullet, the tick bullet, and the "how long a missed commit can go unseen" entry, now **within T** with a new bullet explaining why), the `collection-watch.ts` module doc and `verifyRootGroup`'s doc, the appended accepted-tradeoff NOTE in `createCoordEngine` (`packages/db-p2p/src/cohort-topic/host.ts`, which claimed "repairs the condition in one round-trip"), and the binding comment in `libp2p-node-base.ts`.
- **"At most one re-registration per step" rested on the mismatch counter, not on the structure** — the handoff flagged this as the thing most likely to break under a later edit, and it was right: the tick's step called `verifyRootGroup` unconditionally even when the landing check had just read the group, and only the counter's reset point kept that from acting twice. `moveThenRecheck` → `follow` → `followAnswer` now report whether they read the group, and the tick's step reads it only if they did not. One reading per step by construction, and one fewer group read on every landing tick.
- **An unconfirmed immediate repair threw its own reading away.** After acting, the counter was cleared, so the common case above (an attempt that did not repair) waited *two* further ticks. The count is now held one short of the threshold, so the next mismatched reading acts: 2T → T, while the "second consecutive reading" rule itself is unchanged (the reading that acted is the first of the two, and a matching reading still clears the count).
- **The re-registration's log label** said "its root group moved", which is only one of the causes, and named `handle.rootKey` while `register()` places at `manager.latestTail`. Now labels the placement without claiming a cause.
- `host.ts`: the appended NOTE ran straight into the unrelated `childRegistry` comment as one block; separated.

### Resolved, not findings

- **The node binding** (`rootGroupMembers: resolveReactivityCohort`) is the live `servingCohortAt` path, as the handoff intended — `resolveReactivityCohort` is `rootGroupAt ∘ reactivityRootCoord` and `rootGroupAt` is `keyNetwork.servingCohortAt`, which carries its own NOTE on why it is never cached. Correct as wired; no test added for one-line wiring.
- **Interaction with renewal failover**, which the handoff could not confirm: `CohortTopicService.syncHandle` mutates `cohortMembers` onto the existing handle rather than replacing it, so `verifyRootGroup`'s `sub.manager?.registration !== handle` identity guard passes after a re-walk and the comparison sees the updated members. Both branches the handoff described are safe; this is the one that happens.
- **Cost of the per-tick group read.** `servingCohortAt` is a FRET ring read plus `PeerRecordCache` lookups (cached, 1-minute TTL, event-invalidated) — no network, consistent with the handoff's claim. Its one-shot bootstrap wait (`bootstrapContactImminent`) latches closed after the first deadline, so it is not a per-tick hazard.
- **A malformed `cohortMembers` entry** would make `bytesToPeerIdString` throw (its decoder is `fatal: true`), but every step the service runs is wrapped by `enqueue`'s catch, and the same idiom already decodes `primary`/`backups` on the dial path. Logs and retries; no regression.

### Tests

No test added or cut. The implementer's one new test pins the service-level contract (a second `register` at the same root key, order-independence, the second-consecutive rule) on logic with real branching, and it still reproduces the defect after the restructure above — re-verified by short-circuiting `verifyRootGroup`, which fails it at its first assertion (1 registration, expected 2). It cannot show that a repair walk reaches a *different* member, because its service is a stub; that gap is the filed finding's, not the test's, and a test at that layer would have to mock the repository's own router.

### Tripwires

Three were recorded by the implement stage and are left where they are — the forwarder's own-registry-only `directSubscribers` window, the accepted-tradeoff NOTE in `createCoordEngine` (text corrected above), and the asymmetric comparison in `verifyRootGroup`. The last one is partly subsumed by the filed ticket, which lists carrying the dialed member list on the handle as the alternative shape that would settle both.

One added: the NOTE at `verifyRootGroup`'s register attempt, stating the stale-snapshot asymmetry at the exact site a reader meets it, with the ticket slug. Mirrored at the node binding in `libp2p-node-base.ts`.

### Not raised

No finding on file size (`collection-watch.ts` is 940 lines after this pass, in a package whose `libp2p-node-base.ts` is ~3500 — no project rule and no size claim to measure against), on comment density (the added comments state constraints and consequences, not restatements of the statements they sit on), or on resource cleanup (the change adds no timer, listener or handle; the one new field is a counter on an existing structure).

## Validation

| Command | Result |
| --- | --- |
| `yarn build` (`packages/db-p2p`) | clean (its tsconfig includes `test`, so the spec typechecks here) |
| `yarn test` (`packages/db-p2p`) | 3881 passing, 84 pending |
| `yarn test` (`packages/quereus-plugin-optimystic`) | 1457 passing, 15 pending, smoke ok |
| `yarn test:integration` (root) | 60 passing / 2 pending (db-p2p) + 1464 passing / 8 pending (plugin), 7m 29s — includes the real-socket reactivity push spec |
| `yarn lint`, `yarn lint:docs`, `yarn lint:deps` (root) | clean; 49 documents, all citations and links resolve; every import declared |
| `yarn check:rn` (root) | passed — Metro 72.8 s, hermesc 13.3 s (run because the change adds an import to code the React Native entry re-exports) |

No pre-existing failures surfaced.

## Docs

`docs/reactivity.md` §The node's watch service: the attach check's bullet, a new **The repair is bounded by a tick, not by a walk** bullet, the tick bullet's reading rule, and the missed-commit bound for this case. The open ticket is named from the doc and from each of the three code sites.
