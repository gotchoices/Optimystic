description: A storage node that has filled the space its operator gave it now says no instead of accepting data until its disk fails a write — to replicas other machines push at it, to large files other machines offer it, and to writes from the program on the same machine.
architecture: packages/db-p2p/docs/storage.md, docs/blobs.md#placement-copying-and-durability
files: packages/db-p2p/src/storage/storage-pressure.ts, packages/db-p2p/src/blob/local-blob-service.ts, packages/db-p2p/src/blob/announce-receiver.ts, packages/db-p2p/src/blob/blob-protocol.ts, packages/db-p2p/src/blob/cohort-reaction.ts, packages/db-p2p/src/blob/blob-copy-drain.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/src/repo/under-replication-drain.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/local-blob-service.spec.ts, packages/db-p2p/test/block-transfer.spec.ts, packages/db-p2p/test/blob-announce-receiver.spec.ts, packages/db-p2p/docs/storage.md, docs/blobs.md
----

# A full node refuses new data

A node that has reached the space its operator gave it now refuses, rather than accepting data until the disk itself fails a write. Four paths refuse, all reading the one storage-pressure sample the previous ticket (`a-node-names-how-full-it-is`) built, never a fresh disk scan.

## What the node does now

**A replica another machine pushes at it.** `BlockTransferResponse` carries `outOfSpace?: true` — a property of the receiver, so it rides once per response rather than per block. `BlockTransferService.handlePush` refuses as its first statement, ahead of the structural check and ahead of every signature it would otherwise verify, answering every requested block id `missing` plus `outOfSpace`. A sender on an older build reads that answer exactly as it reads one today, so the field is additive on the wire.

**A blob another machine announces to it.** The announce protocol gained the answer `out-of-space`, refused after the membership, cohort and allowance checks and before the reference read — that read is the expensive part of answering an announcement, and a node that will not take the blob should not spend a read slot proving it is referenced. The answer is deliberately not one of the answers that satisfy the growth arm: `declined` is a permanent fact about a configuration, being full is a condition that clears, and a satisfied peer enters the rebalance monitor's seen set, which only a departure from the cohort clears. The release arm is untouched, on purpose: a full candidate stays in both halves of the release count, so a node never drops a hold because its neighbours are full.

**The program on the same machine.** `LocalBlobService.put` and `.pin` throw `NodeOutOfSpaceError` (exported from `@optimystic/db-p2p`, carrying the measured use and the effective total), and `put` refuses before the first piece is written, so a refused put leaves no pieces behind and no sweep to run. This limit is a *different*, later one — the whole allotment rather than the lower threshold the inbound doors use: a node's own writes are the work it exists to do, and the replicas and blobs it holds for the network are the giveable part.

**A blob its own read brought here.** Reader repair — the path that keeps a blob under a `responsible` hold after the host read it — reads the same answer as the announcement door. Added during this review; see the findings below.

A node that cannot measure its own storage refuses none of this, and neither does one whose free-space read failed on a single scan: the last successful sample's stage and capacity are both kept across a fault. Nothing on a read path is gated, nor is a pull already in flight, nor applying a commit whose pend was approved (that refusal is `a-full-cohort-member-refuses-a-pend`'s).

The implementation landed in `ticket(implement): a-full-node-refuses-new-data`; this review's fixes are in the commit that carries this ticket.

## Review findings

Read the implement diff first, then the handoff. Lint, the full `db-p2p` suite, the full `quereus-plugin-optimystic` suite, `db-p2p` integration, the doc-citation and dependency checks, and the React Native bundle check all pass — see *Verification*.

### Fixed in this pass

**Two of the four push senders misreported a full peer as unreachable.** `PushRefusal.reason` gained a third value, and `block-transfer.ts` learned to log it — but `SpreadOnChurnMonitor` and `UnderReplicationDrain` both discriminate on the same field with a catch-all `else` that prints the dial-failure line. An out-of-space refusal therefore logged as `push:fail … err=undefined` and `push:unreachable … err=undefined` on those two paths: a full peer presented as an unreachable one, which is the exact confusion the implement pass added its new log line to prevent. Behaviour was already right at both sites (the drain counts it under its give-up rule, which is what an unreachable peer gets and what the blob side does). Both now have an explicit arm, and all three senders close with `const exhaustive: never = refusal.reason`, so the next reason added to the type is a compile error at each site rather than a wrong log line. `tickets/backlog/debt-three-sites-repeat-the-certified-push-loop.md` already records the per-site log lines as its accepted tradeoff and is waiting on a human; this fix is compatible with either way that decision goes.

