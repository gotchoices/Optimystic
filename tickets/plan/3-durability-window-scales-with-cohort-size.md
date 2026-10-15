description: How long a node may leave a write unsynced is computed from how many machines would have to lose it together, so larger cohorts are more relaxed and a write held by one machine is synced before it is reported held. Decided by the maintainer 2026-10-15; build the policy, the window function and the background flush, and make docs/correctness.md Theorem 6 say what the code does.
prereq: storage-flushes-once-per-write-group, file-storage-pays-one-fsync-per-write-group
architecture: docs/correctness.md#theorem-6-durability
files: docs/correctness.md, packages/db-p2p/docs/storage.md, packages/db-p2p-storage-fs/src/atomic-write.ts, packages/db-p2p-storage-rn/src/rn-opener.ts, packages/db-p2p-storage-web/src/indexeddb-storage.ts, packages/db-p2p-storage-ns/src/db.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-core/src/network/struct.ts, packages/db-p2p/src/libp2p-node-base.ts, tickets/backlog/more-design/6.5-partition-healing.md, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/repo/kv-under-replication-ledger.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/src/file-kv-store.ts, packages/db-p2p/readme.md
----

## Decision (maintainer, 2026-10-15) — overrides the rest of this ticket where they differ

"We don't have to get this perfect to start with; make sure the code and docs are consistent and get something built." So:

1. **The window comes from theory, per write**: the formula and rules in "How the theory sets the loss window" below, with the proposed defaults accepted: `p` = one power cut or OS crash per machine per month, `ε` = one lost acknowledged write per 10^9, hard cap 5 s.
2. **Independence is assumed by default.** A deployment can declare that its machines are *not* independent (for example two machines on one circuit), which makes every node strict (`w = 0`). This replaces rule 2 of "How the theory sets the loss window" (undeclared = strict): the maintainer wants relaxed behaviour, phones included, out of the box. Name the option in the plan (proposed: `NodeOptions.storageDurability: { independentFailures?: boolean (default true), lossRatePerHour?, lossTarget?, maxWindowMs? }`).
3. **Two-member cohorts relax** by the formula like any other size.
4. **Phones relax** by the formula, because they need to perform. Where a backend cannot sync at all yet (React Native, until `gotchoices/rn-leveldb` has a sync write), its window is "whenever the OS writes it"; the node logs that once at start and still starts, and the docs state each backend's real guarantee. Backend work is `mobile-and-browser-storage-keep-the-durability-window`.
5. **`w = 0` wherever only one machine would hold the write** (`m = 1`: `CoordinatorRepo.pendSolo` / `commitSolo`, and the shortfall entry `noteReplicationShortfall` records), on every backend that can sync. This follows from the formula, not from a separate rule.
6. **`WriteDurability` unchanged.** The docs say that each holder's copy reaches stable storage within the window its cohort allows.
7. **Option F (relaxed nodes refuse to write alone) is not adopted.** The fork case stays documented, owned by backlog `partition-healing`.
8. **`allowDownsize`** is out of scope here; the docs-versus-code mismatch is `implement/5-allow-downsize-docs-match-the-lone-write-path`.

Where the older "Proposed answer" below says strict by default with background flushing only on declaration, the decision above wins. The implementation notes from the former backlog ticket `feat-a-node-can-be-declared-to-flush-storage-in-the-background` are appended at the end ("Implementation notes"); read their `maxLossMs` as the computed `w`, and their "declared" mode as the default.

## TODO (plan stage)

- Settle the option's name and shape, and write the window function's table (cohort sizes 1–10 at the defaults) into the docs.
- Rewrite `docs/correctness.md` Theorem 6 and §1.2, and `packages/db-p2p/docs/storage.md`, to the decided policy, with a per-backend table of what each actually guarantees.
- Split into implement tickets: (a) the pure window function and option resolution; (b) `StorageRepo` hands each group's deadline to `flush()` and the stores sync by the earliest deadline (file store first); (c) docs. Mobile and browser backends follow in `mobile-and-browser-storage-keep-the-durability-window`.


**Was blocked (category (a): the specification contradicts the code); decided 2026-10-15, see "Decision" below.** `docs/correctness.md` Theorem 6 says log entries are "written via batch write with fsync" and that an acknowledged write is held "in durable storage" by a majority of its cohort; three of the four storage backends make no write survive a power cut. Unblocks when the maintainer accepts or edits the proposed answer below. Raised by GitHub #37 (kjeib), which also asks for one deliberate decision across the fs, rn and web stores.

## Background

### What "holding a write" means to the protocol

