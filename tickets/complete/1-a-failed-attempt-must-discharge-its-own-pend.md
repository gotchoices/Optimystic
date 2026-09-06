description: A brief network fault used to fail a write permanently, because the cleanup message that undoes a half-finished write was sent once over the same broken connection and its failure went unnoticed. Cleanup now checks that it actually worked, retries briefly, and reports failure loudly when it cannot.
files: packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/transactor/transactor.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-p2p/test/reset-does-not-strand-its-own-pend.spec.ts, docs/repository.md
----

# Complete: a failed attempt must discharge its own pend

Implemented in `28349d27`, reviewed and amended in this pass. Build, lint, doc-citation lint, and
both test suites pass.

## What shipped

A pending record is the marker a storage node writes when a write is on its way; while one stands,
every later write to that block from any writer is refused. Its only removers are a client cancel, a
divergence-shaped commit refusal, and a forward write of the same action id — so a cancel that
silently did nothing wedged the block for good. Four things changed:

- **`NetworkTransactor.dischargeCancel`** — one loop both public cancel paths go through. Per round:
  build batches, `processBatches`, compute which blocks actually got an answer, narrow to the rest,
  back off, repeat. Ends on discharge, on `MAX_CANCEL_ROUNDS` (6), or on the
  `abortOrCancelTimeoutMs` deadline, and throws an aggregate naming the action and the still-held
  blocks when it ran out. Completeness is measured per BLOCK, so a partially successful round
  narrows rather than re-issuing everything.
- **`NetworkTransactor.pend`'s failure path** awaits its cancel instead of firing it as a background
  microtask, so a caller that retries immediately does not meet its own predecessor's record.
- **Every caller audited and made non-displacing.** `TransactorSource.transact` (both abort paths),
  `TransactionCoordinator.cancelPhase`, and `NetworkTransactor.cancelAbandonedSweepBlocks` each
  catch and log; the verdict being cleaned up after — the `StaleFailure` a writer rebases on, or the
  transport error — still reaches the caller unchanged.
- **`ITransactor.cancel`'s contract**, `TransactionCoordinator.cancelPhase`'s log line, and
  `docs/repository.md` state the new rule: returning means discharged; an implementation that could
  not remove the records must throw.

New spec `packages/db-p2p/test/reset-does-not-strand-its-own-pend.spec.ts`, four arms over a 3-node
mesh driving the production caller through a transport that can be taken down per RPC kind: the
reported chain (commit + cancel both down), a control that passed before the fix, a lost pend reply,
and a permanently dead cancel transport that must throw.

## Review findings

**Read first, summary second.** The implement diff was read whole before the handoff. Reviewed for
correctness, resource cleanup, error handling, type safety, DRY, source hygiene, and doc accuracy;
every `ITransactor.cancel` call site in the repo was enumerated and checked against the new throwing
contract.

### Fixed in this pass (minor)

- **`cancelBatch`'s seed round dropped blocks by design.** It mapped each pend batch to its ANCHOR
  block id, so when `consolidateCoordinators` collapsed several blocks onto one coordinator the seed
  carried only one of them. The implement ticket documented this as a known extra round. Fixed at
  the source instead: the seed now uses each batch's `coordinatingBlockIds` — which
  `consolidateCoordinators` sets to exactly the blocks it assigned that peer — so root batches are
  covered on round 0. Retry batches created by `processBatches` carry no `coordinatingBlockIds` and
  still fall back to their anchor; that residual costs a round, never correctness, and is documented
  at the site. **Not verified by test** — see the ticket filed below for why no fixture can reach it.
