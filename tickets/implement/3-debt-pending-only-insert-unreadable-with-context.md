description: A storage node refuses to serve a brand-new record that has been written but not yet finalised whenever the reader asks for it at a specific version — it reports the record as unreadable instead of handing back the pending content. Make the node answer honestly, and keep "unreadable" meaning only what it is supposed to mean.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, docs/internals.md
difficulty: medium
----

# Serve a pending-only block over an absent committed base

## Background in plain terms

A write lands in two steps. First the node stores a *pending* record; later, once the group agrees,
it *promotes* that record into a committed revision. Between the two, a brand-new block has a
pending record and **no committed revision at all**.

A reader asks a storage node for a block in one of two shapes:

- **contextless** — "newest committed content you hold";
- **with a context** — `{ rev, committed, actionId? }`: "content as of revision `rev`, with pending
  action `actionId` applied on top". This is how a writer reads back its own not-yet-finalised
  change, and it is the shape an external peer speaking the repo protocol is free to send.

`StorageRepo.get` has a pending-overlay branch written to serve exactly the second shape over a
block with no committed base. It is unreachable: `ActionContext.rev` is a **required** number, and
`BlockStorage.getBlock(rev)` only tolerates "no committed revision" when `rev` is `undefined` —
with a number it walks the revision log, finds nothing, and throws `Failed to find materialized
block …`. `StorageRepo.get` catches that into `unavailable: 'unmaterializable'`, so the reader is
told the block is unreadable (and `TransactorSource.tryGet` turns that into a thrown
`BlockUnavailableError`) instead of being handed its own pending content.

Locked in today as a `KNOWN GAP:` test in `packages/db-p2p/test/storage-repo.spec.ts:525`.

## The decision — which side is authoritative

**`BlockStorage.getBlock` is wrong and changes; `StorageRepo.get`'s branch shape is right and
stays.**

`unavailable: 'unmaterializable'` has one meaning, and it must keep it: *this node holds records
proving the block exists and cannot reconstruct it* — a `latest` pointer it cannot materialize
(truncated history, failed restore), or a pending it refused to promote for a missing base. A block
with **no committed revision at all** is not that. Nothing is being failed to reconstruct; there is
simply no committed base yet. So `getBlock` must report an **absent base** (`undefined`), not a
fault, whether or not the caller named a revision — and `StorageRepo.get` then applies the pending
overlay over that absent base, which is what its branch already does.

Rejected alternative: leaving `getBlock` alone and having `StorageRepo.get` resolve the pending
overlay *before* deciding a failed base lookup is fatal. That would mask genuine truncation
(`latest` set, materialization gone) behind any pending record that happens to be present, which is
precisely the distinction the `unavailable` flag exists to preserve.

### One thing that must NOT be lost

