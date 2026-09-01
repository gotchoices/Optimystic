description: Before a machine co-signs a write, it checks that the group of peers claiming to handle that write really is the right group — but the sender picks which piece of data that check runs against, and if the sender leaves that choice out or points it somewhere unrelated, the machine quietly runs a weaker check instead of refusing. Make it refuse.
files: packages/db-p2p/src/cluster/cluster-repo.ts (deriveExpectedClusterView ~1193, admitMembership ~1064, ExpectedClusterView / DeriveExpectedClusterCallback ~120-140), packages/db-p2p/test/cluster-membership-admission.spec.ts, packages/db-p2p/test/mesh-partition-admission.spec.ts (must stay green untouched), docs/correctness.md (Theorem 2 body ~line 116 and status note ~line 126)
difficulty: medium

# An unusable coordinating block is inadmissible, not merely unconfident

## What this changes, in one paragraph

A cluster member that can independently look up a block's responsible peer set currently gets
`undefined` back from `deriveExpectedClusterView` in four different situations and cannot tell them
apart. Two of those are the member's own limitation (no lookup capability wired; the lookup failed
or came back empty / low-confidence). Two are properties of the record the **sender** built (it named
no coordinating block; it named a block its own operations never touch). All four take the same
lenient fallback, so a dishonest coordinator chooses which check every member runs just by how it
fills one field. This ticket splits the four apart at the type level and makes the two
sender-chosen ones a hard reject.

## Verification done during planning (do not redo)

Every production record that reaches `ClusterMember.update` carries a coordinating block id that is
bound to the record's own operations:

- `ClusterCoordinator.executeClusterTransaction` (`repo/cluster-coordinator.ts` ~line 293) stamps
  `coordinatingBlockIds: [blockId]` onto a copy of the message when the message has none. It has
  exactly three production callers, all in `repo/coordinator-repo.ts`:
  - `commit` (~1637) passes `request.blockIds[0]`; `getAffectedBlockIds` for a commit operation is
    `operation.commit.blockIds` — bound.
  - `cancel` (~1605) passes a member of `actionRef.blockIds`; affected ids for a cancel operation are
    `operation.cancel.actionRef.blockIds` — bound.
  - `pend` (~1369) passes `coordinatingBlockIds[0]`, which is either the caller-supplied batch list or
    `blockIdsForTransforms(request.transforms)`. The caller-supplied list comes from
    `NetworkTransactor.consolidateCoordinators` (`db-core/src/transactor/network-transactor.ts` ~line
    496), whose `consolidatedBlocks` are a subset of `blockIdsForTransforms(blockAction.transforms)`
    and whose batch payload is built by merging exactly those blocks' transforms — so each of them
    appears in `blockIdsForTransforms(batch.payload)`. Bound.
  - Retry batches from `processBatches` / `makeBatchesByPeer`
    (`db-core/src/utility/batch-coordinator.ts`) do **not** set `coordinatingBlockIds` at all, so
    `CoordinatorRepo.pend` falls through to `allBlockIds` from the retry payload. Bound.
- Reads never take the cluster-consensus path (no `executeClusterTransaction` caller for `get`).
- The `invalidate` operation shape has no production sender (the dispute service is off by default
  and builds no `ClusterRecord`).
- The only other `ClusterRecord` literal in `src/` is `testing/reactivity-mesh-harness.ts` ~line 703,
  which is fed to `buildCommitCert`, never to `member.update` — unaffected.
- Every `deriveExpectedCluster`-wired test path is either the mesh harness
  (`src/testing/mesh-harness.ts` ~line 372, always wired, always driving records through the
  coordinator choke point) or `test/cluster-membership-admission.spec.ts`. Specs that hand-craft
  records and call `member.update` directly (`byzantine-fault-injection.spec.ts`,
  `cluster-membership-binding.spec.ts`, the `cluster-coordinator*.spec.ts` family) construct their
  members with no `deriveExpectedCluster`, so they take the unchanged no-capability path.

So the hard reject cannot refuse an honest record. Nothing legitimate loses its coordinating block.

## Decisions already settled (do not re-litigate)