Each block is stored by a small group of machines, its **cohort**. Every member applies each agreed change to its own storage and reports whether its storage now holds it. The machine coordinating the write tells the writer "saved" only when more than half of the cohort report holding the revision (the acknowledgement gate in `CoordinatorRepo.commit`, `packages/db-p2p/src/repo/coordinator-repo.ts`, defined under "Commit durability reporting" in `docs/correctness.md` §2), and labels the answer with a class (`DurabilityQuorum` in `packages/db-core/src/network/struct.ts`): `full` (every member), `majority`, `local` (this machine alone — a one-machine group, or a machine whose partners are away) or `unrouted`. Theorem 6 then argues that a saved write survives crashes because the machines counted hold it durably.

### Two kinds of crash

- **Process crash:** the node's process dies or the operating system kills it (common on phones). Data the process had handed to the operating system survives in the OS file cache. Every persistent backend survives this.
- **Power loss or operating-system crash:** power cut, kernel panic, hard reset, battery pull. Only data the OS was told to put on stable storage (fsync or equivalent) survives.

### What each backend does today

| Backend | What a write waits for | Survives a process crash | Survives a power cut |
|---|---|---|---|
| Node files (`db-p2p-storage-fs`) | an fsync of the file and of its directory, for every value (`atomicWriteFile`, `packages/db-p2p-storage-fs/src/atomic-write.ts`); renames and deletes are not directory-synced | yes | yes, except renames and deletes |
| React Native (`db-p2p-storage-rn` over `gotchoices/rn-leveldb` 3.11) | nothing: every put, delete and batch write in `cpp/react-native-leveldb.cpp` uses LevelDB's default `WriteOptions()` (`sync = false`), and the binding offers no sync option | yes | no — LevelDB documents that with `sync = false` "if the machine crashes, some recent writes may be lost" |
| Browser (`db-p2p-storage-web`) | one IndexedDB transaction per write, default durability (`IndexedDBStoreDriver` passes none); the default is "relaxed" in Chrome since 121 and in Firefox and Safari: the write completes once it reaches the OS | yes | no |
| NativeScript (`db-p2p-storage-ns`) | SQLite in WAL mode with `PRAGMA synchronous = NORMAL` (`applySchema`, `packages/db-p2p-storage-ns/src/db.ts`) | yes | no — SQLite documents that a WAL commit under NORMAL "might roll back following a power loss or system crash" |
| Memory | nothing | no | no |

