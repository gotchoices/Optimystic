description: On a machine that is the only one responsible for a record, every read of that record starts a check against the other machines, finds there are none, does nothing, and never records that it checked — so the next read starts the same check again, forever. A phone founding its own database never finishes.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts:933 (`fetchBlockFromCluster` — the solo short-circuit; the exit to arm)
  - packages/db-p2p/src/repo/coordinator-repo.ts:922 (`peerIds.length === 0` — the sibling exit; decision below is "leave unarmed, comment it")
  - packages/db-p2p/src/repo/coordinator-repo.ts:860 (`shouldReadRepair` — reads the window)
  - packages/db-p2p/src/repo/coordinator-repo.ts:881 (`markBlocksSeen` — arms it)
  - packages/db-p2p/src/repo/coordinator-repo.ts:632 (`get` — the read-repair loop that calls the above)
  - packages/db-p2p/test/coordinator-repo-read-repair.spec.ts (window/policy coverage — likely home for the regression spec)
  - packages/db-p2p/test/coordinator-repo-solo-self-bypass.spec.ts (pins the solo skip itself)
  - packages/db-p2p/test/support/capture-log.ts (`captureLog` / `hasTag` — how these specs read the log)
difficulty: medium
repro: verified
----

# Arm the read-repair window on the solo-cohort exit