- **No rolling-upgrade gate.** `ClusterMember.validateRecord` already throws on a `membershipVersion`
  it does not implement, and its comment states the cluster consensus code is one deployable unit
  that upgrades together. A peer old enough to omit the field is on the pre-choke-point build of that
  same unit. Put that reasoning in the code comment so a later reader does not re-ask.
- **Reject vote, not a throw.** Stay on `admitMembership`'s `{ admit: false, reason }` contract, so
  the member emits a signed `reject` carrying `membership-not-admitted:<variant>` and dispute
  accounting keeps working. Do not move this into `validateRecord`.
- **`allowUnvalidatedSmallCluster` still bypasses.** It is the documented single-node / local-dev
  escape hatch and already bypasses the far stronger confident predicates; making a weaker
  record-shape check the one thing it cannot bypass would be incoherent. Only self-membership stays
  above it. Say so in the comment at the opt-in.
- **Receiver-fault stays lenient.** A bound coordinating block whose lookup threw, returned an empty
  peer set, or returned confidence at or below the threshold keeps today's
  fail-closed-against-`assumedClusterSize` behaviour. That is the partition posture; changing it
  would make a transient routing hiccup refuse every write.
- **No-capability stays legacy.** A member with no `deriveExpectedCluster` wired must never reach the
  new refusal — it has nothing to check against. The capability check therefore stays first, before
  the field is even read.

## The shape

Replace `ExpectedClusterView | undefined` with a tagged union, module-internal (not exported —
nothing outside `cluster-repo.ts` consumes it; `ExpectedClusterView` itself stays exported and
unchanged):

```ts
/**
 * Why a member does or does not have its own view of a record's cohort. The whole point of the
 * union is that the caller MUST distinguish a fault of the RECEIVER (nothing to check against —
 * stay lenient) from a fault of the SENDER (a record no current coordinator would build — refuse),
 * a distinction a bare `undefined` erased and let a coordinator exploit.
 */
type ClusterViewDerivation =
	/** The member resolved a view. Confidence / emptiness is judged by the caller, not here. */
	| { kind: 'view'; view: ExpectedClusterView }
	/** No `deriveExpectedCluster` wired (no FRET, unit tests): nothing to check against. */
	| { kind: 'no-capability' }
	/** A usable block was named but the lookup itself failed. Receiver fault. */
	| { kind: 'underivable'; error: string }
	/** The record names no block this member can legitimately derive from. Sender fault. */
	| { kind: 'unusable-record'; variant: 'no-coordinating-block' }
	| { kind: 'unusable-record'; variant: 'unbound-coordinating-block'; blockId: string; affected: number };
```

`deriveExpectedClusterView` returns this; it does **not** move the confidence threshold or the
empty-view check inside — those stay in `admitMembership`, which owns
`MembershipConfidenceThreshold` and the numbers its reject reason prints.

`admitMembership` then reads:

1. self-membership (unchanged, always enforced);
2. `allowUnvalidatedSmallCluster` → admit (unchanged);
3. derive, then switch:
   - `unusable-record` → **reject** (new);
   - `view` with `confidence > MembershipConfidenceThreshold` and non-empty peers → the three
     confident predicates (unchanged);
   - `view` that is empty or unconfident, `underivable`, `no-capability` → today's
     `assumedClusterSize` fallback, including the legacy unconditional admit when no size is
     asserted (unchanged).

Write the switch so a future `kind` cannot silently join the lenient bucket — an explicit `case` per
kind with a `never`-typed exhaustiveness default, not an `if (unusable) … else …`.

## Reason strings and log tags

Both keep the `MEMBERSHIP_NOT_ADMITTED` prefix (the note at `cluster-repo.ts` ~line 1130 warns that
anything grouping dispute reasons must group on `membership-not-admitted:<variant>`):

- `membership-not-admitted:no-coordinating-block` — nothing to name.
- `membership-not-admitted:unbound-coordinating-block (blockId=<named id>, affected=<count>)` —
  follows the existing convention of naming what caused the refusal. Print the **count** of affected
  block ids, not the list: this string is signed into the vote and lands in dispute records, and a
  wide multi-block pend would otherwise produce an unbounded reason.

Logs:

- keep `cluster-member:coordinating-block-unbound` (with `messageHash`, `coordinatingBlockId`) — an
  existing test asserts on the tag; only its surrounding comment changes, from "falls back" to
  "refuses";
