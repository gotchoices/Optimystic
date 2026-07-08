description: A batch of small storage-layer fixes — stop code from reordering its caller's list, clone objects before storing them, keep a restoration metric honest and hand out copies of it, hash a real peer id instead of a fake one, inject the node's own id instead of casting into another library's internals, and treat "couldn't read the folder" differently from "folder is empty."
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/memory-storage.ts, packages/db-p2p/src/storage/restoration-coordinator.ts, packages/db-p2p/src/storage/ring-selector.ts, packages/db-p2p/src/storage/arachnode-fret-adapter.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/reference-peer/src/cli.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/memory-storage.spec.ts, packages/db-p2p/test/restoration-coordinator.spec.ts, packages/db-p2p/test/ring-selector.spec.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts
difficulty: medium
----

# Review: assorted storage-layer correctness & cleanliness fixes

Six independent storage-layer defects were fixed. All source changes build; every touched
and new test passes. This handoff is the reviewer's map: what changed, how to exercise it,
and where the honest gaps are.

## What was changed (per defect)

**1. In-place sort mutating caller state — `storage-repo.ts:165`.** The context-driven promotion
loop in `get()` sorted `missing` in place; when the block has no committed `latest`, `missing`
*aliases* the caller's `context.committed` array, so the sort reordered shared request state.
Fixed by sorting a copy: `[...missing].sort(...)`.

**2. Missing clone in `saveTransaction` — `memory-storage.ts:102`.** Every sibling writer in
`MemoryRawStorage` clones on store; `saveTransaction` was the lone exception, storing the caller's
reference. Fixed to `structuredClone(transform)`, matching `savePendingTransaction` /
`saveMaterializedBlock` and the file's own `@pitfall` docs.

**3. Dead metric + reference-leaking getter — `restoration-coordinator.ts`.**
  - `failureByRing` was declared but never incremented. **Decision: kept and now incremented**
    (a `recordFailure(ringDepth)` helper) once per ring that was queried during a `restore()` and
    yielded nothing — at the point the my-ring peer loop finishes without returning and at the end
    of each inner-ring iteration. The ring (not the per-peer query) is the failure unit.
  - `getMetrics()` did `return { ...this.metrics }`, leaking the live `successByRing` /
    `failureByRing` Map instances. Fixed to return `new Map(...)` copies of each.

**4. Fake `PeerId` was a live crash — `ring-selector.ts:95`.** `calculatePartition` passed
`{ toString: () => peerId } as any` to `hashPeerId`, which actually reads
`peerId.toMultihash().bytes` — so it threw `TypeError: peerId.toMultihash is not a function` for
**any ring depth ≥ 1**. Fixed to `hashPeerId(peerIdFromString(peerId))` (new import from
`@libp2p/peer-id`). The `ring-selector.spec.ts` tests that wrapped every `calculatePartition`
call in a swallow-the-error `try/catch` were rewritten to generate **real Ed25519 peer-id
strings** and assert a defined partition — they now genuinely fail if the function throws.

**5. `as any` into FRET internals — `arachnode-fret-adapter.ts:59`.** `getMyArachnodeInfo` reached
into the concrete impl's private `.node.peerId`. Fixed by adding an optional
`selfPeerId?: string` constructor param, used first, with the private-`.node` read kept only as a
fallback (narrowed to a named local type + comment, no bare `as any`). Both construction sites now
inject the id: `libp2p-node-base.ts:872` (`node.peerId.toString()`) and
`reference-peer/src/cli.ts:160` (`node.peerId?.toString()`). Test construction sites keep the
single-arg form (param is optional) and still pass.

**6. `readdir` swallowed all errors as "no pendings" — `file-storage.ts:70`.**
`listPendingTransactions` mapped *any* `readdir` failure to `[]`, so a transient EACCES/EIO looked
like an empty directory and `pend`'s conflict detection was silently skipped. Fixed to rethrow when
`code !== 'ENOENT'` (mirrors `directoryByteSize`). Also: a `.json` file whose id doesn't match the
legacy-UUID / `tx:`/`stamp:` regex is now `log()`-skipped instead of silently dropped (the regex
itself is unchanged — the `.json`+decode guard still excludes stray files).

## How to exercise it (tests added)

- **#1** `storage-repo.spec.ts` → "does not mutate the caller context.committed array when the block
  has no committed latest" — builds a non-ascending `context.committed`, calls `get()`, asserts
  order **and element identity** unchanged.
- **#2** `memory-storage.spec.ts` (new file) → saves a transform, mutates the caller's reference,
  asserts the stored value is untouched.
- **#3** `restoration-coordinator.spec.ts` → (a) mutate the Maps returned by `getMetrics()` and
  assert a later snapshot is unaffected; (b) drive a restore where every ring is exhausted and
  assert `failureByRing` holds one count per tried ring.
- **#4** `ring-selector.spec.ts` → real peer-id strings; `calculatePartition(ringDepth≥1, …)` now
  asserted to resolve to a bounded partition. **These fail on the pre-fix code** (the throw is no
  longer swallowed).
- **#6** `file-storage.spec.ts` → ENOENT → empty listing; injected non-ENOENT (EACCES) → **rejects**;
  plus a positive case that a recognized `tx:` pending id still lists.

## Validation performed

- `yarn build` (tsc) passed for **db-p2p**, **db-p2p-storage-fs**, **reference-peer**.
- `db-p2p` targeted specs: `ring-selector`, `restoration-coordinator`, `storage-repo`,
  `memory-storage` → **69 passing**.
- `db-p2p` adjacent unit specs (exercise the changed src + the `ArachnodeFretAdapter` constructor):
  `block-storage`, `empty-state-contract`, `mid-ddl-crash`, `rebalance-monitor`,
  `rebalance-reaction`, `unify-tracked-block-set` → **54 passing**.
- `db-p2p-storage-fs`: `file-storage.spec.ts` → **11 passing**.

## Honest gaps for the reviewer

- **The full `db-p2p` suite was NOT run under this ticket.** It contains heavy mesh / cohort-scale /
  real-libp2p specs with real wall-clock cost (10-min idle-timeout risk for an agent). I ran the
  directly-affected specs plus the adjacent unit specs that construct `ArachnodeFretAdapter` and
  exercise memory/storage-repo. A reviewer with more time budget should run the whole `db-p2p`
  and `db-p2p-storage-fs` suites (and the gated `*.integration.spec.ts` if desired) to confirm no
  wider ripple — especially anything downstream of `libp2p-node-base.ts` node bring-up.
- **`failureByRing` semantics are a judgment call.** A ring with **zero** candidate peers still
  counts as one "failure" (the loop completes without returning). That's intentional and documented
  at the call sites, but if you want the metric to mean strictly "peers were dialed and none had
  it," the empty-ring case would need to be excluded. Flagging for a second opinion, not a code
  change I'd insist on.
- **`reference-peer/src/cli.ts` `node` is typed `any`** at that call site, so `node.peerId?.toString()`
  is untyped-but-safe. Unrelated pre-existing: tsc language-server flags "unreachable code" at
  `cli.ts:665` (not touched by this ticket; `yarn build` still passes).
- **Duplicate backlog ticket.** `tickets/backlog/bug-arachnode-partition-hashpeerid-throws.md`
  describes exactly defect #4 (the `hashPeerId` throw) and is now **resolved by this fix**. I did
  not touch it (backlog is the human's inbox to curate) — the reviewer/human should close or drop
  it to avoid re-doing the work.

## No tripwires filed as tickets

The only conditional concern (empty-ring `failureByRing` counting) is documented inline at the
call sites and surfaced above; it's a metric-semantics decision, not latent breakage.
