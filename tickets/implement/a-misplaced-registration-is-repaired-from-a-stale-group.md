description: When a machine notices it was registered to watch a table with the wrong group of machines, it tries to fix this straight away — but the retry asks a cached list of machines that is the very list that was wrong, so it makes the same mistake again. Have the retry ask for the list fresh.
architecture: docs/reactivity.md#the-nodes-watch-service
files: packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/topic-router.ts, packages/db-p2p/src/reactivity/collection-watch.ts, packages/db-p2p/src/libp2p-node-base.ts, docs/cohort-topic.md, docs/reactivity.md, packages/db-p2p/test/cohort-topic/root-step-reads-the-group-live.spec.ts
repro: verified
difficulty: medium
----

# One site: the root step of a register walk reads the group through a cache

A machine that starts watching a table registers itself with the group of machines responsible for the table's log tail. Which machines those are is decided by one rule — the key network's storage rule at the tail's ring position, `servingCohortAt` in `packages/db-p2p/src/libp2p-key-network.ts`, which is deliberately uncached (its own NOTE there says why: a cache could only be bounded by a TTL, and a membership change would then go unseen).

Two parts of the register path read that rule through different paths:

- **The check that judges a placement** (`verifyRootGroup` in `packages/db-p2p/src/reactivity/collection-watch.ts`) reads it live. `ReactivityCollectionWatchOptions.rootGroupMembers` is bound on a node to `resolveReactivityCohort` in `packages/db-p2p/src/libp2p-node-base.ts`, which is `servingCohortAt` at the tail's root coordinate.
- **The walk that performs a placement** reads it through a cache. `createCohortTopicHost` in `packages/db-p2p/src/cohort-topic/host.ts` hands the router a `rootGroupMembers` backed by `RootGroupSnapshots.ensure`, whose maximum age is the gossip interval (`gossipIntervalMs`, 5 s by default). `FretTopicRouter.routeToRoot` in `packages/db-p2p/src/cohort-topic/topic-router.ts` dials that member list in order and takes the first reply.

So the repair walk is handed the very list the misplacement came from. The landing check runs milliseconds after the walk it is reacting to — always inside the snapshot's window, because that walk is what filled or refreshed the snapshot — so it dials the same machines in the same order and the same machine admits it again with the same view. What repairs the placement is the next mismatched reading, one watch tick later (30 s on Core).

## What was confirmed

The report arrived static; it is now observed. A three-node mesh over the in-process harness (`buildMesh` in `packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts`), one participant plus two single-machine root groups, two register walks at the same root key with the participant's `membersAt` answer changed in between: the second walk lands on the **first** walk's group. Changing the router's root step from `snapshots.ensure` to a fresh read makes the second walk land on the group the rule names now, and the existing suites stay green (`test/cohort-topic/{live-tier,service,topic-router,membership-source}.spec.ts` — 35 passing; `test/reactivity/*.spec.ts` — 184 passing). The spec source that reproduces it is below; it is the one test this ticket adds.

## The change

Add a third read mode to `RootGroupSnapshots` (`packages/db-p2p/src/cohort-topic/host.ts`) and bind the router's root step to it:

```ts
	/**
	 * A fresh read for a caller that must not be served a stale group — a register walk's root step, whose
	 * dialed member list is what the watch service's live mismatch check is judged against. Shares the one
	 * in-flight read per coord with `ensure` and `refresh`, and falls back to the held snapshot when the
	 * fresh read fails, so such a caller is never left worse off than `ensure` would have left it.
	 */
	live(coord: RingCoord): Promise<RootGroupSnapshot>;
```