`packages/db-p2p/test/block-storage.spec.ts:72` ("getBlock for an absent revision fires
restoreCallback (restore not short-circuited)") pins deliberate behaviour: a **pending-only** block
(`meta.latest === undefined`, `ranges: []`) read at a **named revision** still fires
`restoreCallback`, and a successful restore serves real content even though `latest` stays
undefined. That capability stays. Only the *failure* of that restore stops being a throw.

So the split inside `getBlock` when `meta.latest === undefined` is:

- `rev === undefined` → `undefined` (unchanged).
- `rev` named → still call `ensureRevision` (restore may supply the revision). If `ensureRevision`
  throws — no `restoreCallback` wired, or restore could not supply the revision — that means only
  "no committed base here": log and return `undefined`.
- If `ensureRevision` succeeds, call `materializeBlock` and **let its faults propagate**. A throw
  from there means revision records exist with no materialization anywhere below them — genuine
  corruption, and `StorageRepo.get` correctly turns it into `unmaterializable`.

Sketch:

```ts
// in BlockStorage.getBlock, replacing the current `rev === undefined && meta.latest === undefined` arm
if (meta.latest === undefined) {
	if (rev === undefined) return undefined;
	try {
		await this.ensureRevision(meta, rev);
	} catch (err) {
		log('getBlock:no-committed-base blockId=%s rev=%d error=%s', this.blockId, rev, ...);
		return undefined;
	}
	return await this.materializeBlock(meta, rev);
}
const targetRev = rev ?? meta.latest.rev;   // non-null assertion no longer needed
```

## Two regressions the change introduces, which this ticket must also fix

Making `getBlock` return instead of throw means `StorageRepo.get` now *reaches* code it never
reached before. Both of these are required arms, not optional polish.

**1. The overlay branch's "pending not found" throw becomes reachable in a case where it is wrong.**
On a block with no committed base, a context whose `committed` proves an action AND whose `actionId`
names that *same* action: the read-driven promotion refuses (`MissingBaseRevisionError`), and
`refuseMissingBase` **deletes that pending record**; `unavailable` is set. Previously `getBlock`
threw next and the entry came back flagged. Now `getBlock` returns `undefined`, the overlay branch
runs, `getPendingTransaction` finds nothing, and it throws `Pending action X not found` — which is
NOT caught per-block and fails the whole batch.

Fix: in the overlay branch, when the pending is absent **and `unavailable` is already set**, return
`{ state: {}, unavailable }` — this node did hold the record and dropped it, which is an
availability answer, not a caller-contract violation. Keep the throw for the genuine violation (no
refusal happened; the caller asserted a pending this repo never had).

**2. A pending that materializes nothing over an absent base must stay flagged.**
Today the overlay entry flags `unavailable` only when the promotion refusal set it:

```ts
...(unavailable !== undefined && block === undefined ? { unavailable } : {})
```

After the change, a context naming a pending **update** on a block with no committed base reaches
the overlay, `applyTransform(undefined, update)` drops the update, and `block` is `undefined` with
no refusal having fired (e.g. `committed: []`) — so the entry would come back as an *authoritative
absent*, a regression from today's flagged answer. The node holds a pending record proving the block
exists and produced nothing: that is exactly `unmaterializable`.

The condition becomes: flag when `block === undefined` **and** (`unavailable` was set **or**
`blockRev === undefined`), taking `unavailable ?? 'unmaterializable'`. The `blockRev === undefined`
clause is load-bearing and so is its absence in the other direction — a pending **delete** applied
over a real committed base also yields `block === undefined`, and that is an *authoritative*
tombstone that must stay unflagged.

## What stays exactly as it is

- A read where `context` carries no `actionId` on a pending-only block: still `{ state: {} }`,
  unflagged unless a promotion refusal set the flag. It is the same authoritative-absent the
  contextless read gives, and the `createOrOpen` insert probe depends on that answer.
- `unmaterializable` for a `latest` that will not materialize (truncated history, failed restore) —
  `readCommitBase` and the `get — unavailable vs absent` suite in `storage-repo.spec.ts:559`.
- Every other `getBlock` caller: `readCommitBase` and the Crash-D3 emit path in
  `storage-repo.ts:672` only call it with `latest` set, so the new arm is not taken;
  `dispute/cascade.ts:147` and `dispute/invalidation.ts:434` already treat `undefined` as their
  conservative answer (invalidate / delete), so a returned `undefined` in place of a thrown fault is
  strictly better there.

## Edge cases & interactions

- **Pending-only insert, context `{ actionId, rev, committed: [] }` at rev 0, 1 and 2** — served
  identically at every rev; `rev` names a base that does not exist, and there is nothing to pin.
- **`materializedRev` absent** on that answer, because there is no committed base underneath.
  `TransactorSource.tryGet` falls back to `materializedRev ?? state.latest?.rev ?? 0` → records
  revision `0`, which is the honest "no committed revision observed".
- **`state.latest` is `undefined`** on that answer while `block` is populated. Confirm nothing
  downstream reads `state.latest` as a precondition for a populated block —
  `NetworkTransactor.get`'s three-way ranking keys off `block != null` / `unavailable` only, and
  `CoordinatorRepo` read-repair triggers on a *missing* block.
- **Pending delete over a committed base** — `block === undefined`, must stay unflagged.
- **Pending update with no base, no refusal** (`committed: []`) — flagged `unmaterializable`.
- **Pending update with no base, refusal fired on the same action** — the record is gone; return the
  flagged entry, never throw.
- **Caller-contract violation** — `actionId` names a pending this repo never had, on a healthy
  committed block: still throws `Pending action … not found`.
- **Restore succeeds for a pending-only block at a named rev** — real content served with
  `latest` still undefined; `materializeBlock`'s retention decision re-reads metadata fresh
  (`block-storage.ts:403`), so passing the pre-restore `meta` snapshot in is safe, as it already is
  on the committed path.
- **Restore returns an archive with no materialization** — `materializeBlock` throws, propagates,
  `StorageRepo.get` flags `unmaterializable`. Correct: records exist, content does not.
- **Mixed batch** — one pending-only block alongside a wedged block and a healthy block: each gets
  its own answer, `Promise.all` unbroken.
- **Concurrent promotion** — the read-driven promotion still runs under
  `withBlockCommitLatch` before `getBlock`; nothing about this change moves work into or out of that
  latch. A commit landing between the promotion block and `getBlock` simply means `getBlock` sees a
  committed base and takes the normal path.
- **Interaction with `feat-cold-range-transform-offload` (backlog)** — that ticket widens when
  `ensureRevision` restores. The new swallow is scoped to `meta.latest === undefined`, a state that
  ticket does not create (offloading applies to blocks that *have* committed history), so the two do
  not collide.

## TODO

- `packages/db-p2p/src/storage/block-storage.ts` — replace the `rev === undefined && meta.latest
  === undefined` early return with the `meta.latest === undefined` arm described above: contextless
  → `undefined`; named rev → `ensureRevision` inside a try, `undefined` on its throw, otherwise
  `materializeBlock` with faults propagating. Drop the now-unneeded `meta.latest!` assertion.
  Comment must state *why* the restore attempt is kept (the `restore not short-circuited` test) and
  why only `ensureRevision`'s failure is swallowed.
- Add a tripwire at that site: `// NOTE: a contextful read of a pending-only block still attempts a
  network restore before falling back to absent (same cost as the pre-fix throw path); if
  pending-only read-backs ever show as hot, short-circuit when ranges are empty.`
- `packages/db-p2p/src/storage/storage-repo.ts` — in `get`'s overlay branch: return
  `{ state: {}, unavailable }` when the pending is absent and `unavailable` is set, keeping the
  throw otherwise; widen the entry's `unavailable` spread to `block === undefined && (unavailable
  !== undefined || blockRev === undefined)` with `unavailable ?? 'unmaterializable'`.
- `packages/db-p2p/src/storage/storage-repo.ts` — delete the stale `NOTE:` at lines ~284–290
  declaring the branch dead, and the "unreachable today" clause on the `materializedRev` comment at
  lines ~306–309; both describe behaviour this ticket removes. Do not delete the surrounding
  explanations of what the fields mean.
- `packages/db-p2p/test/storage-repo.spec.ts` — rewrite (do **not** delete) the `KNOWN GAP:` test at
  line 525 to pin the new behaviour: pending-only insert read with `{ actionId: 'p1', rev,
  committed: [] }` for rev in `[0, 1, 2]` returns the inserted block, `materializedRev === undefined`,
  no `unavailable`, `state.latest === undefined`, `state.pendings` deep-equals `['p1']`. Keep the
  existing contextless-read assertion (`{ state: {} }`, block undefined) unchanged.
- `packages/db-p2p/test/storage-repo.spec.ts` — add cases for: pending **update** with no base and
  `committed: []` → flagged `unmaterializable`; refusal on the context's **own** `actionId` → flagged
  entry, no throw; pending **delete** over a committed base → absent and **unflagged**; `actionId`
  naming a pending this repo never had on a committed block → still throws `Pending action … not
  found`; a mixed batch pairing a pending-only insert with a wedged block.
- `packages/db-p2p/test/block-storage.spec.ts` — add: pending-only block with **no**
  `restoreCallback`, `getBlock(1)` → `undefined` (was a throw); pending-only block whose
  `restoreCallback` returns `undefined`, `getBlock(1)` → `undefined`; and assert the wedged case
  (`latest` at a rev with no materialization) **still throws** `Failed to find materialized block`.
  Leave the existing `restore not short-circuited` test untouched — it is the regression guard.
- `docs/internals.md` — amend the `unavailable` bullet (~line 503) so "a `getBlock()` throw on
  truncated history / a failed restore" no longer covers a block with no committed revision, and the
  `materializedRev` bullet (~line 542) so "a pending-only insert with no base leaves it absent"
  reads as live behaviour rather than a hypothetical.
- Run `yarn test` from `packages/db-p2p` (there is no per-package `test:<name>` script at root —
  root `yarn test` fans out across every workspace), streaming output with `tee`. Then `yarn build`
  from root. Full `yarn check` (adds `test:integration`, real TCP meshes) is out of agent budget —
  note the deferral in the review handoff.