- **`MAX_CANCEL_ROUNDS`' accepted-tradeoff NOTE stated an unmeasured magnitude.** It claimed the six
  rounds span "roughly 0.9–1.5 s". Derived from `jitteredBackoffMs`: five backoffs with pre-jitter
  values 50/100/200/400/500 ms, each drawn from `(0.5·exp, exp]`, sum to 0.63–1.25 s. The NOTE now
  carries that derivation plus the measured 1054 ms end-to-end from arm D. The tradeoff itself —
  the round cap ending the loop before the (5–10 s) abort deadline — was reviewed and kept: it hands
  a caller a legible failure in about a second instead of issuing RPCs nobody will answer, and the
  NOTE's revisit condition is stated.
- **`TransactorSource.transact` had the cancel-and-log block twice, verbatim.** Extracted as
  `dischargePend`, which returns the cancel's failure rather than propagating it — the "must not
  displace the verdict" rule is now expressed once, in one place, instead of twice in prose.
- **A `catch` block could throw over the error it was preserving.** The same site assigned
  `e.cancelError = cancelError` on a caught value; that assignment throws in strict mode if the
  error is frozen or sealed, which would replace the real cause with a `TypeError`. Now guarded, with
  the reason stated (the log has already named the cancel either way).
- **`formatBatchStatuses`' `_isSuccess` parameter was dead** and the new code added a fourth caller
  passing a fourth pointless predicate. Removed, along with all four lambdas, and the method gained
  the doc comment explaining what it actually selects.
- **The new spec's fault window was timed from when the arm armed it, not from the first gated
  call.** On a loaded machine an ungated pend could consume the whole 150 ms window before the gated
  RPC was reached, and the arm would then fail on its own "the fault must actually have fired"
  assertion rather than on the behaviour. The window now starts on first contact, which keeps the
  fault time-shaped (that shape is the point of the arm) without the dependence. All four arms still
  pass: 312 ms / 269 ms / <100 ms / 1005 ms.
- **`debt-unpromotable-pending-records-need-a-sweep` described the old client behaviour as current.**
  Its body still said a refused pend's cancel is fired as a background microtask, its `files:` lines
  pointed at line numbers that no longer mean anything, and one of its open design questions is now
  answered. Corrected with a landed arm and updated `files:` entries, so the design pass for the
  node-side sweep starts from what the code does.

### Filed as a ticket (major)

