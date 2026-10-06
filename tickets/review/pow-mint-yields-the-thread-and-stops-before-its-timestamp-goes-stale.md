description: Solving the proof-of-work puzzle a first registration needs used to lock up the machine until it was done — seconds on a desktop, minutes on a phone. The search now pauses every 50 ms so the machine keeps working, each try costs about a third as much, and it gives up before its answer would be too old for other machines to accept.
architecture: docs/cohort-topic.md#anti-dos
files: packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/test/cohort-topic/bootstrap-evidence-verifiers.spec.ts, docs/cohort-topic.md, docs/debugging.md
----

# The proof-of-work mint yields the thread and stops before its timestamp goes stale

GitHub: [#31](https://github.com/gotchoices/Optimystic/issues/31).

## What changed

A cold-start registration (`bootstrap: true` or `followOn: true`) at tier T2/T3 carries a proof of work: a nonce such that `RingHash.H(powPreimage(bound, nonce))` has `bits` leading zero bits (default 20). `createBootstrapEvidenceBuilder` in `packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts` used to search with a synchronous loop and no `await`, so the JavaScript thread did nothing else until it finished. Its T2/T3 branch is now:

- **Preimage built once** (`PowCandidate`). `powPreimage(bound, randomBytes(16))` is computed once per mint; each try writes a big-endian 4-byte counter into the low 4 bytes of the nonce region in place (a `DataView`), so the nonce is a random 12-byte prefix plus a counter. On a win the 16 nonce bytes are copied out (`slice`), since the buffer is reused. `maxIterations` is clamped to `2^32`, the most the counter can name.
- **Clock read every 256 tries** (`POW_CLOCK_STRIDE`), not every try.
- **Yield on a time slice** (`POW_SLICE_MS` = 50). Once a slice has run 50 ms the search awaits `setTimeout(0)` (`yieldToEventLoop`). Not a microtask (lets no timer or socket in) and not `setImmediate` (on React Native that runs inside the same JS batch).
- **Time budget** (`timeBudgetMs`, default `DEFAULT_POW_TIME_BUDGET_MS` = `powTimeBudgetFor(DEFAULT_REPLAY_MAX_AGE_MS)` = 30 s). It is measured **from the call**, not from the bound `timestamp`. The service stamps the timestamp synchronously just before calling, but from its own clock, which tests replace, so only the call is on the builder's clock. When the budget runs out the builder returns `undefined`, the same as the iteration cap. Either way it logs one line on `optimystic:db-p2p:cohort-topic`: `proof-of-work mint abandoned (<time budget spent | iteration cap reached>) after N ms and M tries at B bits …`.
- **A `now` clock seam** (default `Date.now`). Nothing uses it yet; the spec runs on real timers.
- **Host wiring** (`createCohortTopicHost` in `packages/db-p2p/src/cohort-topic/host.ts`). It passes `timeBudgetMs: powTimeBudgetFor(options.antiDos?.replayGuard?.maxAgeMs ?? DEFAULT_REPLAY_MAX_AGE_MS)`, so a deployment that narrows its replay window also narrows the mint budget. The ticket did not ask for this; it is one line, and it assumes the serving group uses the same window as this node.

The wire format, the preimage bytes and the verifier are unchanged.

Docs: the builder's header comment, the PoW bullet in [docs/cohort-topic.md §Anti-DoS](../../docs/cohort-topic.md#anti-dos) (the old "≈ `2^bits` hashes; capped so the register path never hangs"), and the db-p2p `cohort-topic` namespace row in `docs/debugging.md` (it now mentions the new log line). `yarn lint:docs` is clean.

## Measurements (Node 24.2, Windows 11, this dev machine)

- `setTimeout(0)` costs 15.28 ms on average over 200 calls; `setImmediate` costs 0.008 ms.
- Old loop body: 4.04 µs per try over 200 000 tries, with a 155-byte preimage built from a 38-byte participant id.
- New loop: an unsolvable mint with a 3 s budget made 1 956 352 tries, with a 10 ms interval firing 50 times (about one per 60 ms). That is 1.53 µs per try of wall time including the 15 ms yields, or about 1.18 µs of CPU per try. So a default 20-bit mint averages about 1.6 s of wall time here, against about 4.2 s for the old loop. Yield overhead is 23% of wall time on Windows; elsewhere a yield costs about 1 ms (Node on Linux/macOS) or 4 ms (browsers), which was not measured here.
- Eight default-difficulty (20-bit) mints, 10 ms interval alongside: 952 / 4601 / 2155 / 232 / 4216 / 543 / 3728 / 2692 ms (mean 2390 ms; the try count is geometric, so eight samples spread widely), with 16 / 76 / 35 / 3 / 70 / 9 / 62 / 45 ticks during each. Before the change it was 0 ticks for every mint.

## Tests

- **Added** `lets timers run during the search and gives up when its time budget is spent` (in `bootstrap-evidence-verifiers.spec.ts`). It runs an unsolvable mint (`bits: 256`, `maxIterations: 2^30`, which would take far longer than mocha's timeout, so only the budget can end it) with `timeBudgetMs: 300` and a 10 ms `setInterval`. It asserts the result is `undefined` and at least 3 ticks happened during the mint. Covers both the yield and the budget.
- **Changed** `mints a PoW (low bits) that the matching verifier accepts…` from `bits: 0` to `bits: 12`. At 0 every nonce passes the verifier, so the spec could not catch a nonce copied from the wrong bytes of the reused buffer. Mutation-checked: shifting `nonce()`'s slice by one byte failed it in 3 of 3 runs, and restoring it passes. It takes about 4096 tries, a few ms.
- The ticket asked for no separate byte-compatibility spec, and none was added.

Runs: the builder file and `host-antidos-coldstart.spec.ts` give 50 passing; all `test/cohort-topic/**` gives 262 passing, 4 pending; the full db-p2p `yarn test` gives 3239 passing, 68 pending. db-p2p `yarn typecheck` and eslint on the touched files are clean. db-core and db-p2p were rebuilt.

## Known gaps / things for the reviewer to weigh

- **Not measured on Hermes / a phone.** The per-try cost there is unknown, and the 256-try stride is sized on the assumption that a try is at most tens of times slower than on V8. If a try on Hermes is much slower, one stride can overrun the 50 ms slice. A slow phone can still use up the whole 30 s budget, give up, and register without evidence. A configured serving group refuses that registration, and the watch falls back to its periodic tail check. Whether a phone should mine at all is `blocked/cold-start-evidence-that-a-phone-can-afford`.
- **Tripwire parked as a `NOTE:` on `PowCandidate`.** The bound image is longer than 128 bytes, so the first two of the preimage's three SHA-256 blocks never change during a mint. Hashing from a saved midstate would cut each try to about a third of its cost, but `IRingHash` only has a one-shot `H`. Worth doing if phone mint time stays the limiting cost.
- **No cancellation.** If the node stops in the middle of a mint, the search keeps running (yielding as it goes) until it solves or the budget runs out, up to 30 s. Each yield's `setTimeout` keeps the Node event loop alive for that time. Before this change the whole mint ran synchronously, so this is no worse. An `AbortSignal` would need plumbing through the service's register builder.
- **The default clock is `Date.now`, not `performance.now`.** Nothing else in `src/` uses `performance`, and the replay guard also uses wall time. A backwards wall-clock jump during a mint postpones the yields and the budget, and the iteration cap still applies; a forward jump ends the mint early.
- **The integration suites were not run.** These include the "every machine in every cohort" spec, where the old ticket measured a 3.0 s median from watch to attached. `yarn test:integration` from the root would show whether that median dropped.
