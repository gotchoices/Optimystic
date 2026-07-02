description: A group of nodes that swaps in a replacement member now announces and signs the change so faraway peers who track the group only through its chain of signed hand-offs stay on the current member list instead of getting stuck on a stale one.
prereq:
files:
  - packages/db-core/src/cohort-topic/membership/publisher.ts (republish gate keys on the full cohortEpoch)
  - packages/db-p2p/src/cohort-topic/host.ts (rotation-attestation trigger keys on epochKey; stale "first k−x" doc comments corrected in review)
  - packages/db-core/test/cohort-topic/membership.spec.ts (publisher unit tests; snapshot() derives a real epoch)
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts (rotation tests 8–11)
  - docs/cohort-topic.md (four stale "first k−x" republish/rotation references corrected in review)
difficulty: medium
----

# Publish + attest a membership hand-off on *any* epoch change — COMPLETE

## What shipped

A **cohort** is the small group of nodes that jointly serve one topic at one point in the routing tree.
Its identity label is `cohortEpoch = H(sorted all members)`. Two independent decisions — the publisher's
**republish gate** (`publisher.ts`) and the host's **rotation-attestation trigger** (`host.ts`) — used to
key only off the first `minSigs` (= `k − x`) members of the sorted set (the "firstKx"). A membership change
*beyond* position `minSigs` (a tail swap) rotated the epoch label but triggered no prompt republish and no
hand-off signature. A distant peer that can only verify the cohort *through its chain of signed hand-offs*
would then reject the un-attested successor cert and stay on the stale predecessor — so a legitimate message
signed by the swapped-in tail member was reported `untrusted`.

The fix keys **both** gates on the full `cohortEpoch` instead of the firstKx. Any member change — head or
tail — rotates the epoch, so the publisher republishes promptly and the host attaches a hand-off attestation
on any epoch change, closing the chain-only gap.

The implement-stage commit is `f7be9b4`. This review pass added no behavioral changes — only stale-doc
corrections (below). Both source files' logic is unchanged from `f7be9b4`.

## Review findings

**Scope of review.** Read the implement diff first (publisher.ts, host.ts, both spec files) before the
handoff. Scrutinized correctness, DRY, type safety, error handling, resource cleanup, doc accuracy, and test
coverage. Ran build + tests for both affected packages.

### Correctness — checked, no defects

