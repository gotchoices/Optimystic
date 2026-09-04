description: A block can get permanently stuck refusing every write because of a leftover "write in progress" marker, and until now the logs described each refusal as an ordinary lost race — indistinguishable from healthy contention. The node now says the real condition out loud, once, so an operator can find it by searching the logs.
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/stuck-reservation-named.spec.ts, docs/repository.md, tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md
----

# What landed

One new diagnostic, `coordinator-repo:stuck-reservation`, emitted once per episode by
`CoordinatorRepo` when a block's pending-conflict refusals stop being explicable as a lost race.

A block is reserved by an unresolved pending write for the span between that write's pend and its
commit or cancel; while the reservation stands, every other writer is refused. That refusal is
normal. The unhealthy case has the identical per-refusal shape and differs only in **repetition
against an unchanged holder**: a healthy holder releases the block within its own pend-to-commit
window, so only a bounded number of other writers can lose to it before it changes hands, whereas a
stranded record refuses distinct, unrelated writers forever. The counter is therefore **distinct
refused action ids per (block, holder set)** — not elapsed time (a slow writer is not a stuck one)
and not raw refusal count (a retrying writer reuses one action id for the whole sync cycle).

The pieces, all in `packages/db-p2p/src/repo/coordinator-repo.ts`:

- `StuckReservationWatch` plus a dedicated `stuckReservations` LRU (1000 entries) — per-block episode
  state: the sorted holder action ids, the distinct action ids they have refused, and a say-once
  flag.
