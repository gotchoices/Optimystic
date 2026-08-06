description: A storage node used to refuse to serve a brand-new record that had been written but not yet finalised whenever the reader asked for it at a specific version. It now hands back the pending content instead of reporting the record as unreadable, and "unreadable" keeps its narrower meaning.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/coordinator-repo-unavailable.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair-content.spec.ts, docs/internals.md
difficulty: medium
----

# Serve a pending-only block over an absent committed base — review handoff

## What the change is, in plain terms

A write lands in two steps: the node first stores a **pending** record, then — once the group
agrees — **promotes** it into a committed revision. Between the two, a brand-new block has a
pending record and **no committed revision at all**.

A reader can ask for a block *with a context* — `{ rev, committed, actionId? }`, meaning "content as
of revision `rev`, with pending action `actionId` applied on top". That is how a writer reads back
its own not-yet-finalised change. Previously that read failed on a brand-new block: `getBlock` was
handed a number for `rev`, found no committed revision, and threw; `StorageRepo.get` caught the
throw and reported the block `unavailable: 'unmaterializable'` — i.e. "unreadable" — and
`TransactorSource.tryGet` turned that into a thrown `BlockUnavailableError`.

Now `getBlock` reports "no committed base here" as an **absent base** (`undefined`) rather than a
fault, and `StorageRepo.get`'s pending-overlay branch — which was already written for exactly this
shape and was dead code — applies the pending on top of that absent base and serves the content.
`unmaterializable` keeps its one meaning: *this node holds records proving the block exists and
cannot reconstruct it*.

## What changed, file by file

**`src/storage/block-storage.ts` — `getBlock`.** The `rev === undefined && meta.latest === undefined`
early return became a `meta.latest === undefined` arm:
- `rev === undefined` → `undefined` (unchanged).
- `rev` named → `ensureRevision` inside a `try`. Its **failure** (no `restoreCallback` wired, or the
  restore could not supply the revision) is swallowed to `undefined` — that is precisely "no
  committed base here". Its **success** falls through to `materializeBlock`, which is deliberately
  outside the `try` so its faults still propagate: revision records with no materialization under
  them is genuine corruption.
- The `meta.latest!` non-null assertion on the normal path is gone.
- A `NOTE:` tripwire sits at the site (see *Tripwires* below).

**`src/storage/storage-repo.ts` — `get`'s pending-overlay branch.** Two arms, both required
because the branch is now *reachable*:
- Pending absent **and `unavailable` already set** → return `{ state: {}, unavailable }` instead of
  throwing. This is the case where the read-driven promotion refused (`MissingBaseRevisionError`)
  and `refuseMissingBase` **deleted that same pending record**. The throw is NOT caught per-block,
  so leaving it would fail the whole batch. The throw is kept for the genuine caller-contract
  violation (no refusal happened; the caller named a pending this repo never had).
- The entry's `unavailable` flag now fires when `block === undefined` **and** (`unavailable` was set
  **or** `blockRev === undefined`), taking `unavailable ?? 'unmaterializable'`. Without the
  `blockRev === undefined` clause a pending *update* over an absent base would come back as an
  *authoritative absent* — a regression, since the node holds a record proving the block exists and
  produced nothing. The clause's **absence** in the other direction is equally load-bearing: a
  pending *delete* over a real committed base also yields `block === undefined`, and that is an
  authoritative tombstone which must stay unflagged.
- The stale `NOTE:` declaring the branch dead, and the "unreachable today" clause on the
  `materializedRev` comment, are gone.

**`src/repo/coordinator-repo.ts` — `flagUnconfirmedAbsence` (NOT in the original ticket; see
*Regression found beyond the ticket* below).** Its guard was `!entry.state?.latest && entry.unavailable === undefined`.
It now also requires `entry.block === undefined`. Its sibling `promoteCorroborated`'s doc comment
was updated to describe the new shape.

**`docs/internals.md`** — the `unavailable` bullet (~line 503) and the `materializedRev` bullet
(~line 542).

## Regression found beyond the ticket, and fixed here

The ticket asked me to *confirm* that nothing downstream reads `state.latest` as a precondition for
a populated block. One site does, and it broke.

`CoordinatorRepo.flagUnconfirmedAbsence` downgrades an absence the cohort consult could not confirm
to `unavailable: 'peers-unreachable'`. Its own docstring says it no-ops "once the entry carries a
real answer" — but it tested that as `!entry.state?.latest`, which worked only because `block` and
`state.latest` used to move together. A pending-only insert served through the overlay has real
**content** and `state.latest === undefined`, so an inconclusive consult would have flagged a block
the node is positively holding. That is not merely cosmetic: `NetworkTransactor`'s `isAuthoritative`
keys off the flag **alone** (`resp[bid]!.unavailable === undefined`, network-transactor.ts:171), so
the batch would count as unanswered and burn its retry budget re-asking other peers for content it
already had. `rankOf` and both `BlockUnavailableError` throw sites do check `block != null`, so
nothing would have *thrown* — the cost was wasted retries, not a wrong answer.

Fixed by adding `entry.block === undefined` to the guard. `state.latest` stays in the test too, so a
stale-but-real committed answer is likewise never downgraded.

I deliberately did **not** change `isMissing = !localEntry?.state?.latest` (coordinator-repo.ts:345).
A pending-only block still triggers a cohort consult — identical to its pre-change behaviour, and
defensible on its own terms (this node holds no committed revision; a cohort peer might).

## Use cases to exercise when reviewing

