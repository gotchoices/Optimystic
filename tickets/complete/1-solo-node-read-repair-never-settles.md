description: A machine that is the only one responsible for a record used to re-check that record against the (nonexistent) other machines on every single read, forever; it now records that it checked, so the check happens at most once per freshness window.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`fetchBlockFromCluster` — solo-self exit arms the window; empty-cohort exit deliberately does not)
  - packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts (regression spec, 7 cases)
  - docs/transactions.md (§ Lazy read-repair window)
----

# Arm the read-repair window on the solo-cohort exit — completed

## What shipped

`CoordinatorRepo.fetchBlockFromCluster` has a short-circuit for the case where the lookup of
"which machines are responsible for this record" returns exactly one machine and that machine is
this node. It skips the peer consult, correctly — there is nobody to ask, and asking yourself can
hang a node with no listen addresses. It returned without stamping the "checked recently" marker
that the lazy read-repair window reads, so the window was never armed: every subsequent read found
the marker unset, decided the copy was stale, ran a consult that could do nothing, and left the
marker unset again. Unbounded. Reported as GitHub issue #8 — a React Native node alone in its
network spent 47 minutes on a cold 22-object schema apply, logging 3,880
`cluster-tx:read-repair-triggered` against 3,879 `cluster-tx:read-repair-noop`.

The fix is one statement: stamp the marker on that exit. Nine reads inside the window now cost one
consult instead of nine. The neighbouring empty-cohort exit is deliberately left unstamped, with a
`NOTE:` at the site saying why, and a spec pinning it at nine triggers for nine reads.

Documentation: `docs/transactions.md` § Lazy read-repair window states both behaviours in operator
terms.

## Review findings

Reviewed the implement diff (`6fa485aa`) before reading its handoff, then read the whole of
`fetchBlockFromCluster`, its callers in `get`, the freshness helpers (`shouldReadRepair`,
`markBlocksSeen`, `recordAheadClaim`, `flagUnconfirmedCurrency`, `flagUnconfirmedAbsence`), the
production key network's `findCluster`, the mesh-harness key network, and the three sibling
read-repair specs.

**Validation (all run at the reviewed tip, after the inline fixes below):**

- `yarn workspace @optimystic/db-p2p typecheck` — exit 0.
- `yarn workspace @optimystic/db-p2p test` — **2558 passing, 0 failing, 49 pending**.
- `yarn test` (whole workspace) — **0 failing** across every package; ~5,497 passing, 63 pending.
- `yarn lint` (eslint, repo-wide) — exit 0.
- `yarn lint:docs` — 45 documents, all citations resolve.
- No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

### Major — one ticket filed

**A freshness check that reached nobody erases previously-recorded doubt.**
Filed as `fix/a-consult-that-asked-nobody-erases-recorded-doubt`. **Verified by probe**, not
inferred.

When a peer claims a newer revision that this node cannot obtain, the node remembers the doubt so
that later reads of that record are still marked "may be behind revision N" — the marker that
eventually raises `BlockPossiblyStaleError` to the caller. That memory is wiped by a check that
asked nobody at all: the solo-self exit, the empty-cohort exit, and the case where every peer that
was asked failed to answer. All three report "nothing claims anything ahead of me", the memory is
dropped, and the stale copy goes back to the caller unflagged and not marked unavailable — the
silent-stale answer the marker exists to prevent. `recordAheadClaim`'s own doc comment states the
invariant being violated ("Only a consult that actually RAN may call this").

Root cause is representational, which is why the ticket is filed at that level rather than as a
condition at the one call site: `fetchBlockFromCluster` returns `claimedAheadRev: undefined` for
both "peers answered and none claims anything ahead" (a real refutation) and "nobody was asked"
(no evidence), and the companion `absence` field does not separate them either — the solo and
empty exits both report `'confirmed'`. Adding an `if` leaves the ambiguous value in place for the
next exit someone adds. This is the currency half of the exact flattening `AbsenceVerdict` already
fixed for the existence half.

