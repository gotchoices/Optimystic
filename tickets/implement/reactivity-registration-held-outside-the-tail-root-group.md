description: A machine that starts watching a table for changes can have its registration recorded by the wrong group of machines, and nothing ever notices — so for about a minute and a half nobody tells it when the table changes. Make the watcher check, right after it registers and again on every later check-in, that its registration is held by the group that will actually announce the table's changes, and register again when it is not. Reported from Sereus (`sereus` `tickets/blocked/report-reactivity-registration-lands-outside-the-root-group`).
architecture: docs/reactivity.md#the-nodes-watch-service
files: packages/db-p2p/src/reactivity/collection-watch.ts (`ReactivityCollectionWatch.moveTo`, `moveThenRecheck`, `tick`, `ReactivityCollectionWatchOptions`), packages/db-p2p/src/reactivity/subscription-manager.ts (`followTail`, `register`), packages/db-p2p/src/libp2p-node-base.ts (the `reactivityWatch` wiring, `rootGroupAt`), packages/db-p2p/src/cohort-topic/host.ts (`createRootGroupSnapshots`, the NOTE at line 2573), docs/reactivity.md (§The node's watch service)
difficulty: medium
repro: static
----

`repro: static` is about the *cause chain* below, which was read off the code. The **symptom** is observed: a three-machine Sereus scenario (`packages/integration-tests/src/scenarios/strand-reactivity-wakes-watchers.integration.ts` in `C:\Projects\sereus`) failed its push assertion in 2 of 4 runs on 2026-11-20 and 2 of 12 on 2026-11-21, and three instrumented runs all showed the misplaced record and its frozen keep-alive. The originating ticket, `fix/reactivity-registration-held-outside-the-tail-root-group`, carries that measurement in full.

## What the watcher gets wrong

A watch registers with the cohort under the collection's log tail as its root key. The register walk resolves the tail's **root group** — the serving cohort at `H(tail bytes)`, which is the group that stores the tail — dials those members in order, and the first one that answers admits the registration (`FretTopicRouter.dialRootGroup` in `packages/db-p2p/src/cohort-topic/topic-router.ts`). The reply carries that member's own view of the group, and it becomes the handle's `cohortMembers` / `cohortEpoch`.

**That answer is latched for the registration's whole life.** The only thing that ever re-examines it is `ReactivitySubscriptionManager.followTail`, and it compares the *root key* only:

```ts
// packages/db-p2p/src/reactivity/subscription-manager.ts:397
if (handle.rootKey !== undefined && bytesToB64url(handle.rootKey) === this.latestTailB64) {
    return false; // the registration already names this root
}
```

So a registration sitting at the right coordinate with the wrong member set is never re-made. The watch tick runs every 30 s (Core TTL / 3), reads the tail, finds it unchanged, and does nothing.

When the latched member set is wrong, every path that would repair or route around it is closed:

- **No announcer sees the record.** A member announcing a commit looks up direct subscribers only in its **own** local registry — `host.registry.findByCoord(reactivityRootCoord(rootTail))` at `packages/db-p2p/src/libp2p-node-base.ts:2297`. A record held by a machine outside the group is invisible to all of them.
- **Cohort gossip cannot carry the record out.** A gossip frame's broadcast targets come from the *sender's own* root-group snapshot, and the receiving side merges record deltas **only when the inbound cohort epoch equals its own** (`packages/db-core/src/cohort-topic/gossip/bus.ts:139-146`; the epoch is `H(sorted members)`, so a different member set is a different epoch). A holder with a wrong member set gossips to the wrong peers, and any peer that does get the frame drops the delta.
- **The holder keeps the record.** `packages/db-p2p/src/cohort-topic/host.ts:2573` is an accepted-tradeoff NOTE: a root-placed engine whose group rotates past this node keeps serving what it holds until the registry evicts it. Its stated revisit condition — "if stale primaries ever show up for root-placed topics" — is what this ticket is about.
- **The watcher's own keep-alive strikes out.** The admitting member stores the record locally (`packages/db-core/src/cohort-topic/member-engine.ts:418`) but replies with a **deterministic primary** computed by `assignSlots` over the member set — in general a *different* machine. The watcher pings that primary, which holds nothing, and answers `unknown_registration`. That is counted as a failed ping, so three consecutive pings (`MAX_PING_FAILURES` = 3, at `ttl/3`) strike out before the failover re-walk repairs anything: **≈90 s at the Core TTL of 90 s**, which matches the measurement in the originating ticket (a misplaced record whose `lastPing` never moved off `attachedAt` for 74 s).

Meanwhile `reactivityWatch.isAttached` reports the collection as registered, so nothing surfaces the condition.

## What was settled, and how

The originating fix ticket left one question open: is the root group genuinely different at the tail's coordinate, or did the commit rotate the tail so that the root coordinate moved with it? **The second is ruled out for this scenario**, by reading the log:

A collection's tail is `header.tailId`, and `Chain.add` (`packages/db-core/src/chain/chain.ts:107-152`) only re-points it when the current tail block cannot take the new entry — at `EntriesPerBlock` = 32 entries, or once the block's JSON passes `BLOCK_TARGET_BYTES` = 1 MiB (`packages/db-core/src/network/block-size.ts`). A table creation plus one small insert neither fills 32 entries nor reaches 1 MiB, so the tail block the watcher registered under is the same block the announcer announces at. The rotation machinery is therefore not involved, and the registration's coordinate is right while its member set is wrong.

What is **not** settled is why two machines read the group differently at that instant. `servingCohortAt` is deterministic given a ring view and a membership verdict per peer, and the originating ticket measured all three machines agreeing at eight fixed coordinates across the commit. The most likely candidate is `membershipOf` (`packages/db-p2p/src/libp2p-key-network.ts:1512`), whose own NOTE at line 1498 says a peer of this network can read `foreign` between a connection opening and identify landing, and that "the cost is one cohort assembly that leaves the peer out". That cost is normally self-correcting — except for root placement, which is the one consumer that *persists* an assembly's answer. That arm has been appended to `tickets/backlog/debt-a-peer-read-as-refusing-may-only-be-unidentified`, which already owns the misclassification-window theme; it is inferred from the code, not observed.

**Settling it is not a prerequisite for this fix.** The defect this ticket closes is that nothing re-checks a latched root group, whatever made it wrong — a momentary misclassification, real ring churn, or a snapshot read up to one gossip interval stale (`snapshots.ensure` serves a snapshot younger than `maxAgeMs`, bound to the 5 s gossip interval at `packages/db-p2p/src/cohort-topic/host.ts:1002`, and that is the read the register walk itself dials on). After this fix the condition repairs itself in one round-trip instead of ≈90 s, whichever cause fired.

## What to build

A new seam on the watch service that reads the root group **live**, and two places that use it.

```ts
/** `ReactivityCollectionWatchOptions`, new optional member. */
readonly rootGroupMembers?: (rootKey: Uint8Array) => Promise<readonly string[]>;
```

Bind it in `packages/db-p2p/src/libp2p-node-base.ts` to the rule itself — `keyNetwork.servingCohortAt(reactivityRootCoord(rootKey))`, the existing `rootGroupAt` binding — **not** to the host's `rootGroupMembers`, which goes through `snapshots.ensure` and can answer from a snapshot up to 5 s old. Absent ⇒ the checks below are inert and the service behaves exactly as it does today (so every existing unit test and the mesh harness are unaffected).

The comparison is a **member-set** comparison, order-independent: the handle's `cohortMembers` are peer-id bytes (`bytesToPeerIdString` converts), the seam answers peer-id strings. Comparing sets is equivalent to comparing `cohortEpoch`, since the epoch is `H(sorted base64url members)` (`cohortEpochOf` in `packages/db-p2p/src/cohort-topic/host.ts`), and it needs no hash in the watch service.

**Only a registration at the root is checked.** A handle with `treeTier ≥ 1` sits at `coord_d(P, topicId)`, which is not the root group, so its member set is legitimately different; skip it. A handle with no `rootKey` is skipped too.

**Arm 1 — right after a registration lands (the one that fixes the reported symptom).** `moveThenRecheck` already re-reads the tail after a registration lands, for exactly the analogous reason (a commit announced while the walk was in flight). Add the group check on the same path: when a register has landed at the root, read the group fresh and, if the handle's members differ, register again at once. This turns the deaf window into roughly one extra walk rather than one tick, which matters because a caller's push assertion is routinely shorter than the 30 s tick.

**Arm 2 — on each watch tick.** The tick already holds every subscription and runs at the renewal cadence. For each subscription with a live root registration, compare and re-register on a mismatch. This is what covers a group that becomes wrong *later* (real churn), and it is the backstop if arm 1's check happens to run during the same bad instant that produced the registration.

**Do not storm the cohort.** A cohort allows one peer four register frames per topic per minute and a walk on a new root sends two, so an unconditional re-register per tick plus arm 1 can exhaust the allowance. Constrain it:

- At most one re-registration attempt per detection — never a retry loop inside one tick.
- Require the mismatch to be seen **twice in a row** before arm 2 acts. This is deliberate and load-bearing: a one-reading mismatch is exactly the shape of the momentary misclassification described above, and a mismatch that is real persists. Arm 1 is the fast path, so this costs nothing in the reported case.
- A re-registration that fails is left to the next tick, as a failed first attach already is (see the accepted-tradeoff NOTE in `moveTo`).

**Observability.** Log a re-registration with the collection, the old member set and the new one. This condition is otherwise silent — `isAttached` reports a misplaced registration as attached — and the log line is what lets the next report be diagnosed from a run rather than a probe build.

## The test

One test, in `packages/db-p2p/test/reactivity/collection-watch.spec.ts`, which already has the fakes for this: `HeldRegistrationService` (every `register` stays pending until the test settles it, and the resolved handle's fields are the test's to choose) and `tailReader`.

The behaviour to pin: **a live root registration whose member set no longer matches a fresh root-group read is registered again, and one whose member set still matches is not.** Land the first registration with `cohortMembers` set to one group, have the injected `rootGroupMembers` seam answer a different group, drive the ticks, and assert a second `register` under the same root key; then the matching case, and assert no second `register`. That is the reproduction of the defect at the lowest layer that shows it — the early return at `subscription-manager.ts:397` is what makes it fail today — and it pins the two-consecutive-readings rule at the same time.

No integration test. The originating ticket's repro is a three-machine real-socket scenario in Sereus whose failure rate is roughly one run in six; reproducing that here would cost several minutes per attempt for a signal this unit test gives deterministically, and `packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts` already covers the happy push path end to end (its own comment explains that it waits for the registration to replicate to the announcing member, which is the crutch the Sereus scenario does not have).

## Tripwires to record while in these files

Two concerns that are fine as they stand and only become work if a condition trips. Record them as `NOTE:` comments at the sites, not as tickets:

- At `directSubscribers` in `packages/db-p2p/src/libp2p-node-base.ts` (around line 2297): an announcing member sees only the registrations its own registry holds, so for up to one gossip round (5 s) after a registration is admitted, a commit announced by a *different* member of the same group reaches nobody. Harmless today — the watcher's first keep-alive ping is 30 s away and gossip has long since converged — but it is why a test that pushes immediately after a watch attaches has to wait for replication. If that window ever matters, the announcer must ask the group rather than only itself.
- At the existing accepted-tradeoff NOTE in `packages/db-p2p/src/cohort-topic/host.ts:2573`: say that its revisit condition — a stale primary for a root-placed topic — was seen (this ticket), and that it was answered on the participant side by re-registering rather than by closing an engine whose refresh drops self. Closing the engine would be correct in principle but needs a handoff path for the records it holds, and with the participant repairing itself in one round-trip it buys nothing.

## TODO

- Add `rootGroupMembers?: (rootKey: Uint8Array) => Promise<readonly string[]>` to `ReactivityCollectionWatchOptions`, documented as a **live** read of the rule (no snapshot cache), optional and inert when absent.
- Bind it in `packages/db-p2p/src/libp2p-node-base.ts` where `reactivityWatch` is constructed, to `keyNetwork.servingCohortAt(reactivityRootCoord(rootKey))` via the existing `rootGroupAt`.
- Add the order-independent member-set comparison helper (handle `cohortMembers` bytes → peer-id strings via `bytesToPeerIdString`), skipping handles with `treeTier ≥ 1` or no `rootKey`.
- Give `ReactivitySubscriptionManager` the way to register again at an unchanged root key — `followTail`'s early return must stay (it is right for its own question), so expose a separate call rather than widening it.
- Arm 1: on the `moveThenRecheck` path, after a registration lands at the root, read the group fresh and re-register at once on a mismatch.
- Arm 2: in `tick`, compare per subscription and re-register when the mismatch is the second consecutive reading; track that count per subscription beside `ticksSinceVerified`.
- Cap it: one attempt per detection, failures left to the next tick.
- Log each re-registration with the collection id and both member sets.
- Write the one unit test described above in `packages/db-p2p/test/reactivity/collection-watch.spec.ts`.
- Add the two `NOTE:` tripwires above.
- Update `docs/reactivity.md` §The node's watch service: the attach bullet gains the post-landing group check, the tick bullet gains the per-tick one, and "How long a missed commit can go unseen" gains the case this closes — a registration admitted by a machine outside the group, previously bounded by the ≈90 s renewal failover and now by one round-trip.
- Run only what this touches: `yarn workspace @optimystic/db-p2p test -- --grep "collection watch"` (adjust the pattern to the spec's `describe`). No full package suite, no `test:integration`.
