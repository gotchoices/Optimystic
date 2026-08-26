----
description: One part of the system refuses to accept a copy of data unless two machines vouch for it, and pays a heavy price for that caution — some data becomes permanently unreadable. Right next to it, another part accepts data pushed by any machine at all, with no vouching, which is enough to defeat the first part. Someone needs to decide which of the two describes the security we actually intend.
prereq:
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/block-transfer-push-persist.spec.ts, docs/internals.md
----

# Two subsystems, two incompatible threat models — which one is the intended one?

Raised by `fix/single-holder-block-is-permanently-unreadable` (upstream
[gotchoices/Optimystic#15](https://github.com/gotchoices/Optimystic/issues/15)). This is here because
it is a judgement about what we are defending against, not a defect with a determined fix. **It gates
nothing** — both implement tickets from that investigation
(`name-the-single-holder-deadlock`, `replicate-owned-blocks-when-the-cohort-grows`) are correct
whichever way this goes.

## The two positions, as the code currently states them

**Position A — a peer's word is not enough.** `cluster/quorum-restore.ts` opens by saying both block
restoration paths "previously trusted a single peer's self-reported latest, so one lying peer could
steer restoration", and replaces that with "highest value corroborated by a quorum of distinct
peers". The floor is two. `corroboratorCapacity` takes a deliberate `max()` so a shrunken or
attacker-influenced view of the peer set cannot talk that floor down.

**Position B — anyone may hand us data.** `docs/internals.md:859` states plainly that the four
database protocols go "straight from inbound stream opened to decode and execute the operation. Any
peer that can open a connection can therefore issue database operations," and offers
`authorizeInboundStream` as the seam for an embedder whose database is private. Absent that option,
every service builds its gate as `undefined` (`libp2p-node-base.ts:443`) — the default.

## Why they cannot both be right

`BlockTransferService.handlePush` (`block-transfer-service.ts:199`) accepts a pushed block from any
peer, validates only that the payload parses and has a `header`, and persists it via
`saveReplicatedBlock` using the **pusher's own** rev and action id. `saveReplicatedBlock` advances the
node's `latest`, and `latest` is exactly what that node reports when a reader asks it what it holds.

So a peer that can dial two cohort members can make both of them into honest-looking corroborators
for content nobody ever committed, and Position A's floor of two is satisfied by construction.

**Measured, not inferred.** Pushed forged content into two nodes through `handlePush`, then had a
third node read the block through a real `CoordinatorRepo` with the strict default
(`repairCorroborationClusterSize: 10`, floor of two, no relaxation in play):

```
push accepted: [ 'single-holder-block' ]  missing: []
push accepted: [ 'single-holder-block' ]  missing: []
reader served payload: FORGED  rev: 7
reader now HOLDS payload: FORGED  rev: 7
```

The reader served the forged content, persisted it, and thereby became a third corroborator. The
acceptance half of this is already pinned green in the repo by
`test/block-transfer-push-persist.spec.ts:48` and `:65` — it is working as designed, for the design in
Position B.

## What it costs to keep both

Position A is not free. Because it counts *voters* and a block can have only one holder, a block
written while a deployment was a single machine can never gain a second holder and can never be read
by anyone else — permanently, at any deployment size, with no configuration that expresses the
problem. That is the reproduced defect in the originating ticket, and it strands exactly the founding
records every later joiner must read.

So today we pay permanent unreadability of a deployment's earliest data for a guarantee that any peer
able to open two connections can bypass.

## The decision

Roughly, the options:

1. **Position B is the intended posture** (public, open database; authentication is the embedder's
   job via `authorizeInboundStream`). Then the corroboration floor is defending against a weaker
   adversary than its own doc comment claims — an honest-but-lagging or accidentally-wrong peer, not a
   liar — and it should be re-justified on that basis and priced accordingly. That likely makes a
   narrower relaxation acceptable, and would change how `backlog/debt-read-repair-commit-cert-verification`
   is prioritised.
2. **Position A is the intended posture.** Then the push path is a hole that has to close — pushes
   need cohort-membership and provenance checks — and that work is a prerequisite for the floor
   meaning anything. It also very likely reduces to the same commit-certificate machinery.
3. **Deliberately keep both, with the contradiction written down.** Defensible if the floor is
   understood as guarding a *different* failure mode from the push path. If so, say which one, at both
   sites, as accepted-tradeoff `NOTE:` comments — so the next reader does not re-derive this from
   scratch, as this investigation had to.

What a decision needs to state: which adversary the block-restoration corroboration floor is for; and
whether an unauthenticated `handlePush` is intended in the default configuration or is a gap to close.

## Explicitly not being asked

Not asking anyone to relax `corroboratorCapacity` here — the fix-stage investigation rejected the
obvious relaxation on its own merits (it is strictly weaker than today's rule and self-amplifying;
see `implement/replicate-owned-blocks-when-the-cohort-grows` for the measured reasoning), and that
holds regardless of how this question is answered.
