description: When a user makes a change and the other machines in their group are not all reachable, the change is refused and the user has to try again later. Instead, the change should be recorded as pending on the user's machine and completed automatically, piece by piece, as the other members come and go, so that a group of rarely-online phones can still get changes through as long as members overlap now and then.
prereq: commit-result-carries-durability-class
files:
  - packages/db-core/src/cluster/structs.ts (~line 84 `ClusterRecord`: `promises` and `commits` are per-peer signature maps, i.e. the record is already a mergeable signed ballot)
  - packages/db-p2p/src/cluster/cluster-repo.ts (~line 923 `computePromiseHash`: covers the message hash, the message and the membership digest, not the coordinator's identity, so a record can change hands without invalidating votes)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (~line 1008-1090 `scheduleCommitRetry` / `retryCommits`, ~line 1136-1165 `recoverTransactions`: today only the broadcast phase is recoverable; promising and committing states are deleted on restart)
  - packages/db-p2p/src/cluster/persistent-transaction-state-store.ts and `libp2p-node-base.ts` ~line 287 (the state store exists but reference-peer and sereus never inject one)
  - packages/db-core/src/transaction/transaction.ts (`TransactionStamp.expiration`: the TTL this feature stretches)
  - packages/db-p2p/src/cluster/cluster-repo.ts (conflict race and `ConflictSuperseded`: what happens to a long-lived pend when a rival commits)
  - docs/transactions.md (~line 2614-2617 lists "allow writes, queue for reconciliation" as an unbuilt option; ~line 2497-2538 the Behind / Ahead / Forked table)
  - ../sereus/docs/cadre-consistency.md (the asynchronous Right-is-Right design; this ticket is the storage-layer half of it)
difficulty: hard
tradeoffs: A pend that lives for days holds its blocks against every other writer for that long, so a hostile or merely forgetful member can stall a hot block until the TTL expires; and the originator must be reachable to rebase a pend that lost, since re-execution changes the read set and therefore the transaction id it signed. A maintainer may decide the simple client-side outbox (resubmit on reconnect, rebase if stale) covers enough real cases and defer the gossiped ballot.
----

# Two regimes, one mechanism

Whether a queued write can be finished without the writer depends on one question: can the cohort reach quorum without the writer?

**Large network (the cohort can reach quorum without me).** Other transactions keep committing while the writer is away, so the writer's read set will be stale on reconnect. A durable client-side outbox that resubmits on reconnect and rebases on a stale failure is correct and sufficient. This is ordinary optimistic concurrency with persistence, and it is the cheap half of this ticket.

**Small network (the cohort cannot reach quorum without me).** Three phones that are rarely online at the same time. Unanimity is required at three, so nobody else can commit either while any member is away: the world is frozen at the writer's read set, and the pend stays valid indefinitely. What is needed is for the promise signatures to accumulate across pairwise contacts: A pends and signs; A meets B, B validates against its own state and signs; B meets C, C signs; whoever holds three promises drives the commit phase the same way. The cluster record already has this shape (per-peer signature maps, promise hash independent of coordinator), so the change is transport and persistence, not protocol: records must be durable on every member that has signed one, must be exchanged and merged on any contact between members, and any holder of a quorum of promises may advance the phase.

Both regimes are the same rule seen from different sizes: a pend is durable, carries a long TTL, and completes when a quorum of its declared cohort has signed. In the large regime that quorum is usually available immediately; in the small one it arrives over time.

# Safety arguments to keep

- A late-arriving member validates the pend's read dependencies against *its current* state at promise time. If a rival transaction has committed meanwhile (possible only in the large regime), the pend is refused as stale and must be rebased by its originator. Nothing is ever committed against a read set that a quorum has not validated.
- A read that observes a tentative (pended, not committed) revision makes the observing transaction tentative too: it cannot complete its promise phase until its base commits. This is the Bayou tentative/committed split and is what keeps the certified history serializable.
- Two long-lived pends that conflict need a deterministic winner (transaction id order, or the priority work in `feat-occ-priority-reservation`); the loser waits for its originator to rebase. Today's conflict race with a fixed short blocker window does not extend to this.
- The quorum denominator must be the declared cohort (`feat-declared-membership-feeds-cohort-assembly`), never the observed one, or two disjoint subsets of the three phones could each commit.

# What the user sees

The commit returns immediately with quorum `local` (from the prerequisite ticket) and a handle. The host can show "pending, 1 of 3 members have signed" and update as promises arrive; the full-replication event moves it to "saved". A pend that expires or loses a conflict surfaces once, with the reason, and the host decides whether to resubmit.

# Use cases to test

- Three-member declared cohort, members online pairwise only (A+B, then B+C, then A+C): a write from A commits without any moment where all three are connected.
- Same, but C commits a conflicting write via B before A's pend reaches C: exactly one wins, the other is reported stale to its originator, no fork.
- Restart every member mid-flight: the pend survives and completes.
- Large network: a partitioned writer's outbox resubmits on reconnect and rebases correctly.

# Arm: the engine can classify the lane per statement (2026-09-14)

The maintainer notes that Quereus can detect, for a given update, whether it is subject to serializability constraints or not. That changes one thing in this design, for the better: the convergent-versus-serializable lane need not be a static declaration on the collection. The engine can attach a classification to each transaction at pend time, and a late signer's re-validation then knows whether it is performing a merge (convergent) or a full read-set check (serializable).

The property to classify is not idempotence but invariant preservation under merge (I-confluence). An idempotent write such as setting a column to a value is *not* convergent on its own, since two concurrent sets need a tie-break; a non-idempotent increment *is* convergent. What the engine can see statically, and which is what matters: whether the statement touches a column under a uniqueness, foreign-key or multi-row check constraint; whether its write depends on a read (a blind insert with a hash-derived key has an empty read set and cannot lose an optimistic-concurrency check); and whether the collection's conflict filter defines a merge for the touched fields. A statement with no constrained columns, no read dependency and a defined merge can be committed locally and merged; anything else takes the quorum lane. The classification should travel inside the signed transaction so every validator applies the same rule, and a validator that disagrees with the classification refuses the pend rather than silently re-classifying.
