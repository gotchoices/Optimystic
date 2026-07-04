----
description: When a node repairs a stale block by asking its peers for the newest version, it currently punishes the reputation of any peer that reports a newer version than the group agrees on — but a peer can honestly be ahead, so this can penalize the most up-to-date, well-behaved peers by mistake.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts (penalizeContradictingRevClaims), packages/db-p2p/src/reputation/types.ts (PenaltyReason.InvalidRestoration), packages/db-p2p/test/coordinator-repo-read-repair-trust.spec.ts
difficulty: medium
----

# Read-repair should only penalize *provable* misbehavior

## Why this exists

The read-repair path (`CoordinatorRepo.queryClusterForLatest`) asks the block's
cohort peers for their latest revision, then accepts the highest revision that a
quorum of distinct peers agrees on. As a side effect it also *penalizes* the
reputation of peers whose claim "contradicts" the agreed answer
(`penalizeContradictingRevClaims`). A contradiction is defined as either:

1. **`rev > selected.rev`** — the peer reported a *higher* revision than the
   quorum agreed on, or
2. **same rev, different `actionId`** — the peer reported the agreed revision but
   a different action id.

Branch (2) is a genuine conflict: two different actions cannot both be the commit
at the same revision, so one peer is provably wrong.

Branch (1) is **not** provable misbehavior, and that is the problem. A peer can be
honestly *ahead* of the sampled quorum:

- **In-flight commit.** A commit durably stores the new revision on a quorum of
  the cohort *before* it finalizes. A peer that already stored the new revision
  reports it as its latest while other honest peers, sampled a moment earlier,
  still report the old one.
- **Sampling loss.** `queryClusterForLatest` gives each peer a 1-second timeout.
  If several honest peers that hold the new revision are slow to answer, they drop
  out of the sample, the new revision fails to reach quorum *in that sample*, and
  the one fast honest peer that did answer is flagged as the liar.

The penalty weight for this (`InvalidRestoration` = 30) is above the deprioritize
threshold (20), so a **single** false hit immediately deprioritizes an honest,
up-to-date peer in coordinator selection — the opposite of what we want. Repeated
hits (across blocks, within the 30-minute decay half-life) can push toward the ban
threshold (80).

Declining to *restore* from an uncorroborated higher revision is correct and
should stay. The issue is the extra, affirmative reputation **penalty** applied on
ambiguous evidence.

## Expected behavior

Read-repair should only apply a reputation penalty when the peer's claim is
*provably* wrong, not merely un-corroborated. Concretely:

- Keep penalizing the same-rev / different-`actionId` conflict (branch 2) — that
  is provable.
- Do **not** penalize a bare `rev > selected.rev` claim on its own. A higher,
  uncorroborated revision should cause us to *decline to restore* (already the
  case) without also harming the reporter's reputation.
- The stronger, complete version of "provable" is a valid commit certificate for
  the claimed revision — a peer that presents one is telling the truth and must
  never be penalized; a peer that claims a higher revision but cannot back it with
  a cert is the real target. That certificate machinery is the separate backlog
  item `debt-read-repair-commit-cert-verification`; this ticket can either land the
  cheap fix now (drop branch 1) or be folded into that work.

## Note

`reconcileBlock` in `libp2p-node-base.ts` penalizes on a *different*, provable
basis — a peer that serves block bytes hashing differently from the
quorum-agreed content for the same committed `(rev, actionId)`. That one is fine
and out of scope here; only the read-repair `rev >` branch is the concern.

## Test impact

`coordinator-repo-read-repair-trust.spec.ts` currently asserts that a lone liar
reporting `rev: 99` **is** penalized (via branch 1). Dropping branch 1 changes
that expectation — the liar is still correctly outvoted (no restoration against
the lie, which is the security property that matters), it just isn't reputation-
penalized without a cert to prove the lie. Update that assertion as part of the fix.
