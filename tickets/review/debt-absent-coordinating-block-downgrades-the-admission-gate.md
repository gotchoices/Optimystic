description: A machine that co-signs a write now refuses outright when the sender's request fails to point at the data it claims to be about, instead of quietly running a weaker check the sender effectively chose.
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/cluster-membership-admission.spec.ts, docs/correctness.md
difficulty: medium

# Review: an unusable coordinating block is inadmissible, not merely unconfident

## What landed

Before a cluster member signs an approve, it re-derives its own view of a block's responsible peer
set and checks the coordinator's declared set against it. That derivation used to return a bare
`ExpectedClusterView | undefined`, and **four** different situations produced the same `undefined`,
all falling into one lenient fallback. Two of the four are properties of the record the *sender*
built, so a dishonest coordinator could pick which check every member ran just by how it filled
`coordinatingBlockIds`.

The four are now a tagged union, `ClusterViewDerivation` (module-internal, `cluster-repo.ts` ~line
141), and `admitMembership` switches on it exhaustively:

| kind | cause | verdict |
|---|---|---|
| `view` | lookup resolved | unchanged: confident predicates, or the fallback if empty/low-confidence |
| `no-capability` | no `deriveExpectedCluster` wired | unchanged: legacy |
| `underivable` | bound block, lookup threw | unchanged: `assumedClusterSize` fallback |
| `unusable-record` / `no-coordinating-block` | field absent **or** empty array | **new: reject** |
| `unusable-record` / `unbound-coordinating-block` | names a block the record's own operations never touch | **new: reject** (was: fallback) |

Order in `admitMembership` is load-bearing and unchanged at the top: self-membership first, then the
`allowUnvalidatedSmallCluster` opt-in (which bypasses the new refusals too), then the switch.

New reject reasons, both keeping the `membership-not-admitted:` prefix that dispute accounting groups
on:

- `membership-not-admitted:no-coordinating-block`
- `membership-not-admitted:unbound-coordinating-block (blockId=<id>, affected=<count>)`

New log tag `cluster-member:coordinating-block-absent`; existing
`cluster-member:coordinating-block-unbound` kept (a test asserts on it); both also emit the usual
`cluster-member:admission-reject` so operator grouping on that one tag sees them like every other
refusal.

Capability check runs **first**, before the record's field is read — a member with nothing to derive
against has no standing to judge the record's shape and must never reach a sender-fault verdict.

## Validation run

All in the foreground, all green:

- `yarn workspace @optimystic/db-p2p build` → exit 0
- `yarn workspace @optimystic/db-p2p typecheck` (tsconfig `include: ["src", "test"]`, so tests are
  type-checked too) → exit 0
- `yarn workspace @optimystic/db-p2p test` → **2443 passing, 0 failing**, 49 pending
- `yarn workspace @optimystic/quereus-plugin-optimystic test` → **690 passing**, 13 pending (this
  package drives distributed transactions through the same member gate; run as a cross-package
  sanity check)

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

`packages/db-p2p/test/mesh-partition-admission.spec.ts` passes **untouched**, as the plan required —
`git status` shows exactly three modified files and that spec is not one of them.

## Use cases a reviewer should poke at

The interesting question is always *"does this refuse something honest?"* The claim is no, because
every production record routes through `ClusterCoordinator.executeClusterTransaction`
(`repo/cluster-coordinator.ts` ~line 293), which stamps a bound `coordinatingBlockIds: [blockId]`
when the message has none. Worth re-verifying independently:

- **pend / commit / cancel** — `CoordinatorRepo.pend` (~1369), `commit` (~1637), `cancel` (~1605) all
  pass an id drawn from the same blocks `getAffectedBlockIds` extracts. Retry batches from
  `batch-coordinator.ts` set no `coordinatingBlockIds` at all and fall through to `allBlockIds`.
