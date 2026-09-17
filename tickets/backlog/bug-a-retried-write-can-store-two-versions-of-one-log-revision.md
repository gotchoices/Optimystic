description: When a write is retried, the record it adds to the log is rebuilt with a new timestamp, so two machines can end up storing different bytes for what is supposed to be the same saved revision of the same block.
files:
  - packages/db-core/src/collection/collection.ts (`syncAttempts` — rebuilds the log entry on every attempt; `syncInternal` — where the per-write action id is minted once)
  - packages/db-core/src/log/log.ts (`addActions` — `timestamp` defaults to `Date.now()`; the parameter already exists)
  - packages/db-core/src/transaction/coordinator.ts (`applyActionsToCollection` — same rebuild on every `commitOnce`)
  - packages/db-p2p/src/storage/storage-repo.ts (`pend` — the own-revision carve-out that skips a member already holding the revision, and saves the NEW transform on a member that does not)
difficulty: medium
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The only difference between the two versions is a timestamp inside a log entry, nobody has observed a failure caused by it, and the window needs a write whose log record reached only some machines followed by a retry that did not notice — so a maintainer could reasonably wait for evidence that anything downstream actually trips on it.
----

# A retried write can store two different versions of one log revision

## Background

A write adds a record ("log entry") to its collection's log. The entry carries the write's action id, the actions, the blocks it touched, and a **timestamp taken at the moment the entry is built**.

A write that is refused is retried under the **same action id**. If nothing else was committed in between, the retry also asks for the **same revision**. Each retry rebuilds the log entry from scratch, so each retry's entry carries a **different timestamp** — and therefore the log block it produces has different bytes.

Storage identifies a saved block revision by `(action id, revision)`. It deliberately accepts a retry of the same action at the same revision: a machine that already stored that revision treats the retry as already satisfied and keeps what it has, while a machine that does not hold it yet stores what the retry sent.

## The defect

Put those together. A write's first attempt stores its log block on **some** machines and is then refused (this is normal: the commit is refused whenever fewer than a majority hold the revision, even though some do). The retry rebuilds the entry with a new timestamp and sends it at the same action id and revision:

- a machine that already holds the revision keeps the **first** attempt's bytes;
- a machine that did not hold it stores the **second** attempt's bytes.

Both now report the same `(action id, revision)` for that log block, with different content.

Expected: every machine that stores a given `(action id, revision)` of a block stores identical bytes.

## What is and is not covered today

Ticket `a-write-whose-log-entry-landed-alone-is-reported-saved` closed the neighbouring case: when the retry's refresh **finds** the write's own log entry, it re-sends the refused attempt **verbatim** (the retained transforms, not a rebuild), precisely to avoid this. See `Collection.completeOwnEntry` and the comment on `Collection.inFlightAttempt`.

This ticket is the case that path does not reach: the refresh does **not** find the entry, so the ordinary retry runs and rebuilds. Two ways that happens:

- the refresh read from a machine that had not stored the log block;
- the collection is brand new and its header block was among the blocks the refused commit left behind, so the log cannot be reached at all (`packages/db-core/test/collection-own-action-replay.spec.ts`, "an invented collection whose first sync lands only its log tail still ends up whole", drives exactly this retry — on a single in-memory store, where the divergence cannot show).

## Status of the evidence

Inferred from reading the code; not observed. What would confirm it: on the mesh harness, land a tree write's log tail on one member only, make the writer's refresh miss it, let the retry succeed, then read that log block's bytes at that revision directly from each member's storage and compare. If they differ, also check whether anything that compares content notices — the per-block content digests a commit declares, the proof back-fill in `StorageRepo.commit` (it keeps a proof only when the digest matches), and block repair, which labels content by `(action id, revision)`.

## Direction

The root cause is that a write's log entry is not a fixed function of the write: it changes every time it is rebuilt. The action id is already minted once per write and reused across attempts for exactly this kind of reason; the entry's timestamp is the one remaining per-attempt value. `Log.addActions` already takes a `timestamp` parameter, so minting it once alongside the action id and passing it on every attempt makes a same-revision rebuild byte-identical. The multi-collection path would need the same (its transaction stamp already carries a creation time).

One sub-case that would remain: when an attempt has to start a NEW log block, that block's id is random per attempt, so the retry's tail is a different block entirely and the first attempt's is left as an unreferenced orphan rather than a second version of anything.
