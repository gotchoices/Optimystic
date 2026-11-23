description: Every machine that coordinates a write now saves a full copy of that write's agreement record three times per message, and two of those three copies are for situations it can never pick back up after a restart — so most of the extra disk traffic buys nothing.
architecture: packages/db-p2p/docs/cluster.md#commit-retry-loop
files: packages/db-p2p/src/repo/cluster-coordinator.ts (`persistCoordinatorState` and its `NOTE:`, `recoverTransactions`, `armRetry`), packages/db-p2p/src/cluster/i-transaction-state-store.ts (`PersistedCoordinatorState`), packages/db-p2p/src/cluster/persistent-transaction-state-store.ts, packages/db-p2p/test/transaction-state-store.spec.ts, packages/db-p2p/test/cluster-coordinator.spec.ts
difficulty: medium
tradeoffs: None of these writes is on a request's latency path — nothing awaits them — so a maintainer may reasonably say bytes on a local store are the cheapest thing a consensus round spends and leave the measured figure alone; and the change touches what a restart can see, which is behaviour on the one path crash recovery exists for.
----

# The coordinator writes its whole record for phases it can never resume

## Background, for a reader with no context

When a machine coordinates a write, it saves a record of the agreement in progress so that if it restarts it can pick up where it left off. The record is saved at three moments in each round of messages, and each save stores the whole agreement — every participant's approval and signature so far — not just what changed.

Only one of those three moments is one a restart can actually resume from: the moment the write has been agreed and the coordinator is still re-sending it to machines that missed it. The code that runs after a restart reads the other two, sees they cannot be continued, and deletes them. So two of every three saves are written, read once, and thrown away.

## What it costs — measured

Measured during the review of `a-node-keeps-its-transaction-state-where-it-keeps-the-rest`, on two real nodes over TCP at the default cohort size, writing one row of a `Tree` (which is two cluster messages). Both the key-value store and the block store were counted in the same unit — the UTF-8 byte length of each stored value plus its key, since both encode values as JSON. Two runs agreed to within 4 bytes:

| | key-value writes (agreement state) | block-store writes |
|---|---|---|
| the coordinating machine | 9 writes, 16,871 bytes (+4 deletes) | 12 writes, 6,334 bytes |
| a machine that only participates | 2 writes, 162 bytes | 12 writes, 6,334 bytes |

Per message on the coordinating machine: three `coordinator/` writes (`promising`, `committing`, then the commit-broadcast round), one `participant/`, one `executed/`. Each `coordinator/` copy is larger than the last as approvals and signatures accumulate — 2,382 → 2,906 → 3,200 bytes for the first message, 1,669 → 2,193 for the second.

So one row write puts about 23.2 KB on the coordinating machine's disk where it put 6.3 KB before this state was kept at all: **about 3.7×**. A machine that only participates pays 2.6% (two 81-byte markers). The cost is concentrated entirely on whichever machine coordinates, and roughly two thirds of its share is for the two phases a restart deletes.

The figure and this suggestion are recorded as a `NOTE:` at `persistCoordinatorState`, so the measurement survives whatever is decided here.

## What to change

The root site is `persistCoordinatorState` in `packages/db-p2p/src/repo/cluster-coordinator.ts`, together with the phase list `recoverTransactions` in the same file acts on — the two have to agree, which is why they are one ticket.

Two shapes are worth weighing, and the ticket is not asking for a particular one:

- **Write only what a restart can act on.** Today that is the commit-broadcast phase alone. Do not hard-code that phase name: `backlog/1.4-dispute-commit-path-block` wants a `disputed-waiting` phase recorded here too, so the resumable set is expected to grow. Derive what is written from one declaration of which phases recovery resumes, so a phase added later cannot be silently dropped.
- **Write a phase marker plus a delta rather than the whole record.** Keeps every phase observable (useful for an operator reading the store after a crash) and still removes most of the bytes, at the cost of a reassembly step on the recovery path.

Worth knowing while choosing: `getCoordinatorState` and `getParticipantState` — the single-hash readers on `ITransactionStateStore` — have **no production callers**. Only `getAllCoordinatorStates` and `getAllParticipantStates` are used, both by the recovery passes. So nothing outside recovery reads what is written here, and nothing but a spec would notice a narrower record.

## Expected behaviour afterwards

- A restart resumes exactly what it resumes today: a commit broadcast that had not finished, plus any phase the resumable set has since grown to include.
- The bytes a coordinating machine writes per cluster message fall to roughly the one copy recovery uses, measured the same way as above and reported in the same table shape, so the two figures are comparable.
- A phase that recovery cannot resume costs no write, or one bounded marker — not a full copy of the agreement.