- **Reads** never take the cluster-consensus path.
- **Multi-block consolidated pends** — `NetworkTransactor.consolidateCoordinators` supplies a list;
  only `[0]` is read (there's a `NOTE:` at the read site saying so), and every entry is a subset of
  the batch's own transforms.
- **Specs that hand-craft records and call `member.update` directly** (`byzantine-fault-injection`,
  `cluster-membership-binding`, the `cluster-coordinator*` family) build members with no
  `deriveExpectedCluster`, so they take the untouched `no-capability` path. If a reviewer wires a
  derivation into one of those specs, records there will start being refused — that is the intended
  semantics, not a regression, but it is the sharpest edge in this change.

Test coverage added in `cluster-membership-admission.spec.ts` (describe renamed to
*"the coordinating block must be present AND bound to the record's own operations"*): unbound with and
without an asserted cohort size; absent with and without one; empty array; absent with a *full-size*
declared set and an agreeing view (still refused — shape, not size); legacy no-capability path on
both halves; a **throwing** derivation on a bound block staying lenient; the opt-in still admitting;
self-membership still winning. Harness changes: `makeRecord`/`voteOn` take
`coordinatingBlockIds?: string[] | 'omit'`, and `voteOn`'s `view` now also accepts a raw
`DeriveExpectedClusterCallback` so a throwing capability can be exercised.

## Known gaps — treat these as the starting point, not the finish line

- **The "no honest record loses its block" claim is argued, not exhaustively tested.** The mesh
  harness wires `deriveExpectedCluster` on every node and the full db-p2p + quereus suites pass, which
  is the strongest evidence available, but there is no test that *enumerates* production senders and
  asserts each stamps a bound id. A reviewer who wants that guarantee mechanically enforced should
  say so — it would be a boundary-invariant test at the coordinator choke point, not a point test.
- **No test covers the empty-`operations` case** (`affected=0` in the reason string). The behaviour is
  reasoned about and commented at the site, but a record with no operations is refused via a path
  nothing exercises. Arguably fine (such a record is malformed and refused for that reason), but it is
  untested.
- **The `dispute-service.ts` consumers of `coordinatingBlockIds` were read, not re-tested in
  isolation.** Nothing in `src/` switches on a specific reject-reason variant string (checked by
  grep), so the two new variants should flow through `disputeEvidence.rejectReasons` inertly — but
  that is a grep-level conclusion.
- **Blast radius when a refusal does fire.** A member refusing where it used to approve means the
  coordinator fails the transaction outright rather than assembling a super-majority. Intended for a
  malformed record; if the "every honest sender is bound" claim is wrong anywhere, the symptom is a
  hard write failure, not a degraded one.
- **`docs/review.html` line 363** mentions `coordinatingBlockIds` being smuggled through `as any` in
  `network-transactor.ts`. Untouched by this ticket and unverified — noting it only so the reviewer
  doesn't mistake it for something this change addressed.

## Tripwire parked

- `cluster-repo.ts`, at the `unbound-coordinating-block` reason construction: the offending `blockId`
  is copied verbatim from the untrusted record into a string that gets **signed into the vote** and
  stored in dispute records, and nothing upstream bounds a block id's length. Harmless while block ids
  are short content hashes; recorded as a `NOTE:` at the site with the remedy (truncate) if a
  pathological id ever appears. The plan deliberately bounded the *affected-ids* half of this string
  (count, not list); this is the other half.

## Docs updated

`docs/correctness.md` Theorem 2:

- **Body (~line 116)** — the clause "it must be one the record's own operations name, or the member
  declines to derive at all" now says the record is *inadmissible*, and adds that naming no
  coordinating block at all is likewise inadmissible on any member that can derive.
- **Status note (~line 126)** — the "unbound id … falls back to the low-confidence floor" clause is
  now a refusal, and the note states the three-way split plainly (sender-chosen defect ⇒ inadmissible;
  receiver-side inability ⇒ `assumedClusterSize` fallback; no capability ⇒ legacy), plus that the
  opt-in bypasses it and only self-membership is unbypassable. "Two residual limits" is now **one** —
  the removed one was this ticket; the surviving one (a minority whose size estimate does not collapse
  admits its own small cohort confidently) is unchanged. The stale
  `tickets/backlog/debt-absent-coordinating-block-...` link is gone; no other reference to it remains
  anywhere in `docs/` or `packages/` (grepped).
- Lines ~462 / ~471 describe the low-confidence floor and were correctly left alone.

Falsified JSDoc in `cluster-repo.ts` refreshed: `DeriveExpectedClusterCallback` (~131),
`admitMembership`'s posture paragraph (a new "Inadmissible records come first" paragraph precedes the
now-narrowed "Fail-closed posture" one), `deriveExpectedClusterView` (~1193, which listed the four
`undefined` causes), and `getAffectedBlockIds` (~2284, which described the binding check as a
fallback).

## Settled decisions recorded as comments (do not re-litigate)

Each is a comment at its site, so a later reader meets the reasoning rather than re-asking:

- **No rolling-upgrade gate** — at the `no-coordinating-block` return: `validateRecord` already throws
  on an unimplemented `membershipVersion`, i.e. cluster consensus is one deployable unit, so a peer
  old enough to omit the field is on the pre-choke-point build of that same unit.
- **Reject vote, not a throw** — at the `unbound-coordinating-block` return: stays on
  `admitMembership`'s `{ admit: false, reason }` contract so a signed `reject` is emitted and dispute
  accounting keeps working; deliberately not moved into `validateRecord`.
- **The opt-in still bypasses** — at the `allowUnvalidatedSmallCluster` check: it already bypasses the
  far stronger confident predicates, so making a weaker record-shape check the one thing it cannot
  bypass would be incoherent.
- **Receiver faults stay lenient** — at the `underivable` return: refusing there would make a
  transient routing hiccup refuse every write.
- **Only `[0]` is read** — `NOTE:` at the field read.
