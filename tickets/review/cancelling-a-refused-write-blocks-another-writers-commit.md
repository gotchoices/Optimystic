description: When two machines wrote to the same table at once, the loser's cancellation of its own refused attempt was treated as a competing write and knocked out the winner's save, leaving it half-written and reported as failed. Cancellations are now excluded from that competition, and a regression test that reproduced the failure now passes.
architecture: docs/correctness.md
files:
  - packages/db-p2p/src/cluster/race-resolution.ts (`operationsConflict` + new `isCancelOnly`: the rule that changed)
  - packages/db-p2p/test/race-resolution.spec.ts (unit cases for the new rule)
  - packages/db-p2p/test/concurrent-two-member-writes-do-not-tear.spec.ts (new mesh regression)
  - docs/correctness.md ("Case 2: Concurrent arrival")
  - packages/db-p2p/docs/cluster.md ("Conflict Detection Algorithm" — its code excerpt was already stale)
difficulty: medium
----

# What changed

`operationsConflict` (`packages/db-p2p/src/cluster/race-resolution.ts`) decides whether two cluster messages must serialize against each other, and so whether a member votes `conflict` on one of them. It answered "conflict" for any two messages of different actions that share a block — including a **cancel**. One new escape, beside the existing same-action escape:

```ts
if (isCancelOnly(ops1) || isCancelOnly(ops2)) return false;
```

`isCancelOnly` is "every operation in the message is a cancel" (a `RepoMessage` carries one operation in practice; stating it over the list keeps a hypothetical mixed message conservative — it still conflicts).

Why it is safe, in one line per neighbour: cancelling action X deletes only X's pending records on the named blocks (`StorageRepo.cancel`) and never moves a block's revision, so it reorders nobody's history. A commit of Y never reads X's pending record (that was checked at Y's pend); a pend of Y is refused by storage and by `validatePendOperations` while X's record stands, in either arrival order, so the worst case is a retry of Y; an invalidation writes compensating revisions and leaves pending records alone. The same argument is now in the function's doc comment and in docs/correctness.md Case 2.

Consequence worth knowing: a cancel now neither holds a reservation against anyone nor can have its own reservation aborted by a rival (`race-accept-incoming` no longer reaches it).

# Why it mattered

On a two-member cohort with `superMajorityThreshold: 0.67`, one conflict vote already makes super-majority unreachable. Writer A's pend was refused (B held the leaf), A cancelled its own refused pend, and that cancel — naming the same blocks, under a different action id — made both members vote `conflict` on B's **leaf commit**, after B's log tail had already committed. B cancelled, refreshed, found its own log entry, re-sent, and collided with A's next cancel the same way, until the row's revision moved on under A and B reported `TornActionError` for a write that was half-saved.

# How to test / validate

**Unit** — `packages/db-p2p/test/race-resolution.spec.ts`, suite `operationsConflict`:

```
cd packages/db-p2p && node --import ./register.mjs node_modules/mocha/bin/mocha.js test/race-resolution.spec.ts --reporter spec
```

New cases: a cancel against a pend, a commit, another cancel and an invalidate of a *different* action on a shared block — no conflict, asserted in both argument orders (the scan holds one and receives the other); a mixed cancel+pend message still conflicts; and, as a guard that the rule was not widened, a commit racing a *different* action's pend on a shared block still conflicts, as does pend vs pend.

**Mesh regression** — `packages/db-p2p/test/concurrent-two-member-writes-do-not-tear.spec.ts`. Two nodes, `responsibilityK: 2`, `clusterSize: 2`, `superMajorityThreshold: 0.67`, one `Tree` per node on the same collection, 3 runs × 4 concurrent `Promise.allSettled` pairs of `replace()` with distinct keys. Every remote cluster delivery is delayed 2–17 ms in each direction (the mesh's cluster client resolves `target.clusterMember` per call, so only remote traffic is slowed — a coordinator's own member stays synchronous, as in production). Asserts every `replace()` resolved and that each row is readable from a tree freshly opened on the *other* node.

Measured:

| | pairs | failed pairs |
|---|---|---|
| Before the change | 12 (3 runs × 4) | 6 — all three runs failed, `TornActionError` |
| After the change | 60 (5 × 3 runs × 4) | 0 |

Runtime after the change ~15 s for the file (it was ~55 s while failing, because each tear burns retries).

**Suites run, all green:**

- `yarn workspace @optimystic/db-p2p test` — 2964 passing, 63 pending.
- `yarn workspace @optimystic/db-p2p build` then, from `packages/quereus-plugin-optimystic`, the two sweeps `two-node-index-interleaving-sweep` and `two-node-multi-collection-commit` — 153 passing. (The plugin resolves db-p2p through `dist`, and its `register.mjs` refuses a stale build, so the rebuild is required.)
- `yarn workspace @optimystic/quereus-plugin-optimystic test` (full) — 987 passing, 13 pending, smoke ok.
- `npx tsc --noEmit` in `packages/db-p2p` — clean.

# Known gaps — treat as a starting point

- **Only the two-member cohort was measured.** That is where one conflict vote is fatal, and it is sereus's reported shape, but the rule change applies to every cohort size. Nothing here measures a 3- or 4-member cohort under the same latency; the existing suite covers those sizes without injected latency.
- **The latency wrapper is spec-local** and replaces `node.clusterMember` with a delegating `Object.create` wrapper. It survives `dispose` (prototype chain) but a `mesh.restart` would rebuild the member and drop the latency. No restart happens in this spec; a `NOTE:` at the wrapper says to promote it to a `MeshFailureConfig` knob if a second spec needs it.
- **The regression uses random delays** (2–17 ms). It passed 5 consecutive executions (60 pairs) with zero failures, but it is a probabilistic reproducer, not a deterministic one: a reviewer wanting certainty should re-run it a few times, and should confirm it fails when the new escape is removed.
- **Residual divergence, unchanged by this work but now more visible:** a cancel of X and a pend of Y on the same block can now both be in flight in the cohort, so a member that has applied the cancel may approve Y's pend while a member that has not may refuse it. That split already existed once the cancel's record reached consensus (the reservation only ever covered the window before that), and it resolves through the normal pend-refusal/retry path — but it is the place to look first if a new "members disagree about a pend" symptom appears.
- **What this ticket does NOT fix:** the sibling `a-write-reported-torn-can-already-be-saved` (a write reported torn that actually landed) and `backlog/bug-a-two-member-cohort-refuses-a-commit-both-members-hold` are separate and still open. The tearing this ticket removes was one *cause* of torn reports, not the wrong-answer behaviour itself.
- **No doc-level claim was made about performance.** The "cancels lose races to each other, extending contention" effect in the source ticket's trace is gone by construction (cancels no longer race), but nothing measures the contention duration directly.

# Review findings from implementation

- `packages/db-p2p/docs/cluster.md`'s `operationsConflict` excerpt was already stale before this ticket — it showed a bare block-overlap test with no same-action escape. Updated it to show both escapes rather than leave it drifting further.
