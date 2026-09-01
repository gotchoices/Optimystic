description: Before a machine co-signs a write, it checks that the group of peers claiming to handle that write really is the right group — but the write's sender picks which piece of data that check runs against, and if the sender leaves that choice out, the machine quietly falls back to a weaker check instead of refusing.
files: packages/db-p2p/src/cluster/cluster-repo.ts (deriveExpectedClusterView ~line 1193, admitMembership ~line 1064, ExpectedClusterView ~line 120), packages/db-p2p/src/repo/cluster-coordinator.ts (executeClusterTransaction ~line 259, the coordinating-block choke point ~line 293), packages/db-p2p/test/cluster-membership-admission.spec.ts, packages/db-p2p/test/mesh-partition-admission.spec.ts, docs/correctness.md (Theorem 2 status note, §7.2)
difficulty: medium

# An unusable coordinating block should be inadmissible, not merely unconfident

## Background, in plain terms

Every write in a cluster is driven by one peer (the *coordinator*) and voted on by the group of
peers responsible for the data (the *cohort*). Before a member votes yes, it checks for itself that
the group the coordinator declared really is the responsible group — it looks the group up
independently rather than trusting what the coordinator said.

To do that lookup the member needs to know *which piece of data* the group was chosen for. The
coordinator supplies that: one block id, carried on the message as `coordinatingBlockIds[0]`.

## The gap

`ClusterMember.deriveExpectedClusterView` returns `undefined` in four distinct situations, and
`admitMembership` treats all four identically — as "I am not confident", which downgrades the
decision from *"does the declared set match the set I measured?"* to *"is the declared set at least
`⌈fraction · assumedClusterSize⌉`?"*, and, when no `assumedClusterSize` is configured at all, to an
unconditional admit.

Two of the four are the receiver's own limitation:

- **no `deriveExpectedCluster` capability wired** (no FRET, unit tests) — nothing to check against;
- **the lookup itself failed** (the callback threw) or returned an empty / low-confidence view — a
  local or network fault.

The other two are properties of the record the **sender chose**:

- **`coordinatingBlockIds[0]` is absent**;
- **`coordinatingBlockIds[0]` names a block the record's own operations never touch** (logged as
  `cluster-member:coordinating-block-unbound`).

Collapsing those two into the receiver-fault bucket means a dishonest coordinator selects which of
the two checks every member runs, just by how it fills one field. Because `assumedClusterSize`
defaults deliberately permissive (2, from `resolveClusterPolicy` in `cluster/cluster-policy.ts`),
the weaker check is usually the one that admits a shrunken cohort the measured check would refuse.

The predecessor ticket `commit-and-cancel-records-omit-the-coordinating-block` (landed) is what
makes this closable: the coordinator now stamps the field at a single choke point in
`ClusterCoordinator.executeClusterTransaction` for **every** cluster path (pend, commit, cancel), so
its absence no longer means "an honest builder forgot" — it means the record was not built by a
current coordinator.