Grouped by what they prove. Everything here has a test; the point of listing them is so a reviewer
can attack the boundaries rather than re-derive them.

**The thing the ticket is about**
- Pend an insert for a fresh block; do NOT commit. Read with `{ actionId, rev, committed: [] }` for
  `rev` in `[0, 1, 2]`. Expect: the inserted block, `materializedRev === undefined`, no
  `unavailable`, `state.latest === undefined`, `state.pendings` deep-equals `[actionId]`. All three
  revs answer identically — the rev names a base that does not exist, so there is nothing to pin.
- The **contextless** read of that same block still returns `{ state: {} }` with no block. The
  `createOrOpen` insert probe depends on that answer; it must not change.

**The two arms that only became reachable because of this change**
- Pending **update**, no committed base, `committed: []` → block absent, flagged
  `unmaterializable`, `materializedRev` absent. (No promotion refusal fires here — the flag comes
  from the new `blockRev === undefined` clause.)
- A context whose `committed` proves an action AND whose `actionId` names that **same** action, on a
  block with no base → the promotion refuses, the pending record is deleted, and the read returns a
  **flagged entry** rather than throwing `Pending action … not found`.

**The boundaries that must NOT move**
- Pending **delete** over a real committed base → block absent, **unflagged**, `materializedRev`
  still reports the base. An intended tombstone is an authoritative absent.
- `actionId` naming a pending this repo never had, on a healthy committed block → still throws
  `Pending action … not found`.
- A `latest` pointing at a revision with no materialization (truncated history) → `getBlock` **still
  throws** `Failed to find materialized block`, contextless and pinned alike, and the repo still
  flags `unmaterializable`.
- A pending-only block whose restore **succeeds but supplies no materialization** → the throw
  propagates out of `materializeBlock`. This is the narrow seam: only `ensureRevision`'s failure is
  swallowed.
- A pending-only block read at a named rev with a `restoreCallback` that CAN supply the revision →
  real content served, `latest` still undefined. Pinned by the pre-existing
  `restore not short-circuited` test, which I left untouched — it is the regression guard for the
  restore attempt surviving.
- Mixed batch: a pending-only insert alongside a wedged block → each gets its own answer,
  `Promise.all` unbroken.

**The coordinator seam**
- A pending-only insert served with content, whose cohort consult throws → entry keeps its block,
  `state.latest` stays undefined, and it is **not** flagged `peers-unreachable`.

## Testing done

`yarn test` from `packages/db-p2p`: **1555 passing, 44 pending, 0 failing** (~1m). `yarn build` from
the repo root: clean.

I verified the new tests actually guard the change rather than merely passing alongside it, by
temporarily reverting each fix and re-running:
- Pre-fix `getBlock` (no swallow) → 4 failures: both new pending-only `block-storage` cases, the
  rewritten pending-only-insert `storage-repo` case, and the mixed-batch case.
- Pre-fix `flagUnconfirmedAbsence` guard → the new coordinator case fails.
Both files were restored from backup and the full suite re-run green afterwards; `grep -c TEMP-REVERT`
over both source files returns 0.

## Known gaps — where to push hardest

- **`test:integration` was not run.** Real TCP meshes; out of agent budget per the ticket. Nothing
  in the diff is transport-shaped, but the repo protocol is the wire format for exactly these
  fields, so a mesh run is the honest confirmation that a *remote* peer speaking the repo protocol
  gets the served pending-only insert rather than the old flag.
- **Two of the new `storage-repo` tests pass before AND after the `getBlock` change** — the pending
  **update** case and the refusal-on-own-`actionId` case reach the same answer by a different route
  pre-fix (the throw) and post-fix (the overlay). They do guard the two new `storage-repo.ts` arms
  (I reasoned through each: remove arm (a) and the refusal case throws; remove arm (b) and the
  update case comes back unflagged), but I did not run those two reverts, only reasoned them.
  Worth a skeptical pass.
- **`materializedRev === undefined` → `TransactorSource` records revision `0`** via its
  `materializedRev ?? state.latest?.rev ?? 0` fallback. The ticket calls that the honest "no
  committed revision observed", and I did not test the read-dependency/validator behaviour that
  follows from recording `0` — only that the field is absent on the entry. If a reviewer wants one
  more test, that is where I would put it.
- **`isMissing` in `CoordinatorRepo.get` still keys off `state.latest`**, so a pending-only block
  served with content still triggers a cohort consult on every read through a coordinator. Unchanged
  from before, and arguably right, but it is a `state.latest`-as-proxy-for-block site that survived
  and a reviewer may disagree with leaving it.
- **One pre-existing test had to change its assertion.**
  `coordinator-repo-read-repair-content.spec.ts` → "falls through to acquisition when no local
  promotion can reach the revision" asserted `cluster-fetch:promote-unavailable` was logged. That
  read is no longer a fault, so the tag is no longer emitted; the test now pins the OUTCOME (no
  `cluster-fetch:error`, acquisition supplies the revision, latest advances to 2). To keep the
  step-over itself covered I added a sibling test that wedges B's `latest` at an unmaterializable
  revision — a shape that IS a fault — and asserts the tag still fires and still does not abort the
  pass. A reviewer should decide whether that substitution preserves the original intent.

## Tripwires parked (see `## Review findings` for the index)

- `block-storage.ts`, inside the new `meta.latest === undefined` arm:
  `// NOTE: a contextful read of a pending-only block still attempts a network restore before
  falling back to absent (same cost as the pre-fix throw path); if pending-only read-backs ever show
  as hot, short-circuit when ranges are empty.`