- **`backlog/debt-no-mesh-fixture-forces-two-coordinator-batches`** — no test fixture anywhere
  produces a write that goes out as more than one request, so the whole partial-failure shape of the
  client's failure handling has never run. Three sites now carry comments saying so independently:
  `cancelAbandonedSweepBlocks`' `confirmed` filter, `cancelBatch`'s seed round (added above), and
  `commitBlocks`' aggregation. Filed at the fixture rung rather than as three point tickets, because
  one fixture retires all three; the harness already has the knob (`createMesh`'s `responsibilityK`),
  so this is choosing a shape, not building a mechanism. Cross-referenced from
  `debt-torn-commit-mesh-coverage-drops-no-blocks`, which is arguing about where the shared mesh
  test helpers belong.

### Checked and found nothing

- **Every caller of the now-throwing `ITransactor.cancel`.** Four in-repo call sites; all four
  already catch, and none converts the cancel failure into the caller's verdict. The two other
  `ITransactor` implementations (`TestTransactor`, reference-peer's `LocalTransactor`) satisfy the
  new "returning means discharged" contract — both delegate to a storage repo that throws on
  failure.
- **"Answered" really does mean "discharged" at the server.** `CoordinatorRepo.cancel` rethrows on
  any failure, including a failed cluster transaction, so a resolved RPC is not a false positive.
  `Pending.isResponse` is set only on fulfilment, never on rejection, so `dischargedBlocks`'
  predicate is sound.
- **Loop termination and bounds.** `dischargeCancel` breaks on the round cap or a non-positive
  remaining budget, both evaluated before the backoff; the backoff is clamped to the remaining
  budget. `batchesForPayload` throwing every round leaves an empty batch list, which still produces
  an aggregate naming the action and blocks.
- **Latency on the hot path.** The awaited cancel adds a round trip to every LOSING pend, including
  the ordinary optimistic-concurrency loss. That path's peers answered the pend, so the cancel lands
  on round 0 — the retry loop only costs time when the transport is genuinely down. The tradeoff is
  stated at the site and accepted.
- **Docs.** `docs/repository.md`'s new paragraphs match the code as it now stands; the doc-citation
  linter passes. No other doc under `docs/` describes the cancel path.

### Deliberately not turned into work

- **The `abortOrCancelTimeoutMs` deadline is never the bound that trips.** With production budgets of
  5–10 s the round cap always ends the loop first, so the deadline branch is unexercised. Reaching it
  needs a mesh whose cancel RPCs hang rather than reject. Recorded here rather than filed: the branch
  is two lines, and the round cap that does trip is covered by arm D.
- **`e.cancelError` has no consumer and no assertion.** It exists so one report can name both faults;
  the log at the cancel site already names the cancel independently, so nothing is lost if it is
  never read. Kept, guarded, and left unasserted — making it load-bearing would need a consumer
  first.
- **Every arm cancels a single block**, so `dischargeCancel`'s per-block narrowing runs only in its
  one-element form. Same missing fixture as the ticket above; not a second finding.
- **`network-transactor.ts` is 1225 lines** (measured with `wc -l`), up from 1081. Large, but the
  growth here is one cohesive method plus doc comments, and no natural seam appeared while reading
  it. Not filed as size debt; if it is filed later it should be for the whole file's structure, not
  for this change.

## Validation

Run after the review amendments, from the repo root:

- `yarn workspace @optimystic/db-core build` → clean
- `yarn lint` → clean; `yarn lint:docs` → 45 documents, all citations resolve
- `yarn workspace @optimystic/db-core test` → **1594 passing**
- `yarn workspace @optimystic/db-p2p test` → **2551 passing, 49 pending**
- `yarn workspaces foreach -A --topological-dev run build` → clean across all packages
- `reset-does-not-strand-its-own-pend.spec.ts` alone → 4 passing

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written. The implementer
verified the fix's discrimination by neutering it (round cap 1, throw replaced by a log) and
reproducing the reported refusal chain verbatim, then reverting; that evidence was reviewed but not
re-run.

## Verification, 2026-09-06 — the awaited-cancel arm was re-run and it does discriminate

The Validation section above records discrimination evidence for the `cancel` completeness check
(round cap 1, throw replaced by a log) and states plainly that it "was reviewed but not re-run", and
says nothing of the kind for the *other* change in this ticket — moving the pend failure path from an
unawaited background microtask to an awaited `cancelBatch`. A tending pass closed that gap by
re-running it.

Reverting the pend-failure arm to its exact prior expression, rebuilding `db-core`, and running the
spec alone:

```
1 failing
  C: a pend whose reply is lost discharges before it returns...
     AssertionError: attempt 2 must land — a wasted attempt means the cancel was not awaited.
     attempts: armC-1:threw(...The stream has been reset)
             | armC-2:refused(pending conflict: block(s) held by unresolved rival action(s) armC-1)
             | armC-3:committed
     expected 3 to equal 2
```

Test C discriminates, and the intermediate attempt it exposes is the downstream fingerprint verbatim
— an attempt refused by its own predecessor's record. Both arms of this ticket are now guarded by a
test demonstrated to fail without its fix.

**A trap worth recording, because it produced a wrong conclusion first.** `db-p2p`'s specs import
their own package through `../src/...` but import `@optimystic/db-core` through its package exports,
which resolve to `dist/src/index.js`. So editing `db-core`'s **source** and re-running `db-p2p`'s
tests exercises the *previous* build and every test passes, which reads exactly like "the test does
not guard this". The same applies to `quereus-plugin-optimystic`, whose specs import
`../dist/plugin.js` directly. **Rebuild the edited package before drawing any conclusion from a
cross-package disarm.** Within a single package (`db-p2p` source against `db-p2p` specs) no rebuild
is needed, which is what makes the inconsistency easy to miss.
