description: When the two machines of a two-member strand insert into the same table at the same moment, one insert often fails with a torn-write error ("stale revision"), and some of the inserts reported as failed were in fact saved. An application that retries a failed insert can therefore write the row twice, and one that gives up can believe a saved row was lost.
files:
  - packages/db-core/src/collection/collection.ts (`completeOwnEntry`, `syncAttempts`: the own-entry completion added by `a-write-whose-log-entry-landed-alone-is-reported-saved`)
  - packages/db-core/src/collection/struct.ts (`TornActionError` and its `reason`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (pend conflict detection; commit arm)
  - packages/db-p2p/src/storage/storage-repo.ts (same-action retry at the same revision; stale-revision refusal)
  - packages/db-p2p/src/repo/coordinator-repo.ts (commit local-executed arm, `refuseCommitNotDurable`)
repro: downstream (reliable)
severity: wrong-result
likelihood: normal-use
----

# What was seen

Reported 2026-09-17 by sereus (`sereus-83`), measured against optimystic `012573a2`. The full report is at `../sereus/tickets/complete/relay-round-trips-remeasure-optimystic-012573a2.md`, in the "Error tally" section.

**Topology.** Two single-node parties connected only through a loopback relay. A founds a closed strand, and B forms it and joins. A runs the `transaction` profile and B runs `storage`. Chat schema: `Participant`, plus `Message` with a foreign key to `Participant`. A "concurrent pair" is `Promise.allSettled` of one `Message` insert on each party.

**Rates:**
- **Storage joiner:** 7 of 16 concurrent pairs failed.
  - No proxy: 5 of 12, across 3 runs failing 1, 4 and 0.
  - Through a counting TCP proxy: 2 of 4.
- **Always B:** every failure was on B's insert. A's insert always succeeded.
- **Zero failures elsewhere:** sequential inserts, single inserts, reads, the 150 ms-delayed run, and 4 concurrent pairs with both parties on `transaction`.
- **Reliable repro:** 4 back-to-back concurrent pairs with a storage joiner.

**Every failure has the same shape:**

```
TornActionError: collection default/app/Message: action <id> is torn at rev N — its log entry is stored
but block(s) <id> do not hold that revision, and the write cannot be finished: stale revision:
block <id> at rev N+1, requested rev N
```

The stored revision is always exactly one ahead of the requested one (5→6, 11→12, 17→18, 23→24). That fits both writers having taken the same revision.

**The outcome is inconsistent with the error.** Sereus checked each result with A's `Message` count at the start of the next rep.
- **Absent (row lost):** in 4 cases the torn row was absent.
- **Present (row saved):** in `c2np-r2` reps 2 and 3 the counts went 7 → 13 → 19, where +5 would mean the row was lost. So **a write reported as failed was saved** twice.
- **Unchecked:** rep 4 of each run had no later read.

# Why this matters

- **Duplicate rows:** since `a-write-whose-log-entry-landed-alone-is-reported-saved`, a torn write fails loudly instead of silently vanishing. But an error that sometimes means "saved" breaks the only rule an application can follow: retry on failure. Here a retry duplicates the row.
- **Low node counts:** two writers on a two-member strand is the smallest multi-writer deployment. It is also the one sereus ships.
- **Phones:** a phone joiner uses the storage profile.

# Questions the fix stage must answer

1. **How do two concurrent writers take the same revision?** The pend should have made one of them see the other as a conflict (a rival pending action) and retry at N+1. Is the conflict missed with a `storage` joiner? For example, the joiner might not hold the other's pending record because it never stored the collection's earlier blocks. Or does one writer's commit race past the other's pend? The `transaction`/`transaction` control never failed, so the profile difference is the lead.
2. **Why is the torn write sometimes saved?** Candidates:
   - B's completion re-send succeeding on a later retry at another layer (sereus's own retry, or the bridge).
   - The row reaching the collection through the rival's replay of B's staged actions.
   - A second revision being taken.

   Find which. Then either make "saved" and "reported failed" impossible together, or give the error a reason that tells the caller it may have landed.
3. **Is `stale revision` being classified correctly?** A different action already holds revision N+1 of that block. That is `rival-holds-revision`, which is permanent. The message suggests it may be reaching the `completion-refused` / "cannot be finished" path instead.
4. **Relation to `backlog/bug-a-two-member-cohort-refuses-a-commit-both-members-hold`.** That ticket's latest arm, from the earlier 1-of-3 run, reads this error as that bug's downstream form, from code reading only. Confirm or refute that with a reproduction. If it is the same bug, fold that ticket in here.

Start with a failing test. The in-process mesh with two members, one of them configured like sereus's `storage` profile, and two concurrent `Message`-shaped inserts should be enough. If it does not reproduce in-process, say what differs from sereus's topology before reaching for real sockets.

# Also seen in the same report (not this ticket's scope)

- **27 `/db-p2p/block-transfer` from A** after the first `Message` insert of every run, and never after. This is probably the first placement of a new collection's blocks. It is larger than the "one fetch and push" leftover window that `rebalance-pushes-freshly-committed-blocks-back-to-members-that-hold-them` described.
- **The 9 `/cluster` streams per insert** are now the dominant cost over a slow link: inserts take 9–10 s at 150 ms each way, while reads take 0.6–2.5 s. That is `backlog/feat-a-commit-pays-three-consensus-rounds-of-three-calls-each`.
