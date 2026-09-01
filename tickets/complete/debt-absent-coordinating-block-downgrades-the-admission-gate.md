description: A machine that co-signs a write now refuses outright when the sender's request fails to point at the data it claims to be about, instead of quietly running a weaker check the sender effectively chose.
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/cluster-membership-admission.spec.ts, docs/correctness.md

# Complete: an unusable coordinating block is inadmissible, not merely unconfident

## What landed

Before a cluster member signs an approve, it re-derives its own view of a block's responsible peer
set and checks the coordinator's declared set against it. That derivation used to return a bare
`ExpectedClusterView | undefined`, and four situations produced the same `undefined`, all falling
into one lenient fallback. Two of the four are properties of the record the *sender* built, so a
dishonest coordinator could pick which check every member ran just by how it filled
`coordinatingBlockIds`.

The four are now a tagged union, `ClusterViewDerivation` (module-internal, `cluster-repo.ts`), and
`admitMembership` switches on it exhaustively:

| kind | cause | verdict |
|---|---|---|
| `view` | lookup resolved | unchanged: confident predicates, or the fallback if empty/low-confidence |
| `no-capability` | no `deriveExpectedCluster` wired | unchanged: legacy |
| `underivable` | bound block, lookup threw | unchanged: `assumedClusterSize` fallback |
| `unusable-record` / `no-coordinating-block` | field absent **or** empty array | reject |
| `unusable-record` / `unbound-coordinating-block` | names a block the record's own operations never touch | reject (was: fallback) |

New reject reasons, both keeping the `membership-not-admitted:` prefix dispute accounting groups on:
`membership-not-admitted:no-coordinating-block` and
`membership-not-admitted:unbound-coordinating-block (blockId=<id>, affected=<count>)`. New log tag
`cluster-member:coordinating-block-absent`; both refusals also emit `cluster-member:admission-reject`.

Predicate order is load-bearing and unchanged at the top: self-membership, then the
`allowUnvalidatedSmallCluster` opt-in (which bypasses the new refusals too), then the derivation
switch. The capability check runs before the record's field is read, so a member with nothing to
derive against never reaches a sender-fault verdict.

`docs/correctness.md` Theorem 2 body and status note were rewritten to state the three-way split
(sender-chosen defect ⇒ inadmissible; receiver-side inability ⇒ `assumedClusterSize` fallback; no
capability ⇒ legacy), and the "two residual limits" became one.

## Review findings

**Read first:** the implement diff (`c84fbb94`) before the handoff summary, then the surrounding
call sites — `ClusterCoordinator.executeClusterTransaction`, `CoordinatorRepo.pend`/`commit`/`cancel`,
`NetworkTransactor.consolidateCoordinators`, `batch-coordinator.ts`, `dispute-service.ts`,
`ClusterMember.processUpdate`/`validateRecord`.

### Independently verified (the handoff's central claim holds)

The handoff's strongest claim — "no honest record loses its coordinating block" — was argued, not
tested. It was re-derived from the code rather than taken on trust, and it holds on every production
path:

- **pend** — `coordinatingBlockIds` is `options.coordinatingBlockIds ?? blockIdsForTransforms(request.transforms)`,
  and the message's only operation is that same `pend`, so the fallback is bound by construction.
  When the option *is* supplied it comes from `NetworkTransactor.consolidateCoordinators`, whose
  `coordinatingBlockIds` is the batch's own `consolidatedBlocks` and whose payload is built from
  exactly those blocks (`transformForBlockId` → `transformsFromTransform` registers each block id it
  is given), so every entry is in `blockIdsForTransforms(batch.payload)`. Retry batches from
  `batch-coordinator.ts` set no `coordinatingBlockIds` at all and take the bound fallback.
- **commit** — message carries no field; the choke point stamps `[blockIds[0]]`, and the operation is
  `{ commit: request }` whose `blockIds` is that same array.
- **cancel** — one transaction per `actionRef.blockIds[i]`, and the operation is
  `{ cancel: { actionRef } }` whose `blockIds` is that same array.
- **invalidate** never reaches `executeClusterTransaction`; `get` never takes the cluster path.

Also confirmed: nothing in `src/` matches on a specific reject-reason variant (`dispute-service.ts`
reads `coordinatingBlockIds` for `collectionId` fallbacks only), so the two new variants flow through
`disputeEvidence.rejectReasons` inertly.

### Fixed in this pass (minor)

- **A settled-decision comment stated a false reason.** The `no-coordinating-block` return claimed no
  rolling-upgrade gate was needed because "`validateRecord` already throws on a `membershipVersion` it
  does not implement". It does not: `validateRecord` accepts `undefined`, `1` and `2`, and the earlier
  ticket that started stamping the field on commit/cancel records
  (`commit-and-cancel-records-omit-the-coordinating-block`) landed without bumping the version — so a
  peer on a build older than that one sends commit/cancel records this now hard-rejects. The
  *decision* stands (cluster consensus deploys as one unit, no cross-build promise); the comment now
  says that instead of an invariant that does not hold, and names where the gate would go if the
  promise ever changes.
