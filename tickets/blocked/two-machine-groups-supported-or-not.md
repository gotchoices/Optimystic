description: Two machines sharing a record can technically run today and the setup guide explains how, but one of them can quietly keep the other on old data forever; someone has to decide whether that pairing is a supported way to run this system or only a convenience for local development.
files: packages/db-p2p/src/repo/coordinator-repo.ts (the accepted-tradeoff NOTE at the `cluster-fetch:local-current` arm of `fetchBlockFromCluster`), docs/transactions.md (Lazy read-repair window; the corroboration-floor bullet that documents the two-machine setting)
----

# Is a two-machine group a supported topology?

## The decision

When exactly two machines share responsibility for a record, the second machine is the **only**
possible second opinion the first can get. Every safeguard in the freshness check assumes there are
two independent opinions to compare; with one, the check degenerates into believing whichever
machine answers.

The code says out loud that it knows this. At the point where a machine accepts "you are already
current" from its group, a comment records a decision that was weighed and taken:

> in a cohort of two, that sole peer is the only corroborator, so a lying one can park the reader
> here — corroborating the revision it already holds — and re-arm the lazy window on every pass,
> hiding a real divergence. Bounded by `readRepairWindowMs` (10s default) and no worse than the
> peer simply staying silent. **If two-member cohorts become a supported production topology rather
> than a dev convenience, stop re-arming the window on a corroboration that came from a single
> voter.**

The condition that comment names may already have arrived, which is why this is being put to a
human rather than acted on:

- The deployment that reported the bug behind `a-reader-cannot-tell-its-view-stopped-advancing`
  runs two-machine groups.
- `docs/transactions.md` documents the exact setting a two-machine deployment needs
  ("a genuine two-node deployment needs one setting to repair itself"), which reads like support,
  not like a dev convenience.

But it is not obvious *from the code* whether the project intends to support this, and the two
readings lead to different work.

## Why it cannot just be fixed

The remedy the comment names — stop trusting a corroboration that came from a single voter — costs
the thing the sibling ticket
`backlog/bug-a-cohort-that-cannot-corroborate-re-asks-on-every-read` is about: the two-machine
group would then never be able to confirm anything, so every read would re-ask its partner, with
no end. Taking both fixes naively gives a two-machine deployment a network round trip on every
single read, forever. So the two questions have to be answered together, in this order:

1. **Is a two-machine group supported in production?**
   - *No, development only* — then keep the current tradeoff, and change nothing but the wording:
     say plainly in the docs that two machines cannot detect a dishonest partner, so nobody
     deploys it expecting otherwise.
   - *Yes* — then a lone partner's word cannot be treated as confirmation, and the pairing needs a
     real second source of truth (a signed commit receipt the reader can verify on its own, a third
     witness that stores nothing, or an operator-accepted "trust my partner" switch). Which of
     those is a follow-on design question, not this ticket's.
2. Either way, `bug-a-cohort-that-cannot-corroborate-re-asks-on-every-read` still needs its own
   answer, because it affects a machine that has *not* been told anything by anyone.

## What is not being asked

This is not a report that something is broken today. The exposure is bounded (a dishonest partner
can delay a reader by ten seconds at a time, and can achieve the same by staying silent), and it
was knowingly accepted. What is being asked is whether the assumption behind that acceptance —
"two machines is a dev convenience" — is still the project's position.