Scope: **pre-existing, not introduced by this diff.** The total-silence variant — the common one in
the field — behaves identically before and after. This diff does lengthen the consequence on the
solo path only: with the window now armed, the next check is deferred by up to `readRepairWindowMs`
after the doubt is dropped. That is not a reason to withhold this fix; the loop it ends is worse,
and the erasure is independently wrong.

Probe method (scratch spec, run and deleted; tree verified clean): cohort of three, `paranoid`
mode, local copy at rev 1, both remote peers claiming an unacquirable rev 3. First read carries
`unconfirmedAheadRev === 3`. Then either shrink the cohort to self-only or make both remotes throw.
Second read: marker `undefined`, `unavailable` `undefined`. Both variants reproduced.

### Minor — fixed in this pass

**The central rationale was overstated, in a way that invites a future mistake.** The solo-exit
comment claimed the node has "no rivals **by construction**" and the docs said "this node *is* the
whole cohort". Both are false at the only production `IKeyNetwork`: `Libp2pKeyPeerNetwork.findCluster`
returns a **self-only cohort while genuine same-network peers are still `'unknown'` mid-identify** —
its own membership-scoping comment says so explicitly and relies on it ("a fresh same-network peer
is not starved: it flips to `'serves'` once identify completes"). A maintainer who believed "no
rivals by construction" could reasonably conclude it is safe to lengthen the window or skip other
checks on this path. Rewrote the comment and the docs paragraph to state what arming actually
claims: not that there are no rivals, only that re-asking sooner than one window cannot learn
anything the next `findCluster` would not, since this exit runs no other query. The behaviour is
unchanged and correct; only the justification was wrong.

**The empty-cohort `NOTE:` defended a branch production cannot reach.** `findCluster` always
includes self in the cohort it returns, so an empty result is impossible from the production key
network; the only producer today is the mesh harness's injected `findClusterFails`. The reasoning
in the note is right, but a reader would over-weight the branch without that fact. Added it to both
the note and the docs paragraph. The asymmetry itself stands — it was checked against the
possibility that it was a "fix by symmetry" oversight, and it is not.

**One handoff gap closed with a spec, not carried forward.** The handoff flagged that the solo exit
now also stamps blocks that are **missing** locally, called the stamp inert because `get` bypasses
the window for missing blocks, and noted no spec pinned it. Added that case: nine reads of a
never-held block, all inside the window, must produce nine solo-skips and zero read-repair triggers.
It fails loudly if the missing-block bypass is ever narrowed, which is the only thing keeping the
stamp harmless. Spec is now 7 cases.

**One handoff gap was inaccurate and needed no work.** The handoff said real cohort growth "also
runs through the responsibility cache (`RESPONSIBILITY_TTL_MS`)", which the spec does not exercise,
so the bounded-cost claim was "proven for the window, not for the whole join path". That cache
belongs to `isResponsibleForBlock`, a defence-in-depth guard answering a different question ("is
this node in the cohort at all") on inbound requests. It never feeds `fetchBlockFromCluster`, which
calls `findCluster` uncached on every consult. The one-window bound is therefore proven for the path
that matters. (Noted in passing: that cache uses `Date.now()` while the read-repair window uses the
injectable `this.now()` seam. Pre-existing, and already an arm of the freshness-extraction debt
ticket's "four maps, four clearing conditions" complaint — not re-filed.)

### Tripwires — recorded at the site, not filed

**The self-heal delay after a transient self-only cohort view is exactly `readRepairWindowMs`.** At
the 10 s default this is comfortably shorter than bootstrap and identify, so a cold node's window
lapses long before it matters. If that setting is ever configured into the minutes, a node that boots
alone would serve unverified reads for that whole period, because arming cannot distinguish
"permanently solo" from "peers not identified yet". Parked as a `NOTE:` in the solo-exit comment in
`coordinator-repo.ts`, with the remedy named (gate arming on cohort provenance), and stated in
operator terms in `docs/transactions.md`. Conditional on a configuration nobody has made — not a
ticket.

### Checked and clean

- **Interaction with the in-flight `a-reader-cannot-tell-its-view-stopped-advancing`.** That ticket
  removes window-arming from four **commit-side** sites and explicitly instructs "do not touch the
  consult-side markings ... [including] the solo-self-skip arm the prereq ticket adds", and names
  this behaviour as its own prerequisite. The two are complementary, not contradictory. Reworded
  this diff's comment on that point so it reads as a deliberate opposition rather than an
  inconsistency. One caveat that ticket should know about: it argues the recorded doubt keeps
  reads honest while the window damps repair effort — the ticket filed above shows that memory is
  erasable by a non-check, so that argument is weaker than it reads until the fix lands.
- **Backlog site-claim grep** over `tickets/{backlog,fix,plan,implement,review}` for
  `recordAheadClaim` / `unsettledAheadClaims` / `unconfirmedAheadRev` and for `coordinator-repo`:
  nothing open claimed the new ticket's site. `debt-freshness-state-scattered-across-coordinator-repo`
  covers the surrounding class, so a "ninth measurement" section was appended to it recording (a) the
  answer to the open question its eighth measurement asked — whether the empty-cohort exit should
  arm; it should not, and production cannot reach it — and (b) the new defect as third evidence for
  its acceptance criterion. Re-measured the file at **2224 lines**, up from the 2199 that ticket last
  recorded.
- **Accepted-tradeoff `NOTE:`s around the site** were read before filing; none covers the erasure
  defect, and none of their revisit conditions has tripped.
- **Fix-removal check reproduced.** Deleting the `markBlocksSeen` line fails 3 of the spec's cases.
  The spec bites.
- **Docs.** Read every doc mentioning the read-repair window (`transactions.md`, `internals.md`,
  `debugging.md`). `internals.md`'s log-line index is scoped to certified-claim lines and does not
  need `cluster-fetch:solo-self-skip`; `debugging.md` already routes `cluster-fetch:*` to the
  `coordinator-repo` logger. The worst-case staleness bound at `transactions.md:678` remains true.
  No doc was left describing the old behaviour.
- **Resource cleanup / typing.** The stamp goes into an `LruMap` bounded at 1000 entries — no leak.
  No new state, no new allocation on the hot path, one statement added.

### Deliberately not done

- **The `readRepairSampleRate > 0` case on the solo path is still unpinned.** Sampling lives in
  `shouldReadRepair` and is mode-generic — it forces an occasional consult regardless of which exit
  the consult later takes, so on a solo node it means an occasional extra solo-skip. Nothing about
  this diff can change that, so a spec would pin `shouldReadRepair`'s existing behaviour rather than
  anything the fix introduced. Not worth a case.
- **No end-to-end reproduction of the 47-minute field symptom.** It was never reproduced on a real
  solo React Native node, before or after; the evidence tying the stub probe to the field report is
  that the trigger:no-op ratio matches (1:1 in both), which is strong but not a live repro. A real
  single-node harness is out of scope for this ticket and no ticket was filed for one — the defect
  and the fix are both pinned by deterministic specs.

## Open action for a human — not code

**GitHub issue #8 has still not been answered.** The implement stage deliberately did not post,
correctly: at that point the change was neither committed nor on `main`, so a "this shipped" comment
would have been inaccurate when written. That reasoning still holds now — this ticket completes the
review stage, but the runner has not yet committed, and nothing is pushed. Once the change is
actually on `main`, the reply is one command away: `gh` is authenticated as `n8allan` and the remote
is `gotchoices/Optimystic`. Worth mentioning in that reply that the fix bounds the consult rate at
one per `readRepairWindowMs` rather than switching read-repair off, and that the default window is
10 s.