- add `cluster-member:coordinating-block-absent` (with `messageHash`) for the other variant;
- and emit the usual `cluster-member:admission-reject` with
  `reason: 'no-coordinating-block' | 'unbound-coordinating-block'` alongside, so
  `mesh-partition-admission.spec.ts`'s `admissionRejectReasons` helper and any operator grouping on
  that one tag see these refusals like every other.

## Edge cases & interactions

- **`coordinatingBlockIds: []`** — present but empty. `?.[0]` is `undefined`, so it must take the
  `no-coordinating-block` branch, same as an absent field. This is a distinct wire shape and the
  coordinator's choke point tests on `.length` precisely because of it; pin it with its own test.
- **Multi-entry `coordinatingBlockIds`** (pend declares the whole consolidated batch): only `[0]` is
  read, unchanged. If there is no comment saying so at the read site, add a one-line `NOTE:` — a
  reader will otherwise wonder whether the other entries are checked.
- **Empty `operations`** — `getAffectedBlockIds` returns `[]`, so any named block is unbound and the
  record is refused. That is correct (a record with no operations is malformed) but should be stated
  in the comment, since `affected=0` in the reason string will look surprising in a log.
- **Self-membership still wins.** A record that both omits this member and omits the coordinating
  block must still report `self-not-member` — do not reorder the predicates.
- **The opt-in still wins over the new refusal.** `allowUnvalidatedSmallCluster: true` plus an absent
  field must approve.
- **Redelivery / relay.** A member that receives the same record twice, or forwards one, reads the
  same hash-covered field; no new state, no ordering hazard. Nothing to do, but confirm no other call
  site of `deriveExpectedClusterView` appears (there is exactly one today, `cluster-repo.ts` ~1081).
- **Dispute accounting.** The two new variants flow into `disputeEvidence.rejectReasons`. Nothing in
  `src/` switches on a specific variant string (checked), so no consumer needs updating — but keep
  the prefix intact.
- **Coordinator-side blast radius.** A member refusing where it used to approve means the coordinator
  now fails the transaction outright instead of assembling a super-majority. That is intended for a
  malformed record; the verification section above is why it cannot happen to a well-formed one.

## Tests

`packages/db-p2p/test/cluster-membership-admission.spec.ts` has the harness; it needs two small
extensions:

- `makeRecord` / `voteOn` must be able to express *absent* and *empty* as well as *some id*. Replace
  the `coordinatingBlockId?: string` parameter with `coordinatingBlockIds?: string[] | 'omit'`,
  defaulting to `[blockId]`, and build the message without the field when `'omit'`. Update the two
  existing call sites.
- `voteOn`'s `view` parameter should also accept a `DeriveExpectedClusterCallback`, passed through
  as-is, so a *throwing* capability can be exercised (today it only accepts a constant view or
  `undefined`).

Cases, in a describe renamed to cover presence as well as binding:

- **control, unchanged** — shrunken `D` (3), confident derived view over the same 3, bound
  coordinating block, `assumedClusterSize: 8` → `approve`. This is the "defeated-shaped" case: a
  legitimate small cohort looks exactly like an attack, which is why the record-shape checks have to
  carry the weight.
- **changed** — same record with `'block-the-operations-never-name'` → now `reject` with
  `membership-not-admitted:unbound-coordinating-block (blockId=block-the-operations-never-name, affected=1)`,
  where today it is `low-confidence-downsize (declared=3, floor=6, assumedClusterSize=8)`. Still logs
  `cluster-member:coordinating-block-unbound`.
- **new** — the same unbound record with **no** `assumedClusterSize` configured → `reject`, same
  variant. Today this is admitted unconditionally; this is the half of the unbound case that was only
  nominally closed.
- **new** — field omitted, `assumedClusterSize: 8` → `reject` with
  `membership-not-admitted:no-coordinating-block`, and logs
  `cluster-member:coordinating-block-absent`. Today: judged against the floor.
- **new, the headline** — field omitted **and** no `assumedClusterSize` → `reject`. Today: admitted
  unconditionally. This is the case that shows the fix is about the sender's free choice and not
  about the floor's value.