Reported as [GitHub issue #8](https://github.com/gotchoices/Optimystic/issues/8): a React Native
app whose node is alone in its network never finishes a cold `apply schema` — over 47 minutes for
a 22-object schema against ~3 s on the reporter's older stack. Their capture shows commits finish
in the first ~2 minutes; what never stops is read-repair, cycling on a handful of control-network
blocks: **3,880 `cluster-tx:read-repair-triggered` against 3,879 `cluster-tx:read-repair-noop`** —
every consult a no-op — each interleaved with `cluster-fetch:solo-self-skip`.

## Cause

`fetchBlockFromCluster` has three exits that return a verdict. Two call `markBlocksSeen`, which
stamps `lastSeenCommitMs` and is the only thing that arms the lazy read-repair window:

- `cluster-fetch:local-current` (~line 989) — arms it;
- the normal end of the consult — arms it;
- the solo short-circuit at line 933 — **does not**.

The solo exit fires when `findCluster` returns exactly one peer and that peer is self. Skipping the
fetch there is correct (no remote to sync from, and dialling self can hang a node with no listen
addresses), but returning without stamping leaves `lastSeenCommitMs` unset, so `shouldReadRepair`
in `lazy` mode reads `lastSeen == null` and returns `true` on this read and every read after it.
The loop is: read → window says stale → consult → solo skip → no-op → window still says stale.
Nothing bounds it.

This is invisible on any multi-node deployment: a cohort larger than one always takes the consult
path, which arms the window on the way out.

## Measurements taken during the fix investigation

All against `CoordinatorRepo` directly, deterministic clock (`repo.now`), no libp2p; block present
locally at rev 1 and never committed by this node; cohort `[self]`; `readRepairWindowMs` 10 s,
`readRepairSampleRate` 0; nine reads 1 s apart, so reads 2–9 are all **inside** the window.

| probe | at HEAD | with `markBlocksSeen([blockId])` on the solo exit |
|---|---|---|
| solo, 9 reads inside window | 9 triggered / 9 no-op / 9 solo-skip | **1 / 1 / 1** |
| `paranoid` mode, 5 reads | 5 triggered | 5 triggered (unchanged, correct) |
| solo read, then a peer joins, read again inside window | consult runs | **no consult** — suppressed until the window lapses |
| same, then read after the window lapses | consult runs | consult runs (cohort callback invoked for both peers) |
| empty cohort (`findCluster` returns `{}`), 9 reads | 9 triggered | **9 triggered** — unchanged, see below |

The 1:1 trigger/no-op ratio at HEAD is the same ratio the reporter measured on device
(3,880 / 3,879), which is the evidence that the probe and the field report are the same defect.

Full `@optimystic/db-p2p` suite with the one-line fix applied: **2551 passing, 0 failing, 49
pending** (`yarn workspace @optimystic/db-p2p test`). No existing spec depends on the solo exit
leaving the window unarmed.

## The decisions this ticket already made, so the implementer does not have to re-derive them

**Arm the solo exit.** The short-circuit has established that the block is as current as it can
be — this node is the whole cohort — which is exactly what `cluster-fetch:local-current` concludes
before arming. Arming and the existing `absence: 'confirmed'` rest on the same premise (self is the
whole cohort), so they stand or fall together; keep the verdict as it is.

**Cohort growth costs at most one window.** Measured above: after a peer joins, a read inside the
window no longer consults, and the read past the window does. That is the whole cost of the fix,
it is bounded by `readRepairWindowMs` (10 s default), and it self-heals. Worth stating plainly
because it changes how the growth test must be written — see the traps below.

**Do not arm the `peerIds.length === 0` exit (line 922); comment it instead.** It has the same
shape and the same unbounded re-consult, but an empty cohort is a *routing failure*, not a settled
answer: routing can recover at any moment, and arming would suppress a genuine repair for a whole
window after a transient blip. The exit also performs no network work — the cost of re-entering it
is the `findCluster` lookup the read already makes — so leaving it unarmed is cheap. Record the
asymmetry as a `NOTE:` at the site so the next reader does not "fix" it by symmetry. (Whether
`absence: 'confirmed'` is the honest verdict for an empty cohort is a separate, already-documented
decision in the `fetchBlockFromCluster` doc comment — do not re-litigate it here.)

**Two traps that cost this investigation time:**

- *Do not advance the clock past `readRepairWindowMs` between reads in the solo regression test.*
  A lapsed window **should** re-trigger — that is what lazy read-repair is for — so a probe that
  steps 60 s between reads shows 9 triggers both before and after the fix and makes the fix look
  inert. The bug is only visible on reads taken inside the window.
- `CoordinatorRepo.log` is a readonly `createLogger` instance, not an assignable field. Read the
  log through `captureLog('coordinator-repo', …)` from `test/support/capture-log.ts`, as the
  neighbouring coordinator specs do. `repo.now` **is** an assignable test seam; `repo.rand` too.

## Relationship to the other read-repair ticket in flight

`implement/1-a-reader-cannot-tell-its-view-stopped-advancing` names this ticket as its prereq and
changes the **commit**-side arming (a commit should arm the window only when its approvals form a
majority of the full cohort, so the solo commit branch stops arming). The two do not conflict:
that ticket removes arming from a path that *proves nothing about rivals*, while this one adds
arming to a path where *there are no rivals by construction*. Whoever lands both should keep that
distinction explicit in the comments so they do not read as contradictory.

## TODO

- Add `markBlocksSeen([blockId])` to the solo short-circuit exit in `fetchBlockFromCluster`
  (coordinator-repo.ts:933), with a comment stating why arming is honest there: this node is the
  whole cohort, so the local answer is as current as any answer can be — the same premise the
  `absence: 'confirmed'` verdict already rests on.
- Add a `NOTE:` at the `peerIds.length === 0` exit (line 922) recording that it deliberately does
  **not** arm, because an empty cohort is routing failure rather than a settled answer, and
  arming would suppress repair for a whole window after a transient routing blip.
- Write the regression spec beside the existing read-repair coverage. It must cover:
  - a solo cohort, block present locally and **never committed by this node**, N reads all inside
    `readRepairWindowMs` → exactly one `cluster-tx:read-repair-triggered` (fails at HEAD with N);
  - `readRepairMode: 'paranoid'` → still consults on every read (the documented meaning of the
    mode; the fix must not touch it);
  - solo read, then `findCluster` starts returning a second peer: no consult inside the window,
    and a consult on the first read past it — pinning the bounded cost as intended behaviour
    rather than leaving it to be rediscovered as a bug.
- Run `yarn workspace @optimystic/db-p2p test` and confirm it stays at 2551 passing / 0 failing
  (plus the new spec's cases).
- Reply on GitHub issue #8 with what shipped.
