description: In a two-machine strand, a machine that has just joined commits a row and then, on its very next statement, cannot see that row, so a foreign-key check fails. It happens in some runs and not others. Find out whether it is real, and if so why a node cannot read its own acknowledged write.
prereq: warm-restart-restores-a-table-that-disagrees-with-its-declared-schema
files:
  - packages/db-core/src/transactor/transactor-source.ts (`tryGet`, and how a read after a commit sees the committed revision)
  - packages/db-core/src/collection/collection.ts (`updateInternal`, `sync`; the tracker state between a commit and the next read)
  - packages/db-p2p/src/repo/coordinator-repo.ts (read path after a local commit; the `#20` history — the settled-absence memo removed in `39ef5d4b`)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (`runQuery` live vs committed arms; how a statement's FK check reads)
  - packages/db-p2p/test/two-party-cohort-is-collection-independent.spec.ts (establishes cohorts are identical in a two-party strand)
difficulty: medium
repro: downstream
----

# What was seen

Reported 2026-09-16 by the session reviewing sereus's joiner gate. Scenario: a two-party strand where
the **joining** machine writes a `Participant` row and then a `Message` row the instant `addStrand`
resolves. Intermittent: 1 pass in 4 with a Header-only gate, 1 pass in 5 with an extended gate that also
waits for a count read of every app table to settle.

With the extended gate, the failure is always the same, on the joiner:

```
ConstraintError: CHECK constraint failed: _fk_Message_ParticipantId
```

Its **own just-committed** `Participant` row is not readable by its **next statement's** foreign-key
check. Sereus parked the scenario as blocked on this: `tickets/blocked/device-shape-join-write-blocked-
on-optimystic-read-after-write.md` in that repository.

# Not the cohort chain

Sereus first attributed this to the `a-second-party-cannot-read-the-messages-it-just-wrote` family and
therefore to the cohort-assembly chain. That diagnosis concluded otherwise: in a two-party strand every
collection resolves to an identical cohort (`two-party-cohort-is-collection-independent.spec.ts`), and
the device report came from a storage collision and a pre-sync fork, not from cohort assembly. So this is
its **own** defect. Its shape — a node reading its own write as absent — is closest to `#20`, whose
mechanism (the settled-absence memo) is gone, so if it is the same family it is a different mechanism.

# Why it waits for fix/0

It was observed **only** against the plugin build that also broke warm restart and hydration
(`fix/0-warm-restart-restores-a-table-that-disagrees-with-its-declared-schema`). A table restored with the
wrong shape could plausibly make a just-written row unreadable. So:

1. **After fix/0 lands, first establish whether this still happens.** Ask the sereus session for its
   five-run rerun of the scenario against the fixed build, or reproduce it here (below). If it no longer
   happens, say so, name fix/0 as the cause, and close this ticket.
2. **If it survives**, reproduce it in this repository: two parties over the mesh or real sockets, the
   joiner commits a parent row and immediately runs a statement whose FK check reads it. Run it many
   times; this is intermittent, so a single green run means nothing.

# Boundaries

- **A finding is a finding.** If a committed write is legitimately not yet readable at that moment, say
  what contract the application may rely on and record it. Do not add a sleep or a retry to make the
  scenario pass.
- **Do not fix this by serving stale local data.** That is the design question in
  `backlog/more-design/a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds`, which
  has a security dimension.
- **Do not reach for the cohort chain** (`implement/2-writer-and-harness-route-to-the-cohort` and
  `3-coordinator-refuses-blocks-it-is-not-responsible-for`) unless the evidence points there.

# TODO

- After fix/0: establish whether this still happens.
- If it does: reproduce here, run many times, diagnose, fix or file.
- `yarn lint`, `yarn build`, the relevant package tests.