Its body is the private `read(coord, key)` the other two share — so concurrent walks still coalesce onto one `membersAt`, and a successful read still replaces the held snapshot — with the held snapshot returned (and logged) when that read rejects, and the rejection rethrown when nothing is held. `ensure` and `refresh` keep their present meanings and their present callers: every synchronous cohort site (the engine's cohort view, its signers, the `/sign` endorser, the gossip targets) still reads the snapshot, and the gossip-cadence driver still owns `refresh`. The only call that moves is the router's:

```ts
			rootGroupMembers: (rootKey: Uint8Array): Promise<readonly string[]> =>
				rootGroup.snapshots.live(addressing.rootCoord(rootKey)).then((snapshot) => snapshot.memberStrs),
```

A register walk is rare — attach, tail rotation, repair — and `servingCohortAt` is a FRET ring read plus cached peerStore records, not a network round trip, so reading live on that path is a different trade from reading live in the synchronous paths the snapshot exists for. Keep the snapshot store, its max age, and its LRU bound exactly as they are.

## What this fixes, and what it does not

**Fixed.** A misplacement whose cause is *this node's* stale list is repaired by the landing check's own walk, not a tick later: the walk now dials exactly what the check read, so the repair can reach a different member set.

**Not fixed, and do not try to in this ticket.** The member set the check compares against is not this node's at all — it is the set the admitting member reported, which is that member's own engine view (`CohortMemberEngineDeps.cohort()`, refreshed on its gossip rounds, so up to one gossip interval old). A placement can therefore still be judged mismatched for a reason this node cannot influence, and a repair walk that correctly dials the live group reaches the same first member and gets the same report back. That case is self-clearing — within one gossip interval on the admitting member, then the next watch tick repairs it — so the bound there stays one tick. Record it as a `NOTE:` where the comparison is made (see the TODO list); do not file a ticket for it, and do not widen this one to the admission side.

Two shapes were weighed and rejected, so they do not need re-deriving:

- **Carry the dialed member list back on `RegistrationHandle` and compare against that** instead of against a second live read. Once the walk reads live, the two reads are the same rule milliseconds apart, so this buys only the removal of that millisecond window and one ring read per attach; the periodic tick must keep reading live regardless, to notice a group that moved under an already-correct registration. It needs a new field on a db-core port for that. Leave the existing NOTE at the comparison in `verifyRootGroup` as the recorded escape hatch — it already names this as what to do if ring views ever diverge persistently.
- **Re-read live on the admission side** (`prepareRootPlacedCoord` in `host.ts`, before refusing `not-member`). That read would sit on the inbound register path ahead of the anti-DoS gate, so a frame from any machine would cost a ring read and a membership classification of the whole over-fetch band. The amplification is bounded — the in-flight map coalesces to one read per coordinate — but it is an unmeasured trade on the hot path the snapshot exists for, and the window it closes is already bounded by one gossip interval.

## Documentation and comments to move with the code

Several comments and doc passages assert the broken behaviour as fact and name this ticket as the open work. Each must become the post-fix truth; none should be left naming a ticket that has landed.

- `packages/db-p2p/src/reactivity/collection-watch.ts` — the NOTE on the repair attempt in `verifyRootGroup` (the one beginning "this attempt is a fresh register walk"). The repair now dials the live group; what survives is the admitting-member residual above. The class-level sentence "That repair is bounded by a tick" near the top of the file and the `verifyRootGroup` doc comment's "landing on the same wrong members again is the ordinary case" both follow from the old behaviour and need re-reading in the same pass.
- `packages/db-p2p/src/libp2p-node-base.ts` — the NOTE at `rootGroupMembers: resolveReactivityCohort` in the watch-service wiring, which currently states that the detector and the repair read the group by two different rules.
- `packages/db-p2p/src/cohort-topic/host.ts` — the second NOTE on the root-placed engine ("that revisit condition has now been seen …"), which says the repair walk dials the same snapshot the misplaced walk did. Its actual revisit condition — whether to close a root-placed engine on a refresh that drops self — is unchanged and should stay.
- `packages/db-p2p/src/cohort-topic/topic-router.ts` — `FretTopicRouterOptions.rootGroupMembers`: the sentence "The host binds it to its root-group option, keyed by the coordinate `H(rootKey)`" should say the host binds it to a **live** read of that option, not to the held snapshot, and why.
- `docs/cohort-topic.md` §Root placement at a routing key, the *Implementation (db-p2p host)* block: "it resolves the group by `membersAt`" is true only through the snapshot today. Say that the root step reads `membersAt` fresh while every synchronous site reads the snapshot, and why the two differ.
- `docs/reactivity.md` §The node's watch service: the bullet "**The repair is bounded by a tick, not by a walk.**" is the claim this ticket removes — rewrite it (or fold it into the bullet above it) to state what the repair now reaches and what residual keeps a tick bound. The preceding bullet, "**Then check who actually holds it.**", cites the host snapshot as "one of the ways a registration lands outside its group in the first place"; after this change that is no longer a way the walk's own root step can land wrong, so the clause needs narrowing to the admitting member's view. Further down, §How long a missed commit can go unseen, the entry "**A registration a walk left outside the tail's root group:**" carries the same claim and must agree with the bullet.

## The test

One test, the reproduction, at the lowest layer that reproduces it: the host's root step over the in-process mesh. It is not a wiring assertion — it pins what §Root placement at a routing key says the root step resolves the group by. Nothing else in the suite covers a *second* walk at the same root key.

New file `packages/db-p2p/test/cohort-topic/root-step-reads-the-group-live.spec.ts`, verified failing before the change and passing after:

```ts
import { expect } from 'chai';
import { type Tier } from '@optimystic/db-core';
import { bytesToPeerIdString } from '../../src/cohort-topic/peer-codec.js';
import type { RootGroupOptions } from '../../src/cohort-topic/host.js';
import { buildMesh, makeMembers } from '../../src/testing/cohort-topic-mesh-harness.js';

const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i * 9 + 5) & 0xff);
const ROOT_KEY = new TextEncoder().encode('tail-block-id:root-placement');

describe('cohort-topic: the root step of a register walk reads the group live', () => {
	it('a second walk reaches the group the rule names now, not the one the first walk filled the snapshot with', async function () {
		this.timeout(20_000);
		const members = await makeMembers(3);
		const [g0, g1, participant] = members as [typeof members[0], typeof members[0], typeof members[0]];
		// The participant's view of the root group is what the walk's root step dials. It starts at [g0] and
		// moves to [g1]; each group member reads itself as the whole group, so whichever one a walk dials
		// admits and reports itself — making the reply name the group the walk actually reached.
		let participantView: readonly string[] = [g0.idStr];
		const mesh = await buildMesh(members, {
			wantK: 3,
			minSigs: 2,
			sizeEstimate: 16,
			rootGroup: (m): RootGroupOptions => ({
				quorumRatio: 0.75,
				membersAt: (): Promise<readonly string[]> =>
					Promise.resolve(m.idStr === participant.idStr ? participantView : [m.idStr]),
			}),
		});
		try {
			const svc = mesh.nodeOf(participant.idStr).host.service;
			const first = await svc.register({ topicId: TOPIC, tier: 0 as Tier, rootKey: ROOT_KEY });
			expect(first.cohortMembers.map(bytesToPeerIdString), 'the first walk lands on g0').to.deep.equal([g0.idStr]);

			participantView = [g1.idStr];
			const second = await svc.register({ topicId: TOPIC, tier: 0 as Tier, rootKey: ROOT_KEY });
			expect(second.cohortMembers.map(bytesToPeerIdString), 'the second walk lands on the group the rule names now').to.deep.equal([g1.idStr]);
		} finally {
			await mesh.stop();
		}
	});
});
```

The harness parks the gossip driver an hour out by default, so the snapshot's max age is an hour there and the staleness window is deterministic. In production that window is the 5 s gossip interval — still always open at the moment the repair walk runs, since the walk being repaired is what filled the snapshot.

The harness spec lives under `test/`, so run it from the package directory rather than through the workspace script (whose glob is fixed):

```
cd packages/db-p2p
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cohort-topic/root-step-reads-the-group-live.spec.ts" --reporter spec
```

## TODO

- Add `live(coord)` to `RootGroupSnapshots` and implement it in `createRootGroupSnapshots` (`packages/db-p2p/src/cohort-topic/host.ts`): the shared private `read`, with the held snapshot as the fallback when the fresh read rejects and the rejection rethrown when nothing is held. Document why this caller must not be served a stale group.
- Point the router's `rootGroupMembers` in `createCohortTopicHost` at `snapshots.live` instead of `snapshots.ensure`. Leave every other `ensure` / `refresh` caller alone.
- Add the reproduction spec above as `packages/db-p2p/test/cohort-topic/root-step-reads-the-group-live.spec.ts` and run it (command above).
- Add a `NOTE:` at the member-set comparison in `verifyRootGroup` (`packages/db-p2p/src/reactivity/collection-watch.ts`) recording the residual: the latched set is the admitting member's own engine view, up to one gossip interval old, so a mismatch this node cannot influence is still bounded by one watch tick. Keep the existing NOTE about persistently divergent ring views.
- Rewrite the comments and doc passages listed under *Documentation and comments to move with the code*, removing every mention of this ticket slug and every claim that the repair is bounded by a tick for the reason it no longer is.
- Re-run the suites that cover the touched paths: `test/cohort-topic/{live-tier,service,topic-router,membership-source}.spec.ts` and `test/reactivity/*.spec.ts` (both were green against this change). Per `tickets/rules/testing.md`, no full package suite here — that is the review stage's run.
- `yarn workspace @optimystic/db-p2p typecheck`.