- **The two gates cannot disagree.** Both derive their key from the *same* value: `cohortAround` computes
  `cohortEpoch = hash.H(sorted-member-join)` (host.ts:608–614), the publisher's snapshot carries that exact
  bytes as `snapshot.cohortEpoch`, and the host's `epochChanged` compares `epochKey =
  bytesToB64url(cohortEpoch)`. Same source, so "what counts as a change" is identical on both sides. This was
  the ticket's top review-focus item — confirmed sound.
- **Publisher gate and rotation bookkeeping stay in lockstep.** `SigningMembershipCertPublisher.lastEpoch`
  and `RotationState.lastPublished` are both advanced only on a successful publish (`publish()` sets
  `lastEpoch`; `publishMembership` calls `recordPublished(current)` only when `published !== undefined`), so
  `rotating` (computed from `predecessor()`) and `onStabilized`'s own republish decision never diverge.
- **Epoch is order-independent and a pure function of the whole set** (members sorted before hashing), so a
  reorder of the same set is *not* a spurious republish — covered by the new "does not republish when
  unchanged" test.
- **Error/cleanup path intact.** `produceRotation` still catches an unreachable-predecessor quorum and
  returns `undefined`, so the cert publishes without an attestation (graceful fallback, no worse than a
  non-rotation publish).
- **No other firstKx-keyed change-detection gate was missed.** Swept `packages/` for
  `slice(0, minSigs)` / `firstKx`; every remaining hit is either a test mock producing a `minSigs`-length
  signer list (correct threshold-signature semantics, not a change gate) or the host's threshold signer
  quorum (`ctx.minSigs`, correctly still `k − x`). The change-detection use of firstKx is fully removed.

### Minor findings — fixed inline this pass (stale docs)

The behavior changed but several comments/docs still described the old "first k − x" republish/rotation
rule. Corrected to the epoch rule:

- `host.ts:363` — `onStabilized` doc ("republishes only when the first k − x members changed" → "when the
  cohort epoch changed, any member change head or tail").
- `host.ts:1241–1242` — `RotationState` producer doc ("a publish whose first k − x differ" → "whose epoch
  differs").
- `host.ts:2164` — `sameStringOrder` comment (labeled "the first-k−x rotation-change check"; it is no longer
  that — it is now used only by `sameMemberList` for the endorser's sorted-member-list image check).
- `docs/cohort-topic.md` lines 505, 507, 559, 577 — four references to the "first k − x" republish/rotation
  trigger corrected to "any epoch change / any member change".

### Observed but out of scope — not changed

- `docs/cohort-topic.md:428` describes a **separate, unimplemented** firstKx-keyed threshold — invalidating
  cached *primary assignments* "when membership has rotated by more than a configurable threshold (default:
  any change to the first k − x = 14 members)". This is a different subsystem from the membership-cert
  publisher this ticket touched, and no such cache-invalidation code exists in
  `packages/db-core/src/cohort-topic/registration/` (grepped — no match). It shares the *shape* of the bug
  this ticket fixed, so if that primary-assignment cache is ever built it should key on the epoch too — but
  it is design text for unbuilt work, so I left it unchanged rather than assert a rule about code that does
  not exist.

### Coverage gap the ticket flagged — disposition: NO ticket filed

The implementer noted "no deterministic tail-only host-trigger e2e test" and asked the reviewer to decide
whether it warrants a `debt-` backlog ticket. **Decision: it does not**, and here is the reasoning (recorded
here rather than as a ticket, per the tripwire rule):

The fix *removed* the firstKx slice from the host trigger. `epochChanged` is now
`(a, b) => a.epochKey !== b.epochKey` — a scalar hash comparison with **no head/tail branch**. In the old
code, "a change beyond firstKx" was a distinct code path (a slice that dropped the tail); now there is no
such path — head and tail are indistinguishable to a whole-set hash. So there is no *untested branch* to
cover. The publisher gate (the real decision logic) is unit-tested for a tail-only change
(`membership.spec.ts`), and the host's one-line comparison plus the unchanged e2e rotation tests 8–11
(`live-tier.spec.ts`) exercise the trigger→attestation→verify chain. An e2e test that pins Ed25519 identities
to force a "tail-only" swap would assert a distinction the code no longer makes. Low value; not filed.

### Tripwires — verified present (planted by the implementer, not new this pass)

- `publisher.ts` `onStabilized` — `NOTE:` that republish + attestation fire on any epoch change, bounded by
  real churn; revisit debounce/batching only if a high-churn cohort shows excess `/sign` or publish load.
- `host.ts` at `epochChanged` — `NOTE:` that the `/sign` rotation-endorsement gate remembers only the
  current + immediately-prior epoch (`RotationState.membersAt`); a history-depth concern orthogonal to this
  trigger.

Both read accurately against the shipped code. No new tripwires needed.

### Empty categories

- **Major findings: none.** No new fix/plan/backlog tickets — no defect of that severity surfaced.
- **New tripwires: none** beyond the two already planted.

## Validation run this pass (all green)

- `yarn build` (tsc) in `packages/db-core` — clean.
- `yarn build` (tsc) in `packages/db-p2p` — clean.
- `yarn test` in `packages/db-core` — **999 passing**.
- `yarn test` in `packages/db-p2p` — **1077 passing / 37 pending / 0 failing**.
- Lint: the repo `lint` script is a no-op stub (`echo 'Lint not configured for all packages'`) and db-p2p
  has no `lint` script; tsc is the effective type-check gate and both packages build clean. No
  `.pre-existing-error.md` written (no failures surfaced).