Kyle's reading of the React Native store is right, and the browser and NativeScript stores are in the same state. The file store is the strict one and pays for it: about a second per small commit on macOS, where Node's fsync is a full drive-cache flush (`F_FULLFSYNC` in libuv), and 2–4 times memory speed on Linux ext4 (#37's measurements).

### What a power cut does to a machine that reported holding a write

1. **The only copy.** A write acknowledged `local` — a phone alone, or a machine whose partner is offline — exists on that machine only, and is gone.
2. **A fork, from one machine.** P (a phone) and B (its backup) form a two-member cohort. A write W1 commits revision N of block X on both and is acknowledged `full`. Within the few seconds before P's operating system writes its cache to flash, P loses power. P restarts while B is away; once B is out of P's routing view, P's cohort for X is P alone, so it reads its own copy (revision N−1) and commits alone (`CoordinatorRepo.commitSolo`). The app writes W2, built on N−1, as revision N of X, acknowledged `local`. When B returns, P and B hold different content under one revision. Further writes to X fail (B's content check rejects P's next change, and both members must approve), and P's under-replication drain reports W2 fully replicated, because B accepts the pushed copy as already held by comparing revision numbers (`StorageRepo.saveReplicatedBlock`'s no-op on an equal revision). This is the forked state backlog `partition-healing` describes; losing a write adds a way into it that needs no partition when the write was made — only a power cut and the partner being away at restart.
3. **Several machines at once.** A rival write at the same revision must collect the promise super-majority (three quarters of the cohort, rounded up), and every member still holding the revision refuses it as stale. So the holders that must lose the write together:

| Cohort size | Approvals a rival needs | Holders when acknowledged (minimum) | Holders that must lose it (minimum acknowledgement / `full`) |
|---|---|---|---|
| 2 | 2 | 2 | 2 / 2 |
| 3 | 3 | 2 | 2 / 3 |
| 4 | 3 | 3 | 2 / 3 |
| 5 | 4 | 3 | 2 / 4 |
| 10 | 8 | 6 | 4 / 8 |

A machine that lost a write also heals on its first read of the block if any holder is reachable (a restarted node remembers no reads, so it consults its cohort), so this needs the surviving holders to be unreachable as well. That is the maintainer's observation in numbers: machines far apart rarely lose power within the same few seconds; two machines on one household circuit do it in one outage.

When it does happen in a larger cohort, the rival is signed by two or more members, and so was the lost write's proof on the survivors. A repair pass that meets both proofs logs `certified-equivocation` (`docs/internals.md` describes it as "a key compromise, not a capacity problem") and declines that revision for good: an operator would read a correlated power cut as an attack on the cohort's keys.

4. **What it does not do.** It does not make a machine forget promise votes it would otherwise have kept. Votes are held in memory only — no default wiring supplies `NodeOptions.transactionStateStore` — so every restart already forgets them, and what stops a conflicting write after a restart is what storage holds: pending records (reservations) and committed revisions. That is why the question is storage durability, not vote durability.

### What syncing costs once writes are grouped

`storage-flushes-once-per-write-group` lets storage make a whole group of writes durable with one sync, and `file-storage-pays-one-fsync-per-write-group` uses it for the file store. A machine then syncs about twice per write (applying the pend, applying the commit), three times when writing alone (it also records its shortfall), instead of 72–155 times. #37 measured one fsync at about 20 ms on macOS APFS and under 2 ms on a Linux ext4 VM; phone and browser costs are not measured.

## Maintainer direction (2026-10-15)

"Lean on theory here. The more nodes in a cluster, the more relaxed we can be." This replaces the per-node opt-in below as the *source* of the relaxation: how long a node may leave a write unsynced follows from how many machines would have to lose it at once, which is a function of cohort size (table in case 3). The proposed answer below is kept for its default, its reasoning and its rejected alternatives; read parts 2 and 3 through the section that follows it.

### How the theory sets the loss window

A write is lost only if every holder a rival needs to out-vote loses it within the window `w` in which it sat unsynced. With `m` = the holders that must lose it together (table in case 3, minimum-acknowledgement column), `h` = the holders when acknowledged, and `p` = the rate at which one machine suffers a power cut or OS crash, the chance that a given write is lost is about `C(h, m) · (p·w)^m`, **assuming the machines fail independently**. Holding that below a target `ε` gives the largest safe window:

  `w ≤ (ε / C(h, m))^(1/m) / p`

`m = 1` (a write held by one machine) forces `w = 0` for any useful `ε`: that machine syncs before it reports holding the write. The window grows quickly with `m`: under independence, each extra machine that must fail together multiplies the margin.

Proposed rules, for the maintainer to accept or edit:

1. **Which size.** A member computes `w` from the cohort **this write's consensus ran on** (`record.peers` in the signed `ClusterRecord`), capped at the deployment's declared cohort size (`clusterSize`, or the `clusterPolicy` size the repair floor uses). Not the node's own routing view: the record names the members that will be counted as holders, and the cap stops a coordinator inflating it. A cohort that shrank under partition therefore shrinks `w` with it, down to `w = 0` when the node writes alone, which keeps rule 4 of the proposed answer ("a sole holder syncs first") as a consequence rather than a special case.
2. **Independence is declared, not assumed.** The formula is only valid for machines that fail independently. Two machines on one household circuit fail together, and then `m` is effectively 1. So a deployment declares its failure domain (for example `storageDurability: { independentFailures: true, lossRate, target }`); undeclared means "not independent" and every node stays strict, which is today's documented behaviour. The repository's existing rule for safety-relevant sizes applies: declared by the embedder, never inferred from what the node observes.
3. **Defaults.** `p` defaults to a conservative per-machine rate (proposed: one power cut or OS crash per machine per month), `ε` to one lost acknowledged write per 10^9 writes, and `w` is capped (proposed: 5 s) whatever the formula says, so a misdeclared rate cannot produce an unbounded window. With these numbers a three-member cohort at minimum acknowledgement (`m = 2`) allows a window of the order of a second, a five-member one more, and a two-member cohort (`m = 2`, but `h = 2`) about the same as three. The implementer reports the computed table in the docs.
4. **`WriteDurability` unchanged**, as in part 3 below. `full` and `majority` keep meaning "this many holders"; the docs state that, with declared independence, each holder's copy reaches stable storage within the window its cohort size allows.

Still open for the maintainer: the default `p`, `ε` and cap; the option's name; and whether a two-member cohort may relax at all (the formula allows it under declared independence, but a phone and its backup are the common two-member case and are rarely independent).

## Proposed answer (recommended default)

Text to adopt into `docs/correctness.md` (§1.2 "Nodes", a new paragraph, and Theorem 6) and `packages/db-p2p/docs/storage.md`:

> **Storage durability.** A machine reports that it holds a write — accepts a pend, holds a committed revision, records an under-replication entry — only once that write would survive a power cut or an operating-system crash on that machine, not merely a crash of its own process. Storage makes a whole group of writes durable with one sync, and what survives any crash is a prefix of the writes in the order they completed. This is the default on every platform.
>
> A deployment may declare a node **background-flushing**. Its writes survive a crash of its process at once and a power cut within a declared bound (`maxLossMs`), and it is counted as a holder like any other node: the declaration is the deployment's statement that this machine's failures are independent of the rest of its cohort's, which the protocol cannot observe and never infers. A write that a background-flushing node acknowledges as its only holder is still synced before it is acknowledged, because no other copy can stand in for it.

The parts of that, and what follows from each:

1. **Strict by default on fs, rn, web and ns.** Each backend commits each write group as one atomic, synced native write: the file store's log record and fsync; a LevelDB `WriteBatch` with `sync = true` (the binding has no synchronous write today — a change in `gotchoices/rn-leveldb`, outside this repository); one IndexedDB transaction with `durability: 'strict'` (Chrome 83+, Firefox 126+, Safari 15+); one SQLite transaction under `synchronous = FULL`. Ticket `mobile-and-browser-storage-lose-acknowledged-writes-on-power-loss`.
2. **Background flushing is declared by the deployment, per node** — for example `NodeOptions.storageDurability: { flush: 'background', maxLossMs: 1000 }`, name and default to taste — never derived from what the node observes. This follows the reason `clusterPolicy` sizes are declared: the observed cohort is unauthenticated and shrinks under partition, and the property that makes relaxing safe, independent failures, cannot be observed at all. Ticket `feat-a-node-can-be-declared-to-flush-storage-in-the-background`.
3. **Background holders count toward `majority` and `full`.** They must, or the coordinator would wait for their syncs and background mode would save nothing. `WriteDurability` stays as it is; the docs say that under background flushing `full` means "held by every member, each on stable storage within its declared bound".
4. **No new rule about writing alone.** Case 2 above remains possible for a background-flushing node that then writes alone, and is documented as such. Refusing solo writes is the rule the maintainer decided on 2026-09-15 not to pin at the solo short-circuit (see backlog `partition-healing`); the eventual fix for that forked state is the CRDT-style sync design (`docs/crdt-sync.md`), which can merge both writes because both still exist somewhere.
5. **A backend that cannot yet meet the default** (React Native, until its binding has a sync write) logs at node start what it does provide, and the node still starts.

## Alternatives considered and rejected

- **A. Keep each platform's usual setting: strict on servers, relaxed on phones and browsers** (what LevelDB, IndexedDB and SQLite apps commonly accept). Rejected: phones are where the only-copy loss and the one-machine fork happen, and one sync per group is cheap.
- **B. Sync only writes this machine holds alone (`local`), relax the rest.** Rejected: the fork in case 2 starts from a `full` write the machine lost.
- **C. Derive the policy from the observed cohort size.** Rejected, for the reason given in part 2.
- **D. Sync the protocol's bookkeeping (revision index, `latest`, pending claims) but not block content, and let repair fetch content back.** Rejected: once writes are grouped, one sync covers both at the same cost; and a machine that keeps "I hold N" but lost N's bytes is counted as a holder by the acknowledgement gate, by the lineage question (`IBlockStorage.lineageOf`) and by every repair rule, so it over-reports exactly when it matters.
- **E. Persist promise votes and relax storage.** Rejected as a substitute: votes are already forgotten on every restart, and what blocks a conflicting write after a restart is stored state.
- **F. Make background-flushing nodes refuse to write alone.** Not proposed, because it is the rule the 2026-09-15 decision declined to pin at the solo short-circuit; the maintainer may choose it for this opt-in mode only, which would close case 2 for background nodes at the cost of their availability while isolated. A quarantine after an unclean restart was also considered and rejected: the node cannot know which blocks lost writes, since the lost writes are exactly what it no longer has.
- **G. A third "never sync" mode for development machines.** Not proposed: with one sync per group the default costs a development machine tens of milliseconds per write on macOS, and tests use memory storage. Easy to add later.

## If we do nothing

- React Native, browser and NativeScript nodes keep acknowledging writes a power cut can erase, including the fork in case 2, while `docs/correctness.md` says the opposite.
- The file store still gets cheaper: its two tickets do not wait on this one. What stays open is only whether any node may relax.

## How reversible

- The default is configuration, and the flush seam and the file log are internal; either direction stays open.
- The part hosts build on is what "saved" means to their users. Leaving `WriteDurability` unchanged avoids promising something a later choice must break; a field added later (for example, how many holders were not yet on stable storage) is additive.

## Sub-decisions the maintainer may edit

- The option's name and shape, and the default `maxLossMs`.
- Option F for background-flushing nodes.
- Whether a backend that cannot meet the default should refuse to start rather than log.

## What depends on this

- `storage-flushes-once-per-write-group` and `file-storage-pays-one-fsync-per-write-group` do not: they keep the file store's current guarantees and make them cheap.
- `mobile-and-browser-storage-lose-acknowledged-writes-on-power-loss` (prereq on this ticket).
- `feat-a-node-can-be-declared-to-flush-storage-in-the-background` (prereq on this ticket).


## Implementation notes (from the former backlog ticket)

The relaxed half of `decide-what-a-node-must-have-on-disk-before-it-reports-holding-a-write`; adjust to whatever that ticket settles. GitHub #37 asked for "a durability setting". The maintainer's direction (2026-10-15): "lean on theory — the more nodes in a cluster, the more relaxed we can be." So the loss window is not one declared number per node: it is computed per write from the cohort that write's consensus ran on, under a declared independence assumption (see that ticket's "How the theory sets the loss window").

## What the mode is

A deployment declares that its machines fail independently, with a per-machine failure rate and a loss target (shape and name per the decision; for example `NodeOptions.storageDurability: { independentFailures: true, lossRate, target }`). Undeclared, every node stays strict. Given the declaration:

- For each write group, the node computes its allowed window `w` from the cohort the write's consensus ran on (`record.peers`, capped at the declared cohort size) with the decision ticket's formula, capped at a hard maximum. One pure function, unit-tested against the table the docs publish.
- Writes become visible and survive a process crash when they resolve (every backend already reaches the OS by then), and survive a power cut within `w`.
- `StorageRepo`'s end-of-group flush (from `storage-flushes-once-per-write-group`) becomes a request with a deadline of `w` rather than a wait: the method returns without awaiting the sync, and the store syncs before the earliest outstanding deadline.
- `w = 0` (strict) wherever only one machine would hold the write: `CoordinatorRepo.pendSolo` and `commitSolo` in `packages/db-p2p/src/repo/coordinator-repo.ts`, the shortfall entry `noteReplicationShortfall` records for it, and any cohort the formula gives no window. This falls out of the formula (`m = 1`), not a separate rule.
- The node's reports count toward `majority` and `full` like any other member's. `WriteDurability` is unchanged; the docs state what `full` means for a background-flushing member.
- The node logs its mode and bound once at start.

## Requirements and edge cases

- **Prefix order is kept.** Background syncing must still leave a prefix after a power cut. The file log appends in order and syncs on a timer, which keeps it. LevelDB as vendored by `gotchoices/rn-leveldb` does not: written unsynced, groups left in a log file that LevelDB then switches away from are closed without a sync (`DBImpl::MakeRoomForWrite`), so a power cut can lose an older group while a newer one survives. A backend that cannot keep the prefix is not offered this mode until it can (for LevelDB, a sync of the old log at the switch, in the binding's vendored copy).
- **Order across stores.** Two writes in different stores where the second describes the first — the executed marker `ClusterMember.handleConsensus` writes after an apply, a ledger entry after a commit — must not become durable in the wrong order. Under the default this holds because `StorageRepo` syncs before returning; here, either the stores share one log (the file store's shared log for a common base path) or the describing store syncs only after the described store has. Otherwise a power cut can keep an executed marker whose apply was lost, and the member then skips that transaction forever on redelivery.
- **Bounded memory.** The file store's overlay holds up to `w` of writes; bound it by bytes as well and sync early when it fills.
- **The loss window is a promise.** A sync that cannot keep up (a slow disk) must not let the window grow silently: log it, and sync on the write path once the backlog exceeds the bound.
- **Mixed cohorts** (some members background, some not) need nothing special.
- **The known hazard stays documented, not fixed here:** a background node that loses its last writes and then writes alone forks the collection (case 2 in the decision ticket). Whether to refuse solo writes in this mode is the decision's option F; the general fix for that forked state belongs to backlog `partition-healing` and `docs/crdt-sync.md`.
- Applies per node, so a deployment can run its always-on servers in background mode and its phones under the default.

## Verification

- The power-loss storage double from `mobile-and-browser-storage-lose-acknowledged-writes-on-power-loss`, extended to sync on a timer: a background node that loses power loses at most the writes inside each one's window, always a suffix, and never a write it acknowledged as the only holder.
- One test that a solo commit on a background node is synced before it is acknowledged.
- `packages/db-p2p/readme.md` documents the option, and `docs/correctness.md` (Theorem 6, and §1.2's storage durability paragraph from the decision) states what the class means under it.
