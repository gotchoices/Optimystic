description: A machine that is the only one responsible for a record used to re-check that record against the (nonexistent) other machines on every single read, forever; it now records that it checked, so the check happens at most once per freshness window.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`fetchBlockFromCluster` — the solo-self short-circuit now arms the window; the empty-cohort exit carries a NOTE saying why it deliberately does not)
  - packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts (new regression spec, 6 cases)
  - docs/transactions.md (§ Lazy read-repair window — two new paragraphs)
difficulty: medium
----

# Arm the read-repair window on the solo-cohort exit — review handoff

## What shipped

Two changes to `fetchBlockFromCluster` in `packages/db-p2p/src/repo/coordinator-repo.ts`, plus a
regression spec and a doc update. Source diff is **20 inserted lines, 0 deleted** — one statement
and two comment blocks.

**The fix (one line).** The solo-self short-circuit — taken when `findCluster` returns exactly one
peer and that peer is this node — now calls `markBlocksSeen([blockId])` before returning. That
stamp is the only thing that arms the lazy read-repair window. Without it `shouldReadRepair` read
`lastSeen == null` on every read and re-entered the same skip forever: read → window says stale →
consult → solo skip → no-op → window still says stale. Nothing bounded it. Reported as
[GitHub issue #8](https://github.com/gotchoices/Optimystic/issues/8): a React Native node alone in
its network spent 47 minutes on a cold 22-object schema apply, logging 3,880
`cluster-tx:read-repair-triggered` against 3,879 `cluster-tx:read-repair-noop`.

**The deliberate non-fix (a comment).** The `peerIds.length === 0` exit immediately above has the
same shape and the same unbounded re-consult, and is **left unarmed on purpose** with a `NOTE:` at
the site. An empty cohort is a routing failure, not a settled answer: routing can recover at any
moment, and arming would suppress a genuine repair for a whole `readRepairWindowMs` after a
transient blip. Re-entering that exit performs no network work beyond the `findCluster` lookup the
read already makes, so leaving it unarmed is cheap. **Reviewer: the asymmetry is the point — a
"fix by symmetry" here would be a regression, and there is a spec pinning the empty-cohort exit at
9 triggers for 9 reads.**

**Docs.** `docs/transactions.md` § Lazy read-repair window gained two paragraphs stating both
behaviours in operator terms. `yarn lint:docs` passes.

## Why arming is honest on the solo path

The short-circuit has already established that this node is the *whole cohort*, so the local answer
is as current as any answer can be — the same premise the existing `absence: 'confirmed'` verdict on
that exit rests on, and the same conclusion `cluster-fetch:local-current` reaches immediately before
it arms. Arming and that verdict stand or fall together; the verdict was not touched.

Do not read this as contradicting the in-flight ticket `a-reader-cannot-tell-its-view-stopped-advancing`,
which *removes* arming from the solo **commit** branch. That path proves nothing about rivals; this
one has no rivals by construction. The comment at the site says so explicitly so the two do not read
as opposites.

## Validation performed

- `yarn workspace @optimystic/db-p2p typecheck` — clean.
- `yarn workspace @optimystic/db-p2p test` — **2557 passing, 0 failing, 49 pending** (2551 + the 6
  new cases; matches the count the implement ticket predicted). No existing spec depended on the
  solo exit leaving the window unarmed.
- `yarn lint:docs` — 45 documents, all citations resolve.
- **Fix-removal check:** temporarily deleted the `markBlocksSeen` line and re-ran the new spec —
  **3 of 6 cases fail** (the settle-after-one-consult case, the window-lapse case, and the
  cohort-growth case). Source restored byte-for-byte afterwards (`git diff --stat` back to the same
  20 insertions). The spec genuinely bites.

## The new spec: `packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts`

Drives `CoordinatorRepo` directly with stubs — no libp2p. Deterministic clock via the `repo.now`
seam; block present locally at rev 1 and **never committed by this node** (nothing else arms the
window); cohort `[self]`; `readRepairWindowMs` 10 s, `readRepairSampleRate` 0. Log read through
`captureLog('coordinator-repo', …)` from `test/support/capture-log.ts` (`CoordinatorRepo.log` is a
readonly `createLogger` instance, not assignable). Six cases:

| case | asserts |
|---|---|
| settles after one consult | 9 reads 1 s apart, all inside the window → exactly 1 triggered / 1 noop / 1 solo-skip (was 9/9/9) |
| still serves the block | the suppressed read still returns rev 1 — arming suppresses the *consult*, not the answer |
| re-triggers once the window lapses | 2 triggers across read-inside-window + read-past-window; the fix bounds the rate, it does not switch repair off |
| paranoid mode unchanged | `readRepairMode: 'paranoid'`, 5 reads → 5 triggers |
| cohort growth costs one window | solo read arms; peer joins; read inside window consults nobody; read past window consults the new peer |
| empty cohort stays unarmed | `findCluster` returns `{}`, 9 reads → 9 triggers, 0 solo-skips |

**Trap recorded in the spec header, repeated here because it cost the fix investigation real time:**
do not advance the clock past `readRepairWindowMs` between reads. A lapsed window is *supposed* to
re-trigger, so a probe stepping a full window between reads shows N triggers both before and after
the fix and makes the fix look inert. The defect is only visible on reads taken **inside** the
window.

## Known gaps — treat this work as a starting point

- **GitHub issue #8 has NOT been replied to.** The implement ticket asked for it; I deliberately did
  not post. The change is not committed or pushed (the runner commits after this stage) and a review
  stage still stands between it and landing, so a public "this shipped" comment would be inaccurate
  at the moment of posting. `gh` is authenticated as `n8allan` and the remote is
  `gotchoices/Optimystic`, so the reply is one command away **once the change is actually on main**.
  This is the one TODO item from the implement ticket left undone; it is a communication step, not a
  code gap.
- **The solo exit now also stamps blocks that are MISSING locally.** `get` bypasses the window
  entirely for missing blocks (`isMissing` short-circuits `shouldReadRepair`), so the stamp is inert,
  and `lastSeenCommitMs` is an `LruMap` bounded at 1000 entries, so it is not a leak. The pre-existing
  consult-end arming path already stamped missing blocks the same way, so this introduces no new
  behaviour class — but no spec pins it. Worth a reviewer's eye on whether an inert stamp on a block
  this node does not hold can become load-bearing if the missing-block bypass is ever narrowed.
- **No end-to-end reproduction.** The 47-minute field symptom was never reproduced on a real solo
  React Native node, before or after. The evidence tying the stub probe to the field report is that
  the trigger:no-op ratio matches (1:1 in both). A reviewer who wants stronger evidence would need a
  real single-node harness; that is out of scope here.
- **Cohort growth is simulated by mutating the `findCluster` view directly.** Real growth also runs
  through the responsibility cache (`RESPONSIBILITY_TTL_MS` in `CoordinatorRepo`), which the spec
  does not exercise. The bounded-cost claim is therefore proven for the window, not for the whole
  join path.
- **`readRepairSampleRate > 0` against the solo path is untested.** A non-zero sample rate should
  still force an occasional consult inside the window, which on a solo node means an occasional
  extra solo-skip — harmless and arguably desirable, but unpinned.
- **The interaction with `a-reader-cannot-tell-its-view-stopped-advancing` is untested**, because
  that ticket has not landed. Whoever lands it second should re-read both comment blocks together
  and confirm they still read as complementary rather than contradictory.
