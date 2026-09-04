description: When a block gets stuck refusing all writes because of a leftover "write in progress" marker, the logs describe it as an ordinary lost race, which is what it looks like the first time and is nothing like what it is by the hundredth. Say the real condition out loud once, so an operator can find it by searching the logs instead of reconstructing it from raw traces.
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts
difficulty: medium
----

# A block stuck behind a stale reservation is never named as such

## Why this is worth its own change

A leftover pending record makes a block refuse every write, permanently. Finding that out today
means noticing that the *same* rival action id keeps appearing in refusals, across unrelated writers,
for as long as the process lives — a pattern nothing in the logs points at. Downstream (Sereus)
spent several tickets and weeks on this symptom, because every individual line it produced was
indistinguishable from an ordinary optimistic-concurrency loss, which is a normal and healthy event.

`1-torn-commit-must-cancel-the-blocks-it-abandoned` removes the producer this instance came from. It
does not remove the condition: the cancel it adds is itself best-effort over the network, the "genuine
fault" arm of `StorageRepo.commit` deliberately keeps a batch's pending records for a retry that may
never come, and `debt-unpromotable-pending-records-need-a-sweep` covers the client-crash producers.
So the condition remains reachable, and it should be legible when it happens.

## The signal

A legitimate rival holds a block for one pend-to-commit window, and the writer that holds it either
commits or cancels. A stale reservation is a rival that keeps refusing **distinct, unrelated actions**
for an unbounded stretch. That repetition — same block, same rival action id, many different refused
actions — is the signature, and it is available where refusals are already classified.

The two places that see it:

- `CoordinatorRepo.classifyPendingConflictRejection`, which already re-reads local storage to confirm
  the rival and already logs `coordinator-repo:pend-conflict-classified` with the rival ids. This is
  the better site: it is on the coordinating node, it has the block ids and the rival ids in hand, and
  the refusal it is classifying is the one the writer actually receives.
- `ClusterMember.validatePendOperations`, which logs `cluster-member:validation-pending-conflict` per
  member. Useful, but each member sees only its own votes.

Start at the coordinator.

## Shape to copy

`CoordinatorRepo.reportRepairDeadlock` is the same problem already solved once, and its ticket
(`repair-deadlock-is-never-named`) is the direct precedent the source ticket pointed at. Match it:

- **Say it once per episode, not once per refusal.** The failure being replaced is a thousand
  identical lines, so a fix that produces a thousand slightly different ones is not a fix. That method
  hangs its say-once state off an existing per-block LRU entry rather than adding another map; do the
  same if a natural carrier exists.
- **The message is prose written for an operator**, in the style of `cohortTooSmallMessage` and
  `soleHolderMessage` in the same file: what is stuck, what will and will not clear it, and what to do.
  In this case, plainly: this block is held by an action that is not going to complete, no retry will
  ever win, and the reservation is cleared only by a cancel for that action id or by the holder
  committing it.
- **Keep the structured fields greppable** — block id, the holding action id, how many distinct
  actions it has now refused — so a log search finds the block and the action id without prose parsing.

## Calibration, and the honest limits

Two dead ends worth not re-walking:

- **The in-memory reservation table is not the discriminator.** `ClusterMember.activeTransactions`
  clears as soon as a rival's pend reaches consensus, so a perfectly healthy rival sitting in its
  pend-to-commit window is absent from it too. Absence there says nothing.
- **"The block has already passed this pend's revision" does not catch it either.** In the verified
  instance the wedged block sat at revision 1 while the orphaned pend was for revision 2 — still
  nominally promotable. That test finds a different orphan class, not this one.

What is left is repetition, and repetition needs a threshold. Pick one that cannot fire on a healthy
race and say why: distinct refused actions is a better counter than elapsed time (a slow writer is not
a stuck one) and better than raw refusal count (one writer retrying is one writer). Cross-check the
chosen threshold against the concurrency the existing specs generate — `race-resolution.spec.ts` and
`concurrent-diary-append-acknowledgement.spec.ts` are the ones that produce genuine rival pends — so a
healthy contended run stays silent.

**This is a diagnostic and must not become a control path.** Do not refuse, expire, or delete anything
on the strength of this counter; the decision about clearing a durable record belongs to
`debt-unpromotable-pending-records-need-a-sweep`, whose whole difficulty is that deleting a live
reservation is worse than the leak. This ticket only makes the condition sayable.

## TODO

- [ ] Add a per-(block, holding action) counter of distinct refused actions where pending conflicts
      are classified in `coordinator-repo.ts`, alongside the existing classification log.
- [ ] Emit one say-once, greppable line naming the condition when that counter passes the threshold,
      with an operator-facing message in the style of the repair-deadlock messages in the same file.
- [ ] Justify the threshold in a comment against a healthy-contention run, not by assertion.
- [ ] Clear the say-once state when the block starts accepting writes again, so a second episode on
      the same block can still speak.
- [ ] A spec that wedges a block (pend two blocks through consensus, commit only the tail — see
      `1-torn-commit-must-cancel-the-blocks-it-abandoned` for the exact repro), drives enough distinct
      later writes at it to cross the threshold, and asserts the line is emitted exactly once. Use
      `test/support/capture-log.ts`, as the repair-deadlock specs do.
- [ ] A negative spec: a genuinely contended run emits nothing.
- [ ] `yarn build && yarn typecheck && yarn test` at the repo root.