- `STUCK_RESERVATION_DISTINCT_ACTIONS = 8`, calibrated against a measured healthy figure of 2.
- `stuckReservationMessage` — operator prose in the register of the existing
  `cohortTooSmallMessage` / `soleHolderMessage`: what is stuck, the only two things that clear it
  (a cancel for that action id, or that action's own commit landing), that nothing on the node
  expires it, and that the line is a diagnosis and never a control path.
- `noteStuckReservation`, called from `classifyPendingConflictRejection`; `clearStuckReservations`,
  called from a pend the blocks accepted and from a cancel for the holding action.
- `pend` split into the responsibility check plus a private `pendThroughCluster` holding the
  unchanged cluster body.
- `coordinator-repo:pend-conflict-classified` gained `distinctRefusedActions`, carried on *every*
  classification so a healthy deployment's real figure is readable from its own logs.

Plus `packages/db-p2p/test/stuck-reservation-named.spec.ts` (now **4 tests**) and a paragraph in
`docs/repository.md` under "A pending record's lifetime is bounded by its writer".

The counter is deliberately inert. Deciding when a durable pending record may actually be *removed*
stays with backlog `debt-unpromotable-pending-records-need-a-sweep`, whose whole difficulty is that
deleting a live reservation is worse than the leak.

# Review findings

## Verification

Run at review, from the repo root, all in the foreground:

- `yarn lint` — clean.
- `yarn lint:docs` (`scripts/check-doc-citations.mjs`) — 45 documents, 73 anchored citations, 576
  file mentions, 311 links, all resolve. **The implement stage did not run this**, and it is the
  script that validates the symbol-and-path citations that change added to `docs/repository.md`. It
  passed both before and after the review's own doc edits, so nothing was broken — but it belongs in
  the verification list for any change that touches `docs/`.
- `yarn build` — clean. `yarn typecheck` — clean.
- `yarn test` (all packages) — **0 failing**. `db-p2p`: 2527 passing, 49 pending (2526 before the
  test added below). No pre-existing failures surfaced, so no `.pre-existing-error.md` was written.
- `yarn test:integration` not run: env-gated on real TCP meshes, and nothing here touches transport.
  Same deferral the implement stage made, for the same reason.

## What was checked

The implement diff read first and in full, before the handoff summary. Then: the mechanism's own
claims re-derived from source rather than taken on trust (action-id minting in
`db-core/src/collection/collection.ts`, `LruMap` recency semantics in
`db-core/src/utility/lru-map.ts`, the sibling diagnostic `reportRepairDeadlock` in the same file,
every `pend` / `cancel` return path that could bypass the new clear); the threshold's arithmetic;
the four documents that mention this subsystem (`repository.md`, `internals.md`, `debugging.md`,
`transactions.md`); the file's size trajectory; and a grep of every open ticket stage for prior
claims on the touched paths.

## Confirmed correct — the things most likely to have been wrong, and were not

Stated rather than left silent, because each was a plausible defect:

- **No LRU starvation.** `noteStuckReservation` reuses the existing watch object without calling
  `set`, which would strand the entry at its original recency in a naive LRU. `LruMap.get` refreshes
  recency on read, so the entry rides forward. `clearStuckReservations` correctly uses `peek` so an
  observation pass does not reshape eviction order.
- **No bypass of the clear.** Every `pend` return now routes through `pendThroughCluster`, and the
  extraction is faithful — `verifyResponsibility` and the block-id computation stayed in `pend`, and
  the moved body is unchanged.
- **The say-once flag cannot wedge.** A holder change starts a fresh episode via `sameHolders`, so a
  reported episode can never silence a genuinely new one.
- **The distinct-action premise holds.** `Collection.syncInternal` mints 16 random bytes once per
  sync cycle and `syncAttempts` reuses that id for all of its retries, so a retrying writer really is
  one entry in the set. Verified in source, not assumed.

## Findings fixed in this pass

- **The detection call sat inside a log payload.** `distinctRefusedActions:
  this.noteStuckReservation(...)` made the counter — the entire mechanism — an expression inside a
  `this.log(...)` argument. `debug` evaluates eagerly today so behaviour was correct, but this repo
  demonstrably gates log payload construction on `log.enabled` (`Collection.advanceContext` does
  exactly that), and the sibling `reportRepairDeadlock` deliberately keeps its say-once bookkeeping
  *outside* its own log call. A future gate added here would have silently killed detection with no
  test failing. Hoisted to its own statement, with the reason recorded at the site.
- **The clear's comments overstated what it does.** Both `pend`'s inline comment and
  `clearStuckReservations`' doc read as though forgetting an episode is what re-arms the line for a
  later wedge. It is not: a later wedge has a different holder, and `sameHolders` starts a new
  episode whether the stale entry is there or not. Since action ids never repeat, **neither call site
  has any observable effect through the public surface** — which is also why no spec can cover them,
  and why deleting them would not fail a test. They are worth keeping as LRU hygiene (a settled
  episode occupying a slot can only evict a live one), so both were kept and both comments were
  rewritten to say that plainly instead of claiming behaviour they do not have.
- **The threshold's stated bound was imprecise.** "At most (concurrent writers − 1) distinct actions"
  is wrong in one direction: a single writer whose sync exhausts its retry budget is re-driven by its
  caller with a *fresh* action id, so one writer can contribute several. Measured the consequence
  rather than hand-waving it — a cycle only ends in exhaustion after `DefaultMaxAttempts` (10)
  attempts of backoff, roughly 21s, so a lone writer needs a holder to keep a block for upwards of
  two and a half minutes to reach 8 alone. The bound is distinct *sync cycles*, and the margin
  survives; both facts are now in the constant's doc comment.
- **Two documentation defects.** `docs/repository.md` and a code comment both credited `syncAttempts`
  with minting the action id; `syncInternal` mints it and `syncAttempts` reuses it. And the new
  paragraph promised an operator a line it cannot see by default — every diagnostic in this package
  goes through `debug` — so the paragraph now names the namespace to enable
  (`DEBUG='optimystic:db-p2p:coordinator-repo*'`) and links `debugging.md`.

## Findings fixed by adding a test

- **Per-block grouping was untested.** `noteStuckReservation` groups rivals by block and can name
  several blocks from one refusal, but every existing arm refused exactly one block per pend, so the
  grouping never ran with more than one entry. This is not a hypothetical shape: the wedge is
  *produced* by a torn commit, and one torn commit strands every sibling it left behind — the
  existing fixture just narrows it to one for readability. Added a fourth test that seeds three
  blocks, strands two of them under one action, and drives the threshold with writers that want both:
  it asserts both stranded blocks are named, exactly once each, each carrying its own count and the
  holding action, and that the sibling that *did* commit is never named. Passes; db-p2p 2526 → 2527.

## Findings recorded as evidence on an existing ticket, not filed fresh

- **`coordinator-repo.ts` is now 2199 lines (`wc -l`) and carries a fourth per-block
  `LruMap(1000)`.** The site is already claimed by backlog
  `debt-freshness-state-scattered-across-coordinator-repo`, which keeps a running measurement log, so
  this went there as a seventh measurement rather than becoming a new ticket. The arm is worth more
  than the line count: that ticket's *third* measurement complained that a new per-block fact was
  crammed into an existing map "because there was already a map", and this change did the exact
  opposite for locally sound reasons. Two locally-right calls pointing opposite ways is the strongest
  argument yet that what is missing is a collaborator owning per-block state with each fact's
  lifetime stated once — and that the extraction should absorb all four maps, not only the freshness
  ones. A minor note about all four being keyed `string` when every key is a block id went in the
  same arm.

## Tripwires — parked in code, indexed here

All four were placed by the implement stage and were verified to exist at the right sites; none was
re-filed as a ticket, which is correct for conditional concerns:

- LRU eviction re-arming an episode's say-once flag — `NOTE:` at the `stuckReservations` field.
- Coordinator migration restarting or duplicating an episode — `NOTE:` at the same field.
- Partially wedged blocks (only part of a cohort holds the record) going unnamed, because that
  refusal returns through the retained local apply verdict and never reaches
  `classifyPendingConflictRejection` — `NOTE:` on `noteStuckReservation`. The judgement call was
  reviewed and it stands: it is the weaker condition (the write does land on the healthy members),
  and counting it from a site that cannot see the cohort's verdict would report a refusal the cohort
  did not make. The note already names the right remedy if field data ever says otherwise
  (`ClusterMember.validatePendOperations`).
- The threshold's false-positive window above 8 concurrent distinct writers — in the constant's doc
  comment, now with the sync-cycle correction above.

## Accepted tradeoffs

None encountered — no `NOTE: accepted tradeoff` marker exists at any site this change touches, so no
finding was suppressed on that basis.

## Empty categories, with reasons

- **No major findings, and none filed as a ticket.** The mechanism is inert by construction — it
  counts and logs, and never refuses, expires, or deletes anything — so its worst failure mode is a
  wrong or missing log line. Every path that could produce one was traced and none does. The scope
  limits that *look* like majors (only the coordinator is instrumented; partial strands go unnamed;
  the count is per coordinator) are conditional, already carry `NOTE:` markers, and are correctly
  tripwires rather than tickets.
- **Nothing routed to `blocked/`.** No decision here needs a human and no dependency is outside this
  repo.
- **No `docs/internals.md` change, deliberately.** Its diagnostics catalogue at the "Two signals name
  this" list is scoped to read-repair signals specifically, not a global log-line index; adding a
  write-path diagnostic there would misfile it. `docs/debugging.md` was checked too — it is organised
  by namespace and DEBUG pattern, both of which already cover this line, not by individual line, so
  it needs no entry either. `docs/repository.md` was the right and only home.
- **Multi-holder shape still untested.** `holders` is an array because `state.pendings` can in
  principle carry more than one rival, but a member's own pend refuses a second reservation, so no
  spec can produce it. The comparison and the message both handle it. Left as the implement stage
  left it — a test would have to fabricate a state the system does not produce.