- **new** — `coordinatingBlockIds: []` → `reject` with `no-coordinating-block`.
- **new** — field omitted but `D` is the **full** set and the derived view is confident and identical
  → still `reject`. The refusal is about the record's shape, not its size; a full-size declared set
  does not excuse a record no current coordinator would build.
- **new, legacy intact** — no derivation capability and field omitted, with no `assumedClusterSize`
  → `approve`; and with `assumedClusterSize: 8` and a shrunken `D` → the existing
  `low-confidence-downsize` reject. The new refusal must not fire on a member that has nothing to
  check against.
- **new, receiver fault stays lenient** — a derivation callback that *throws*, on a **bound** block:
  with `assumedClusterSize: 8` and shrunken `D` → `low-confidence-downsize`; with no asserted size →
  `approve`. Same fallback as before, proving only the sender-fault bucket moved.
- **new, opt-in** — `allowUnvalidatedSmallCluster: true` with the field omitted → `approve`.

`packages/db-p2p/test/mesh-partition-admission.spec.ts` pins Theorem 2 end-to-end and must keep
passing **with no edits**. All of its fallback-floor cases are confidence collapse (receiver fault)
and its hand-crafted record (`craftRecord`, ~line 188) already carries a bound coordinating block. If
that spec needs changing, the change reached further than intended — stop and re-read the
verification section above rather than editing the spec.

Run the whole `db-p2p` package suite, not just these two files: the mesh harness wires
`deriveExpectedCluster` on every node, so any mesh spec is a live check on the "no honest record
loses its block" claim.

## Docs

`docs/correctness.md`:

- **Theorem 2 body (~line 116)** — "it must be one the record's own operations name, or the member
  declines to derive at all" now understates it: the member *refuses to vote*. Rewrite that clause,
  and add that a record naming no coordinating block at all is likewise inadmissible on any member
  that can derive.
- **Status note (~line 126)** — the sentence listing two residual limits must drop the first one ("a
  coordinator that omits the field altogether is still judged against `assumedClusterSize`") along
  with its `tickets/backlog/debt-absent-coordinating-block-downgrades-the-admission-gate.md` link,
  and the earlier clause "an unbound id logs `cluster-member:coordinating-block-unbound` and falls
  back to the low-confidence floor" must become a refusal. State the new three-way split plainly:
  sender-chosen defect ⇒ inadmissible; receiver-side inability ⇒ the `assumedClusterSize` fallback;
  no capability ⇒ legacy. The **second** residual limit (a minority whose size estimate does not
  collapse measures its own small cohort confidently and admits) stays exactly as written.
- Lines ~462 and ~471 describe the low-confidence floor and are unchanged — leave them.

Also refresh the prose in `cluster-repo.ts` that the change falsifies: the
`DeriveExpectedClusterCallback` doc (~line 131), the `admitMembership` "Fail-closed posture"
paragraph (~line 1050), the `deriveExpectedClusterView` doc listing the four `undefined` causes
(~line 1186), and the `getAffectedBlockIds` doc (~line 2284) if it describes the binding check as a
fallback.

## TODO

- Add the `ClusterViewDerivation` union next to `ExpectedClusterView` in
  `packages/db-p2p/src/cluster/cluster-repo.ts` and change `deriveExpectedClusterView` to return it;
  keep the capability check first so a no-capability member never reports a sender fault.
- Rewrite the `admitMembership` branch as an exhaustive switch over the union: `unusable-record` →
  reject with the two new reason variants; everything else keeps today's behaviour exactly.
- Emit `cluster-member:coordinating-block-absent` for the new variant, keep
  `cluster-member:coordinating-block-unbound` for the other, and emit
  `cluster-member:admission-reject` for both.
- Record the settled decisions as comments at their sites: why no version gate is needed, why the
  opt-in still bypasses, why receiver faults stay lenient, and (if absent) a `NOTE:` that only
  `coordinatingBlockIds[0]` is read.
- Extend the admission spec harness (`coordinatingBlockIds?: string[] | 'omit'`; `view` may be a
  callback) and update the two existing call sites.
- Add the test cases above; update the two existing assertions that change verdict.
- Update `docs/correctness.md` Theorem 2 body and status note, and the falsified JSDoc in
  `cluster-repo.ts`.
- Build and run the full `db-p2p` suite in the foreground; `mesh-partition-admission.spec.ts` must
  pass untouched.