Note the *unbound* case is only nominally closed today. Its test
(`cluster-membership-admission.spec.ts`, "falls closed to the fallback floor when the named block is
NOT one the operations touch") passes because that case configures `assumedClusterSize: 8`; with no
asserted size the same unbound record is admitted unconditionally. Same root cause, same code site,
same fix — so this ticket covers both sender-chosen cases, not just the absent one.

## Expected behaviour

A member that **has** the derivation capability wired must not let the sender pick which check runs:

- Record carries no usable coordinating block (absent, or naming a block outside
  `getAffectedBlockIds(record.message.operations)`) → **inadmissible**. It is a malformed record, not
  an uncertain one.
- Record carries a usable coordinating block but the member could not resolve a confident view
  (callback threw, empty peer set, FRET confidence at or below threshold) → **unchanged**: today's
  fail-closed-against-`assumedClusterSize` behaviour. This is the partition posture and must stay,
  or a transient routing hiccup would make a node refuse every write.
- Member has **no** derivation capability → **unchanged** legacy behaviour. It has nothing to check
  against, and this is what keeps every unit test and every non-FRET node working.

That three-way split is the whole design: the distinction is *whose fault the missing view is*, and
it is currently erased by a single `undefined`.

## Decisions already settled (do not re-litigate)

- **Rolling upgrades are not a blocker.** `ClusterMember.validateRecord` already throws on a
  `membershipVersion` it does not implement, and the comment there states the cluster consensus code
  is a single deployable unit that upgrades together. A peer old enough to omit the coordinating
  block is old enough to be on the pre-choke-point build of the same unit. No version gate or grace
  period is needed; state that reasoning in the code comment so a later reader does not re-ask.
- **No production path other than the choke point builds these records.** `executeClusterTransaction`
  has exactly three production callers, all in `repo/coordinator-repo.ts` (pend line ~1369, cancel
  ~1605, commit ~1637). The `invalidate` operation shape has no production sender at all (the
  dispute service is off by default). So nothing legitimate loses its coordinating block.
- **The failure surface is a reject vote, not a throw.** Stay on `admitMembership`'s existing
  contract: return `{ admit: false, reason }` so the member emits a signed `reject` carrying
  `membership-not-admitted:<variant>`, which feeds dispute accounting. Do not convert this into a
  `validateRecord` throw — that changes the failure surface for every caller.
- **Not subsumed, but do not build both.** `feat-cluster-membership-threshold-cert-anchoring` would
  replace independent re-derivation with a cohort-signed membership certificate and delete this
  check along with the field it guards. That ticket is explicitly not ready to build; this one is
  worth landing meanwhile.

## Design work this stage owes

- **The return shape.** `deriveExpectedClusterView` currently returns `ExpectedClusterView |
  undefined` and the caller cannot tell the four cases apart. Decide the replacement — a tagged
  union (`{ kind: 'view'; view } | { kind: 'unusable-record'; detail } | { kind: 'no-capability' } |
  { kind: 'underivable' }`) is the obvious shape; whatever is chosen must make the erased
  distinction impossible to re-erase, which is the point of doing this at the type level rather than
  with a second boolean.
- **Reason variant names.** Follow the existing convention of naming the numbers/ids that caused the
  refusal (see `:below-floor (declared=…, floor=…, kEst=…)`). Two variants are needed —
  `no-coordinating-block` and something for the unbound case — or one variant with a discriminating
  detail. Decide which, and keep the `membership-not-admitted:` prefix so anything grouping on the
  prefix (the note at `cluster-repo.ts` ~line 1130 warns about this) still works.
- **Ordering inside `admitMembership`.** The self-membership predicate and the
  `allowUnvalidatedSmallCluster` opt-in both run before derivation today. Decide whether the opt-in
  bypasses the new refusal (it currently bypasses everything except self-membership) — the
  single-node / local-dev escape hatch has no cohort to derive and arguably should keep bypassing.
- **Whether the log tags stay.** `cluster-member:coordinating-block-unbound` currently marks a
  fallback; after this change it marks a refusal. Keep the tag (a test asserts on it) or re-tag and
  update the assertion.

## What "done" looks like in tests

`cluster-membership-admission.spec.ts` already has the harness (`voteOn(self, declared, view,
config, coordinatingBlockOverride)`). The characterising pair:

- same shrunken declared set, same confident derived view, **with** a bound coordinating block →
  `approve` (the existing "defeated-shaped" control case, unchanged);
- same record **without** the field → must now `reject` with the new variant, where today it is
  judged by the `assumedClusterSize` floor;
- and the case that has no test today at all: no field **and** no `assumedClusterSize` configured →
  must `reject`, where today it is admitted unconditionally. This is the case that shows the fix is
  about the sender's free choice and not about the floor's value.

Plus: a member with no derivation capability and no field still approves (legacy path intact), and
a member whose derivation callback *throws* on a bound block still takes the old fail-closed path
(receiver fault stays lenient).

`mesh-partition-admission.spec.ts` pins Theorem 2 end-to-end and should keep passing untouched; if
it does not, the change reached further than intended.

## Docs

`docs/correctness.md` Theorem 2's status note lists this as residual limit one of two ("a
coordinator that omits the field altogether is still judged against `assumedClusterSize`") and links
this ticket by path. That sentence must be rewritten when the fix lands, and the ticket link
removed. The second residual limit (a minority whose size estimate does not collapse) stays.
