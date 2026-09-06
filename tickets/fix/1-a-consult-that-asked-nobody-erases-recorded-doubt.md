description: When a machine loses contact with the others that share a record, it forgets that it had already been told a newer version exists — and then serves its old copy as if it were confirmed current.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`fetchBlockFromCluster` return shape; the `recordAheadClaim` call in `get`; `recordAheadClaim`'s own doc comment states the invariant being violated)
  - packages/db-p2p/test/coordinator-repo-unavailable.spec.ts (the existing specs for "the mark outlives the consult")
difficulty: medium
repro: verified
----

# A freshness check that reached nobody is treated as authority

## What goes wrong

A node that reads a record may ask the other machines responsible for it whether they hold
something newer. When one of them says yes but the node cannot obtain that newer version, the
node **remembers the doubt**: later reads of that record are stamped "this may be behind
revision N", which is what eventually raises `BlockPossiblyStaleError` to the caller. The
memory exists precisely so the doubt survives reads where no fresh check runs.

The doubt is erased by a check that **asked nobody at all**. Three situations produce that:

- the node is the only machine responsible for the record (the `cluster-fetch:solo-self-skip`
  exit — it deliberately queries no one);
- the responsible-machine lookup came back empty;
- every machine that was asked failed to answer.

In all three the node concludes "nothing claims anything ahead of me", drops the remembered
doubt, and serves its old copy **unflagged and unqualified** — the same silent-stale answer the
doubt marker was introduced to prevent. The third case is the ordinary one: a node that simply
loses contact with its peers forgets what it had already been told.

## Why this is a representation problem, not a missing `if`

`recordAheadClaim` documents the invariant in its own doc comment:

> Only a consult that actually RAN may call this: it is the authority, so `undefined` clears a
> claim an earlier pass recorded.

The read path cannot honour that, because the value it decides from cannot express the
difference. `fetchBlockFromCluster` returns `{ absence, claimedAheadRev? }`, and
`claimedAheadRev: undefined` means **both**:

- "peers answered and none of them claims anything ahead" — a real refutation, and the only
  case that should clear the memory; and
- "no peer was asked, or none answered" — no evidence at all.

The companion `absence` field does not separate them either: the solo-self exit and the
empty-cohort exit both report `'confirmed'`, the same verdict a healthy cohort produces when it
genuinely holds nothing newer.

This is the *currency* half of the exact flattening that `AbsenceVerdict` already fixed for the
*existence* half, and it is the failure mode
`backlog/debt-freshness-state-scattered-across-coordinator-repo` predicts in its own acceptance
criterion ("existence and currency as separate, named results, not a pair of booleans, or the
same class of flattening can reappear"). Fixing it by adding a condition at the one call site
leaves the ambiguous return value in place for the next caller; the durable fix is to make "no
evidence" and "refuted" distinguishable in the value itself, so a future exit cannot be added
that silently means the wrong one.

## Expected behaviour

- A remembered ahead-claim is cleared **only** by a check that actually reached cohort members
  and learned they claim nothing ahead. It also stays cleared when this node reaches the claimed
  revision — that rule is correct today and must survive.
- A check that reached nobody leaves the remembered doubt exactly as it found it, so the served
  record stays marked as possibly-behind until something genuinely refutes it.
- Adding a fourth early exit to the cohort check must not be able to erase doubt by accident.

## Reproduction (verified 2026-09-05, at the tip of `review/solo-node-read-repair-never-settles`)

Driving `CoordinatorRepo` with stubs, `readRepairMode: 'paranoid'` so a check runs on every read,
cohort of three, local copy at revision 1, both remote peers claiming revision 3 which cannot be
acquired:

1. First read → served entry carries the doubt marker (`unconfirmedAheadRev === 3`). Correct.
2. Then, in one variant, shrink the responsible set to this node alone; in the other, make both
   remote peers fail to answer.
3. Second read → the marker is **gone** (`undefined`), and the entry is not marked unavailable
   either. The stale copy goes back to the caller as confirmed-current.

Both variants reproduced. The probe was a scratch spec, run and deleted; re-creating it is a
few dozen lines against the helpers already in
`packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts`.

## Scope notes

- **Pre-existing, not introduced by the solo-cohort read-repair fix.** That fix arms the
  freshness window on the solo exit; it did not create this erasure. It does lengthen the
  consequence on the solo path specifically — with the window now armed, the next check is
  deferred by up to `readRepairWindowMs` after the doubt is dropped. The total-silence variant,
  which is the common one in the field, is unaffected by that fix and behaves the same before and
  after it.
- The three specs under "the mark outlives the consult" in
  `coordinator-repo-unavailable.spec.ts` cover the cases where a check *did* run. None of them
  covers a check that reached nobody, which is why this survived.
- Related but distinct from `implement/a-reader-cannot-tell-its-view-stopped-advancing`: that one
  is about a node's own writes wrongly counting as proof of freshness (the *window*). This one is
  about remembered doubt being erased by a non-check (the *claim memo*). No ordering dependency
  between them; they touch different statements.
