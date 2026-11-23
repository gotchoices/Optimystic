description: A machine that notices it was registered to watch a table with the wrong set of machines now gets a fresh answer when it retries, instead of being handed back the same cached (wrong) answer — so the retry can actually land somewhere different.
architecture: docs/reactivity.md#the-nodes-watch-service
files: packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/topic-router.ts, packages/db-p2p/src/reactivity/collection-watch.ts, packages/db-p2p/src/libp2p-node-base.ts, docs/cohort-topic.md, docs/reactivity.md, packages/db-p2p/test/cohort-topic/root-step-reads-the-group-live.spec.ts
----

# What landed

A machine that watches a table registers itself with the group of machines that hold the table's log tail. Which machines those are is decided by one rule — the key network's storage rule at the tail's ring position. Two parts of the register path used to read that rule by different means: the check that *judges* a placement read the rule live, while the walk that *performs* a placement read a cached copy of it (up to one gossip interval, 5 s, old). So the repair walk was handed the very list the misplacement came from, dialed the same machines in the same order, and re-landed the same wrong placement. What actually repaired it was the next watch tick, 30 s later on a Core node.

The register walk's **root step** now reads the group live. Implemented in `ticket(implement): a-misplaced-registration-is-repaired-from-a-stale-group`:

- `RootGroupSnapshots` in `packages/db-p2p/src/cohort-topic/host.ts` gained a third read mode, `live(coord)`, beside `ensure` (the held snapshot when younger than the gossip interval, else a fresh read) and `refresh` (always fresh, the gossip driver's). `live` is the same shared private `read(coord, key)` the other two use — so concurrent reads of one coordinate still coalesce onto a single `membersAt`, and a successful read still replaces the held snapshot — with the held snapshot returned, and logged, when the fresh read rejects, and the rejection rethrown when nothing is held.
- The router's `rootGroupMembers` in `createCohortTopicHost` is bound to `snapshots.live` instead of `snapshots.ensure` (`host.ts:1074`). That is the only call site that moved; the five remaining `ensure` callers and the one `refresh` caller are unchanged, as are the snapshot store, its max age and its LRU bound.
- The comments and doc passages that asserted the old behaviour as fact were rewritten to the post-fix truth, in `host.ts`, `topic-router.ts`, `collection-watch.ts`, `libp2p-node-base.ts`, `docs/cohort-topic.md` §Root placement at a routing key and `docs/reactivity.md` §The node's watch service / §How long a missed commit can go unseen. No mention of this ticket's slug survives outside `tickets/`.

One test was added: `packages/db-p2p/test/cohort-topic/root-step-reads-the-group-live.spec.ts`, the reproduction at the lowest layer that reproduces it (the host's root step over the in-process mesh harness) — a three-node mesh, two register walks at one root key with the walking node's view of the group changed in between.

## What is deliberately still true

A placement can still be judged mismatched for a reason the watching machine cannot influence. The member set the check compares against is not that machine's own reading — it is the set the **admitting** member reported, which is that member's engine view, refreshed on its gossip rounds and so up to one gossip interval old. A repair walk that correctly dials the live group can reach the same first member and be handed the same stale report back. That case clears itself within a gossip interval on the admitting member and is then repaired by the next watch tick, so the bound on it stays one tick. The implement ticket weighed and rejected both wider fixes — a live read on the inbound admission path, ahead of the anti-DoS gate, and carrying the dialed member list back on `RegistrationHandle` — and the reasoning is recorded as a `NOTE:` at the comparison in `verifyRootGroup`, alongside the pre-existing `NOTE:` about persistently divergent ring views.

# Review findings

Read the implement diff before the handoff. The reproduction was re-verified from both directions: reverting `host.ts:1074` to `snapshots.ensure` makes the new spec fail with the actual misplacement (`[g0]` where the rule now names `[g1]`, both peer ids named in the assertion diff), and restoring it makes it pass. So the one added test earns its keep — it is the reproduction, nothing else in the suite covers a second walk at the same root key, and it is not a wiring assertion.

**No correctness defect found.** The things worth probing were probed and came back clean:

- **The five remaining `ensure` callers were each read in place** (`host.ts:1086`, `1180`, `1346`, `1438`, `1563`) and none should have moved. Four are inbound-frame or synchronous-cohort paths the snapshot exists for. The least obvious, `rootGroupPeers` on the membership source (`1086`), fetches a root-placed certificate from the group the trust anchor judges that certificate by, so reading the same snapshot the anchor holds is deliberate agreement rather than an oversight. `prepareRootPlacedCoord` (`1563`) is the admission-side read the residual above is about, and leaving it on `ensure` is the implement ticket's explicit, reasoned choice.
- **The fallback-on-rejection branch** returns a snapshot of any age, where `ensure` would have rethrown — so the "never worse off than `ensure`" claim holds. What makes handing back a stale list *safe* for this caller specifically was missing from the comment and has been added: a member the group has since dropped answers `unwilling_member` naming the group, which the walk's own member retry then dials (`routeToRoot` in `topic-router.ts`). The branch is still untested, correctly — testing it would mean mocking `membersAt` to throw against a host this repo owns, which is the wrong layer.
- **Documentation and comment accuracy** was checked against the code rather than against the handoff, including the files the change *should* have touched. `rootGroup` is wired unconditionally on a node with a cohort-topic host (`libp2p-node-base.ts:2197`) and reactivity requires that host, so every watching node does get the live root step and the docs' scoping of that claim is sound. `yarn lint:docs` resolves all 886 anchored citations, 920 file mentions and 846 links.
- **No new imports in production code**, so `yarn check:rn` is not in scope for this change (it is required only when code that ships to React Native gains or changes imports). The test file's imports do not ship.

**Minor, fixed in this pass** (comment-only; no behaviour changed):

- `verifyRootGroup`'s doc comment said that landing on the same members again *means* the admitting member's view is the stale one. Two narrower causes also produce that outcome — the `live` fallback above, and the coalescing window below — so it now says it *points first at* that cause. The sentence's job is to tell a reader where to look first, and it still does.

**Tripwire recorded, not filed:**

- `live` is as fresh as the shared in-flight read, not as fresh as the call: a read that `ensure` or `refresh` started milliseconds earlier is handed back rather than a new one issued. On a node that both watches a collection and serves its root coordinate — the common small-network case — that node's engine refreshes on every gossip round, so a repair walk can in principle be answered from ring state read just before the event it is reacting to, and re-land the placement. The window is one `membersAt` (a ring read plus cached peerStore records) out of a 5 s gossip interval, and losing it costs the same one watch tick the admitting-member residual already bounds, so it is not work today. Parked as a `NOTE:` at `live` in `host.ts`, naming the escape hatch (a read that skips the shared `read`). This is also the answer to the handoff's own question about whether the in-flight map can hand `live` a read that began before the triggering event: it can, in that window — the handoff's reasoning covered only the walk's own predecessor read, not a concurrent gossip refresh.

**Observed and deliberately not filed:**

- `host.ts` is 4263 lines (`wc -l`), of which this change added 47. Size debt there is pre-existing, is not a regression this change introduced, and serves no anchor this ticket owns; a site-claim grep over `tickets/{backlog,fix,plan,implement,review}` found no open ticket claiming `RootGroupSnapshots` and none claiming `host.ts` on size grounds. Left for whoever files against that file's structure on its own terms.
- No unmeasured magnitude was introduced by the review. The implement ticket's performance trade — a register walk is rare (attach, tail rotation, repair) and `membersAt` is a ring read plus cached peerStore records, not a network round trip — is carried over unmeasured, as it was. It is not on the keep-alive path: renewal pings go through `dialMember` / `dialMemberRenewBatch`, not `routeToRoot`.

**Empty categories:** no major findings, so no tickets were filed. No speculative concerns beyond the one tripwire above. No accepted-tradeoff `NOTE:` at any site in the diff had its revisit condition tripped — the one on the root-placed engine in `host.ts` (whether to close an engine on a refresh that drops self) is untouched by this change and its condition still has not been met.

## Validation

All green, after the review's own fixes were in. Per `tickets/rules/testing.md` the full suites were run once, here.

```
yarn workspace @optimystic/db-p2p run build                                   # clean
yarn workspace @optimystic/db-p2p run typecheck                               # clean
# from packages/db-p2p
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter min              # 3882 passing, 84 pending, 0 failing
OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.integration.spec.ts"   # 60 passing, 2 pending, 0 failing
# from the repo root
yarn workspace @optimystic/quereus-plugin-optimystic run test                 # 1457 passing, 15 pending; smoke ok quereus@5.6.1
yarn lint                                                                     # clean
yarn lint:docs                                                                # 49 documents, 886 anchored citations, 920 file mentions, 846 links — all resolve
yarn lint:deps                                                               # 6 guarded packages on their expected majors; 1307 files, every import declared
```

The integration suite was run because the change touches reactivity and cohort assembly. `quereus-plugin-optimystic` was run because it depends on `db-p2p`. `yarn check:rn` was skipped for the reason given above (no production import changes). No pre-existing failures were seen in anything run.
