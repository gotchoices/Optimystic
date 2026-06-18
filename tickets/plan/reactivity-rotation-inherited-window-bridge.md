description: After a tail rotation, a sleeping subscriber can only recover a few minutes' worth of changes across the rotation instead of the ~hour the design promises, because the reply that catches it up can only carry one summary window and the data it needs is split across three. Decide how to bridge them.
prereq:
files:
  - packages/db-core/src/reactivity/resume.ts
  - packages/db-core/src/reactivity/checkpoint.ts
  - packages/db-core/src/reactivity/rotation.ts
  - packages/db-core/src/reactivity/push-state.ts
  - packages/db-core/test/reactivity/resume.spec.ts
  - docs/reactivity.md
difficulty: hard
----

# Cross-rotation resume only recovers ≈`W` revisions, not `W + W_checkpoint`

## Background

Tail rotation (`docs/reactivity.md` §Tail rotation) migrates exactly one piece of state to the new tail:
the outgoing tail's replay buffer folded into a final `CheckpointSummary` (`buildRotationHandoffCheckpoint`
→ `applyRotationHandoff` → `PushState.inheritedCheckpoint`), covering `[lastCheckpoint.toRevision + 1,
rotationRevision]`. The new tail "holds the old checkpoint" so a `ResumeV1` whose span crosses the rotation
is recoverable.

Ticket `12.51-reactivity-rotation-resume-handoff-and-redirect-codec` wired `classifyResume`/`serveResume` to
consult this inherited window when the rolling checkpoint misses. The serve shape is **one checkpoint summary
+ the live ring's `recentEntries`** — identical to the rolling-checkpoint reply.

## The problem

After a rotation the new tail accumulates its **own** revisions. As its replay ring evicts, those revisions
roll into the new tail's *own* rolling checkpoint (`PushState.checkpoint`), which is **distinct** from the
inherited one (`applyRotationHandoff` deliberately does not feed the rolling checkpoint). So once the new tail
has run past its first ring eviction, the recoverable revisions for a cross-rotation resume are split across
**three** stacked windows:

```
[ inherited handoff ]  [ new tail's rolling checkpoint ]  [ new tail's ring ]
 oldCkptTo+1 .. rotRev   rotRev+1 .. ringLow-1             ringLow .. current
```

A `ResumeReplyV1` carries **one** `checkpoint` summary plus `recentEntries`. It cannot represent all three.
Serving `inherited summary + ring` silently skips the middle window `[rotationRevision+1, ringLow-1]`. The
subscriber's `applyResumeReply` only guards the checkpoint's **low** edge (against its own contiguity head),
not this **high-edge** gap between `inherited.toRevision` and the ring's low edge — so before the 12.51-review
fix it would `rebaseline` to `inherited.toRevision`, replay the ring, hit a contiguity gap, report
`checkpoint_applied` (false success) and leave the middle window undelivered.

### What the 12.51 review already did (the stop-gap)

The review added a **gap-free guard** in `classifyResume`: the inherited window is only used when it still
**abuts the ring's low edge** (`inherited.toRevision >= ringLow - 1`). Otherwise the request falls to
`OutOfWindow` (an honest chain read). This makes every served reply correct, but it means the inherited
window is only useful for the **first ≈`W` revisions after a rotation** (until the new ring's first eviction),
**not the full `W_checkpoint`** the design's §Failure-modes math (`W + W_checkpoint`, ~72 min) implies for a
subscriber that slept across a rotation. The docs were updated to state this limitation and point here.

## What this ticket must decide and build

Restore the documented cross-rotation recoverable range. Candidate approaches (pick after analysis — this is
a design decision needing sign-off):

- **(a) Combine at serve time into one summary `[inherited.from, ringLow-1]`.** The endpoint notifications are
  both available (inherited's low endpoint + the new rolling checkpoint's high endpoint). The blocker is
  `mergedDigest`: the inherited summary stores only the *folded* digest, not the per-revision digests, so a
  generic re-fold across both ranges isn't reconstructable. The **default** fold is a left-fold
  (`acc = H(acc ‖ digest)`) and *is* composable — fold the new rolling checkpoint's per-revision digests onto
  `inherited.mergedDigest` as the seed — but a per-collection `fold` override may not be. Decide: require the
  fold be associative/seedable, or fall back to (b)/(c) when it isn't.
- **(b) Carry multiple checkpoints in the reply.** Widen `ResumeReplyV1.checkpoint` to an ordered list of
  stacked summaries the subscriber verifies + applies in sequence. Cleanest semantically; a wire-shape change
  (and `applyResumeReply` must rebaseline/verify across the chain, asserting each abuts the next).
- **(c) Accept the `W`-revision limitation, document it as the contract, and drop the `W_checkpoint`
  cross-rotation promise.** Cheapest; but contradicts §Failure-modes "subscriber wakes after long sleep" once
  a rotation is involved, so that section would need revising too.

Whatever is chosen: prove it **end-to-end through `applyResumeReply`** (a subscriber at the inherited
window's low edge ends up current with **nothing skipped** across all three windows), not just at the serve
shape — the original 12.51 tests asserted only the serve shape and missed the gap.

## Acceptance

- A subscriber resuming with `fromRevision` inside the inherited window, on a new tail that has evicted into
  its own rolling checkpoint, recovers contiguously in one round trip (or the limitation is the explicit,
  documented contract under option (c)).
- `docs/reactivity.md` §Resume / §Tail rotation / §Failure-modes agree with the chosen behavior (remove the
  abut-limitation note / `reactivity-rotation-inherited-window-bridge` pointer if the range is restored).
- Tests cover the three-window case through the subscriber apply path, plus the digest-fold composability
  decision (default fold composes; a non-composable override is handled, not silently mis-folded).
