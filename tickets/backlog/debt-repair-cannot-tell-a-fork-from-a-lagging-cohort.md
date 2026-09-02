description: When a machine is cut off from the network and keeps making changes on its own, the rest of the group cannot tell it apart from a machine that has simply fallen behind — so if it made more changes than the group did, its version is the one everyone adopts.
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/cluster/certified-claims.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/quorum-restore-certified.spec.ts, docs/internals.md
difficulty: hard
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Every option costs something real — a wire-format change to the commit proof, a wider answer from every peer on every repair, or a new deadlock where repair used to succeed — and the case it protects against needs a network split plus writes on both sides, so a maintainer may reasonably decide the existing equal-revision protection is enough.
----

# Repair cannot tell a fork from a lagging cohort

## What happens today

When a node repairs a block it asks its peers what version they hold and picks a winner. Each peer
answers with a single pair: the revision number it holds and which change produced it. That answer
says nothing about how it got there.

Two very different situations therefore look identical:

- **A lagging cohort.** One peer is at revision 6; two peers are still at revision 5 because they
  have not caught up yet. Adopting revision 6 is correct.
- **A fork.** One peer was cut off from the network, committed on its own twice, and is at
  revision 6. The two peers that stayed together committed once and are at revision 5, on a
  different history. Adopting revision 6 discards what the group agreed.

Both read as "one peer ahead of two", so the repair selectors pick the higher revision in both
cases. That is the right answer for the first situation and the wrong one for the second.

## Why this is not already fixed

`single-signer-proof-outweighs-corroboration` closed the version of this where both sides are at the
**same** revision. There, the two claims disagree about the same revision number, which is itself
evidence of a fork, and the rule is now: a receipt one machine signed for itself does not outrank
several machines agreeing with each other.

At different revision numbers no such evidence exists. The fix cannot simply be extended, because
"refuse a lone peer that is ahead" would break the ordinary lagging-cohort repair, which is the
common case by a wide margin.

Verified rather than inferred: pinned as `does NOT reach a solo fork one revision AHEAD` in
`packages/db-p2p/test/quorum-restore-certified.spec.ts`, which asserts the current (fork-wins)
outcome so the boundary is visible rather than assumed. A `NOTE:` at the selector site in
`quorum-restore.ts` points here.

## What would actually close it

The gap is missing evidence, not a missing check — so the work is to make lineage visible, and then
have the selectors use it. Two shapes exist; each has a cost worth weighing before either is chosen.

**Carry the predecessor in the commit proof.** A commit proof already binds `(blockId, revision,
action)`. If it also named the action that produced the *previous* revision, a reader could ask
whether a peer's history passes through the revision the rest of the cohort is holding. A fork
answers no; a lagging cohort answers yes. Cost: a change to what a commit record contains and
therefore to what the cohort signs, plus a migration story for proofs already written that carry no
predecessor and can never be judged this way.

**Ask peers for more than their latest revision.** Peers already retain a per-revision archive.
If a repair answer included the recent revision-to-action history rather than only the tip, the
reader could compare the two sides directly at the revision they share. Cost: every repair answer
gets larger, on a path that runs on ordinary reads, and the history is self-reported — so it needs
the same weighing the current answer gets, not blind trust.

Whichever is chosen, the outcome for the fork case has to be decided explicitly. Declining is safe
but turns a repairable block into a stuck one, and a stuck block is what the solo-cohort proof work
existed to prevent; picking the cohort's side needs a rule for what "the cohort's side" means when
the cohort has itself shrunk.

## Related, but not the same thing

`feat-cluster-membership-threshold-cert-anchoring` is about a *forged* cohort — anyone holding
several keys can present a proof that verifies. This ticket is about an *honest* proof from a
genuinely isolated machine. Anchoring membership does not help here, and this does not close that.