**Reader repair still took a new `responsible` hold on a full node.** `BlobAnnounceReceiver.keepAfterRead` is the other path that turns a blob into one the node keeps for the network, and the implement pass gated only the announcement path — so a full node refused the blob when a peer offered it and then took the very same hold because the host happened to read it. It is also the one path that makes a full node fuller without writing a byte: the bytes are already here under the fetch's `cached` hold, and the `responsible` hold moves them out of the reach of the read-cache enforcement the same `refusing` sample triggers, so a full node reading many blobs would convert each one into something it can no longer free. It now reads the same answer at the same point in its sequence (before the reference read), the `cached` hold is left exactly as it is so the blob is still served and still evictable, and `docs/blobs.md` §Readers repair and the storage document's door table say so. An announcement-driven pull is unaffected: its hold was already taken before the pull started, so the repair returns earlier than the new guard.

**The push refusal was not actually the handler's first statement,** as its own comment and the handoff claimed — three locals were allocated above it. Hoisted; no behaviour change.

### Found and deliberately left

Nothing in the categories below needed a ticket; the filing bar was not reached by anything that survived checking.

- **A full node still accepts a block through read repair and restore** (`cluster/reconcile-block.ts`, `RestorationCoordinator`). Left as it is, and not a gap in what the documents claim: a node fetching a block it is *responsible for* so it can answer reads is not being offered new work, and refusing would leave it unable to serve a range it has already been assigned. Neither document claims otherwise.
- **The handler does not report the pushing peer as a holder when it refuses.** Consistent with every other early return in that handler (a request with no blocks does the same), and the information is re-learned on the sender's next pass.
- **`unresolvedProofs` is omitted from an out-of-space answer** while the general rule is that an answer without that field counts as unresolved. Checked both halves: the sender returns on `outOfSpace` before it reads the field, so the rule is never reached and the peer's proof memory is left untouched. In step.
- **The `all-full` short-circuit's `every()` over an empty candidate list** would be vacuously true, but an empty list returns two guards earlier. Unreachable.
- **The pass-scoped full-peer set is read after a block's push returns,** so it includes peers a concurrent block found full. Deliberate and documented at the site — one pass, one verdict per peer.

### Recorded as a tripwire

**A grown block whose replication floor was met still spends its growth attempts when any new peer was full.** Checked before the floor on purpose (recording a full peer satisfied would mean never offering it the block again), so a cohort carrying a few permanently full members re-checks every such block until its attempt bound runs out. Bounded and cheap today — one push round per attempt, and nothing is released off the unconfirmed list. Parked as a `NOTE:` on that branch in `packages/db-p2p/src/cluster/block-transfer.ts` with the remedy if it is ever seen: report the block complete once the floor is met and carry the full peers as a separate offer-again list.

The staleness tripwire the previous ticket left on the pressure reading still covers all three synchronous answers unchanged — they read one sample, so a node can accept up to one sampling interval's data past its limit.

### Tests

The implementer's one spec — a refused `put` writes no piece, writes no record, and never pulls the source — pins the part that is easy to get wrong and invisible when it is. Kept as written. Two added, both for things found above:

- **A grown block whose new peer is out of space is incomplete even when the floor was met** (`test/block-transfer.spec.ts`). The implementer flagged this branch as the one piece of the change with real branching and no coverage, and it is the only place the ordering rule is observable: the floor is reached and the block is still reported incomplete, with only the confirming peer satisfied. Removing the branch fails all three assertions.
- **Reader repair takes no hold on a node with no room** (`test/blob-announce-receiver.spec.ts`), the defect fixed above, with the node-with-room case as its own control so the test cannot pass by the repair silently not running.

Nothing else added. The push and announce refusals are each one guard reading one predicate and returning a value; the satisfying-answers list is a constant; the senders' handling is reporting; and the exhaustiveness guards are checked by the compiler.

## Verification

- `yarn lint`, `yarn lint:docs` (49 documents, all citations resolve), `yarn lint:deps`, `yarn check:rn` — all clean.
- `yarn workspace @optimystic/db-p2p build` — clean.
- `yarn workspace @optimystic/db-p2p test` — 3916 passing, 84 pending, 0 failing.
- `yarn workspace @optimystic/db-p2p test:integration` — 60 passing, 2 pending, 0 failing.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — 1458 passing, 16 pending, 0 failing, smoke ok.

No pre-existing failures surfaced.
