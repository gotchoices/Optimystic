description: A machine that notices it was registered to watch a table with the wrong set of machines now gets a fresh answer when it retries, instead of being handed back the same cached (wrong) answer — so the retry can actually land somewhere different.
architecture: docs/reactivity.md#the-nodes-watch-service
files: packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/topic-router.ts, packages/db-p2p/src/reactivity/collection-watch.ts, packages/db-p2p/src/libp2p-node-base.ts, docs/cohort-topic.md, docs/reactivity.md, packages/db-p2p/test/cohort-topic/root-step-reads-the-group-live.spec.ts
----

# What changed

The register walk's **root step** now reads the root group live instead of through the host's per-coordinate snapshot. Everything else that reads the root group is untouched.

**`packages/db-p2p/src/cohort-topic/host.ts`**

- `RootGroupSnapshots` gains a third read mode, `live(coord)`, alongside `ensure` (snapshot if younger than max age, else fresh) and `refresh` (fresh, the gossip-cadence driver's). `live` is the same shared private `read(coord, key)` the other two use — so concurrent walks at one coordinate still coalesce onto a single `membersAt` call and a successful read still replaces the held snapshot — with one addition: when the fresh read rejects it falls back to the held snapshot (logging that it did), and rethrows only when nothing is held. That fallback is what makes `live` never worse for its caller than `ensure` would have been.
- The router's `rootGroupMembers` in `createCohortTopicHost` is bound to `snapshots.live` instead of `snapshots.ensure` (host.ts:1074). This is the only call site that moved.
- Every other `ensure` / `refresh` caller is unchanged: the membership source's `rootGroupPeers`, the promotion-notice fan-out, the `/sign` endorser paths, the gossip/engine-creation dispatch, and the engine's gossip-round `refresh`. The snapshot store, its max age (the gossip interval) and its LRU bound are all as they were.

**Comments and docs rewritten to the post-fix truth** (the old text asserted the broken behaviour as fact and named this ticket as the open work; no mention of the slug survives anywhere outside `tickets/`):

- `host.ts` — the module doc now says the walk's root step is the one root-group read that bypasses the snapshot; the second NOTE on the root-placed engine no longer claims the repair walk re-dials the snapshot (its own unchanged revisit condition — whether to close a root-placed engine on a refresh that drops self — is kept).
- `topic-router.ts` — `FretTopicRouterOptions.rootGroupMembers` says the host binds it to a live read and why.
- `collection-watch.ts` — the NOTE on the repair attempt in `verifyRootGroup`, the `verifyRootGroup` doc comment, the class-level "bounded by a tick" sentence, and the comment on holding the mismatch count one short of the threshold.
- `libp2p-node-base.ts` — the NOTE at `rootGroupMembers: resolveReactivityCohort` (detector and repair now read the same rule).
- `docs/cohort-topic.md` §Root placement at a routing key, *Implementation (db-p2p host)* — the root step reads `membersAt` fresh, every synchronous site reads the snapshot, and why the two differ.
- `docs/reactivity.md` §The node's watch service — the "**The repair is bounded by a tick, not by a walk**" bullet is now "**The repair walk reads the same rule the check does**"; the preceding bullet's claim that the snapshot is "one of the ways a registration lands outside its group" is narrowed to the admitting member's view; §How long a missed commit can go unseen agrees with both.

**A tripwire recorded, not filed** (see *Residual* below): a `NOTE:` at the member-set comparison in `verifyRootGroup` (`collection-watch.ts:803`) records that the latched set is the *admitting member's* own engine view, up to one gossip interval old, so a mismatch this node cannot influence is still bounded by one watch tick. The pre-existing NOTE there about persistently divergent ring views is kept.

# Residual, deliberately not addressed

The member set the mismatch check compares against is the set the **admitting member** reported — that member's engine view, refreshed on its gossip rounds. So a placement can still be judged mismatched for a reason this node cannot influence, and a repair walk that correctly dials the live group reaches the same first member and is handed the same stale report back. That case self-clears within one gossip interval on the admitting member and is then repaired by the next watch tick, so the bound there stays one tick. The ticket explicitly ruled out widening to the admission side (a live read ahead of the anti-DoS gate on the inbound register path) and ruled out carrying the dialed member list back on `RegistrationHandle`; both rejections and their reasoning are in the implement ticket's *What this fixes, and what it does not*, and the escape hatch for persistently divergent ring views remains as the pre-existing NOTE in `verifyRootGroup`.

# Reproduction — verified both ways

New spec `packages/db-p2p/test/cohort-topic/root-step-reads-the-group-live.spec.ts` (one test, the reproduction at the lowest layer that reproduces it — the host's root step over the in-process mesh). Three-node mesh, one participant plus two single-machine root groups, two register walks at the same root key with the participant's `membersAt` answer changed in between.

- **With the fix:** passes — the second walk lands on `[g1]`, the group the rule names now.
- **Reverted to `snapshots.ensure` (confirmed during this run, then restored):** fails — the second walk lands on `[g0]`, the first walk's group. The assertion diff names both peer ids, so the failure is the actual misplacement, not a timing artifact.

It pins what §Root placement at a routing key says the root step resolves the group by; nothing else in the suite covers a *second* walk at the same root key. No other test was added — the `live` fallback-on-rejection branch is the only other new logic and testing it would mean mocking `membersAt` to throw against a host we own, which is the wrong layer.

# What a reviewer should probe

- **The `live` fallback branch is the one piece with no test.** Read `host.ts:500-513`: on a rejected fresh read it returns the held snapshot if there is one, else rethrows. The question worth asking is whether returning a *stale* snapshot to a caller whose whole point is freshness is the right call — the argument in the code is "never worse off than `ensure`", since `ensure` would have returned that same snapshot without even attempting the read. The alternative (always rethrow) would make a transient ring-read failure fail the walk outright where it previously succeeded from cache.
- **Coalescing semantics.** `live` shares `inFlight` with `ensure` and `refresh`, so a walk's `live` can be served a read that an `ensure` started milliseconds earlier. That read is still *fresh* (it was started after the walk's own predecessor completed and cleared `inFlight`), but it is worth convincing yourself the in-flight map cannot hand `live` a read that began before the event the walk is reacting to. The `.finally(() => inFlight.delete(key))` runs on settle, and the landing check awaits the register reply, so the predecessor's read has settled before the repair walk starts.
- **Whether any remaining `ensure` caller should also have moved.** Five sites still call `ensure` (host.ts:1086, 1180, 1346, 1438, 1563). The claim is that all of them are synchronous-cohort or inbound-frame paths the snapshot exists for. `rootGroupPeers` on the membership source (1086) is the least obvious — a root-placed cert fetch asks the group the trust anchor judges by, so reading the snapshot there is deliberate agreement with the anchor, not an oversight; worth a second opinion.
- **Doc/comment accuracy.** Several passages were rewritten from "the repair re-lands the same placement" to "the repair reaches the live group, except when the admitting member's view is stale". A reviewer who disagrees with where that line is drawn should say so against `docs/reactivity.md:111-112` and `collection-watch.ts:803`.
- **Performance claim.** The comment at the router wiring says a register walk is rare (attach, tail rotation, repair) and `membersAt` is a ring read plus cached peerStore records, not a network round trip. That is the implement ticket's stated trade, carried over unmeasured — if a reviewer wants a magnitude on it, none was taken.

# Commands run

From `packages/db-p2p`:

```
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cohort-topic/root-step-reads-the-group-live.spec.ts" --reporter spec     # 1 passing
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cohort-topic/live-tier.spec.ts" "test/cohort-topic/service.spec.ts" "test/cohort-topic/topic-router.spec.ts" "test/cohort-topic/membership-source.spec.ts" "test/cohort-topic/root-step-reads-the-group-live.spec.ts" --reporter dot     # 36 passing
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/reactivity/*.spec.ts" --reporter dot     # 184 passing
yarn build     # clean
```

From the repo root:

```
yarn workspace @optimystic/db-p2p typecheck     # clean
yarn lint:docs     # 49 documents, 886 anchored citations, 920 file mentions, 846 links — all resolve
yarn lint:deps     # every import declared; libp2p majors as expected
```

Per `tickets/rules/testing.md` no full package suite was run here — that is this stage's job. The suites to run are db-p2p's full `yarn test` (the two suites above are its cohort-topic and reactivity slices) ; nothing in this change touches another package. No pre-existing failures were seen in anything run.