- **The exhaustiveness `default` returned a non-verdict.** `return exhaustive` returned the derivation
  object itself from a function typed `Promise<{ admit: boolean; reason?: string }>`. It happened to
  fail closed downstream (`admission.admit` undefined is falsy), but by accident. The `never` guard is
  kept; the branch now returns a real fail-closed verdict carrying the unknown `kind`.
- **`ClusterViewDerivation`'s `underivable` carried an unread `error` payload.** The error is logged
  where it is caught and the verdict does not depend on it; the field is gone, so the union does not
  advertise a consumer it never had.
- **Test coverage gap the handoff itself flagged.** Added the `affected=0` case — a wire record with
  an empty `operations` array (a shape `RepoMessage`'s one-element tuple type forbids but the wire
  does not), which is the only way `affected=0` reaches the signed reason. Required extracting
  `voteOnRecord` from `voteOn` so a spec can vote on a hand-built record; `voteOn` now delegates to it.
  Also added the missing assertion that the new refusals emit `cluster-member:admission-reject`, the
  tag the handoff claims operators group on.

### Filed as a ticket (major)

- `tickets/backlog/debt-sender-side-coordinating-block-binding-is-unchecked.md` — the binding rule is
  enforced only on the receiving side. `ClusterCoordinator.executeClusterTransaction` stamps or
  preserves `coordinatingBlockIds` without ever consulting the message's operations, and the
  extraction the member judges against is `private` on `ClusterMember`, so the sender physically
  cannot share it. Every sender is correct today (verified above), but `coordinatingBlockIds` is a
  public `MessageOptions` field any `IRepo.pend` caller may set, and this ticket changed the
  consequence of getting it wrong from "degraded check, write still lands" to "write fails outright,
  with the reason living in N peers' reject strings rather than an exception at the mistake". Filed at
  the boundary-invariant rung rather than as a point bug: one shared affected-block helper both
  packages call, checked at the choke point, plus a generalized test over all three senders.

### Recorded as tripwires, not tickets

- The implement pass parked a `NOTE:` where the `unbound-coordinating-block` reason is built: the
  offending `blockId` is copied verbatim from the untrusted record into a string that gets signed into
  the vote, and nothing bounds a block id's length. Confirmed reachable **pre-authentication** — a
  fresh record carries no signatures, so `validateRecord` authenticates nobody before the gate runs.
  What keeps it harmless is that the reason is bounded by the record the sender already transmitted
  (no amplification), not that the path is authenticated. That clause was added to the existing
  `NOTE:` so the next reader does not have to re-derive it; disposition unchanged.

### Checked and found clean (explicitly, not by omission)

- **Predicate ordering** — self-membership before the opt-in before the switch; both orderings have
  tests, and both still pass.
- **Determinism across honest members** — the record-shape verdict is a pure function of the record,
  so capable members cannot disagree about it. Capable and non-capable members still disagree (the
  latter approve), but that heterogeneity predates this change.
- **Docs that should have been touched** — `docs/correctness.md` Theorem 2 (updated, and its §7.1
  cross-reference at ~line 462 correctly left alone, since it describes the floor, not the shape
  check); `docs/debugging.md` lists logger namespaces, not individual tags, so the new tag needs no
  entry; `docs/arachnode-ring-handoff.md`'s admission-gate paragraph is about the tolerance window and
  is unaffected. No stale link to the old backlog slug survives anywhere in `docs/` or `packages/`.
  `docs/review.html` is a dated review artifact whose `as any` note about `coordinatingBlockIds` was
  already stale before this ticket (the field is typed on `MessageOptions` now) — out of scope,
  deliberately untouched.
- **Source hygiene** — `cluster-repo.ts` is 2603 lines, which is large, but the diff added ~90 lines of
  a coherent unit; no split is proposed here, and an existing backlog ticket
  (`debt-cluster-member-race-logic-has-no-home`) already touches this file's shape.
- **No pre-existing failures surfaced**, so `tickets/.pre-existing-error.md` was not written.

## Validation

All foreground, all green, after the review's edits:

- `npx eslint` on both changed files → clean (no workspace `lint` script; the root one is `eslint .`)
- `yarn workspace @optimystic/db-p2p typecheck` (tsconfig includes `test`) → exit 0
- `yarn workspace @optimystic/db-p2p build` → exit 0
- `yarn workspace @optimystic/db-p2p test` → **2444 passing** (2443 before, +1 new), 0 failing, 49 pending
- `yarn workspace @optimystic/quereus-plugin-optimystic test` → **690 passing**, 13 pending
  (drives distributed transactions through the same member gate)

`packages/db-p2p/test/mesh-partition-admission.spec.ts` passes untouched.
