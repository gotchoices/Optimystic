description: Solving the proof-of-work puzzle a first registration needs used to lock up the machine until it was done — seconds on a desktop, minutes on a phone. The search now pauses every 50 ms so the machine keeps working, each try costs about a third as much, and it gives up before its answer would be too old for other machines to accept.
architecture: docs/cohort-topic.md#anti-dos
files: packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/test/cohort-topic/bootstrap-evidence-verifiers.spec.ts, docs/cohort-topic.md, docs/debugging.md
----

# The proof-of-work mint yields the thread and stops before its timestamp goes stale

GitHub: [#31](https://github.com/gotchoices/Optimystic/issues/31).

## What landed

A cold-start registration (`bootstrap: true` or `followOn: true`) at tier T2/T3 carries a proof of work: a nonce such that `RingHash.H(powPreimage(bound, nonce))` has `bits` leading zero bits (default 20). `createBootstrapEvidenceBuilder` in `packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts` used to search in one synchronous loop. Now:

- The preimage is built once per mint (`PowCandidate`): a random 12-byte nonce prefix plus a big-endian 4-byte try counter written in place. The winning nonce is copied out. `maxIterations` is clamped to `2^32`.
- The clock is read every 256 tries. Once a 50 ms slice (`POW_SLICE_MS`) has run, the search yields with `setTimeout(0)`.
- The search gives up after `timeBudgetMs` (default 30 s, half the default 60 s replay window, via `powTimeBudgetFor`), measured from the call. It returns `undefined` just as the iteration cap does, and logs `proof-of-work mint abandoned (...)` on `optimystic:db-p2p:cohort-topic`.
- `createCohortTopicHost` derives the budget from this node's own `antiDos.replayGuard.maxAgeMs`.
- The wire format, preimage bytes and verifier are unchanged. The builder header, the PoW bullet in docs/cohort-topic.md §Anti-DoS and the db-p2p `cohort-topic` row of docs/debugging.md were updated.

Measured by the implementer on Node 24 / Windows 11: about 1.18 µs of CPU per try against 4.04 µs before, so a default mint averages about 1.6 s of wall time against about 4.2 s. A 10 ms interval fires during the mint, where before it fired 0 times. Not measured on Hermes or a phone.

## Review findings

Read the implement diff (`ticket(implement): pow-mint-yields-the-thread-and-stops-before-its-timestamp-goes-stale`) before the handoff.

- **Correctness of the reused preimage.** Checked that `powPreimage` in `packages/db-core/src/cohort-topic/antidos/bootstrap-evidence-envelope.ts` writes `image ‖ nonce`, so the last 16 bytes are the nonce. That makes the `DataView` over the last 4 bytes (it accounts for `byteOffset`) and the `slice` of the last 16 bytes correct. The verifier rebuilds the same bytes from the decoded 16-byte nonce. The spec's change from `bits: 0` to `bits: 12` makes a wrong-bytes copy fail (the implementer mutation-checked this). No issue found.
- **Timestamp and budget start.** `CohortTopicService.messageFactory` stamps `body.timestamp = this.clock()` synchronously, immediately before it awaits the builder, so measuring the budget from the call matches the timestamp's age in production. The replay guard (`packages/db-core/src/cohort-topic/antidos/replay-guard.ts`) refuses a register when `timestamp < now − maxAgeMs`, so half the window leaves room for the register to travel and be checked. No issue found.
- **Loop edges.** The budget is checked before the yield. A `maxTries` that is not a multiple of the stride is clamped per stride. When the cap is reached the try count it reports is exact. The yield is a macrotask, as intended. No issue found.
- **Host wiring.** The test harnesses that set a 24 h replay window (`reactivity-mesh-harness.ts`) also set `powDifficultyBits: 0`, so their mints solve at once and the 12 h budget they derive never comes into play. In any case the iteration cap still bounds the search. No issue found.
- **Minor, fixed: the unused `now` clock seam was removed.** Nothing passed it, and a frozen or fake clock passed later would have silently turned off both the yields and the budget, leaving only the iteration cap. The search now reads `Date.now()` directly. The builder header also now says "about 1.2 s of hashing", so it does not read as wall time, which also includes the yields.
- **Tripwire, parked as a `NOTE:` on `searchPowNonce`:** concurrent mints share the CPU while each budget runs on the wall clock. N simultaneous cold starts on a slow device could all give up where running them one after another would let the first few finish. The remedy, if that is ever seen, is a per-builder queue.
- **Tripwire, parked as a `NOTE:` on `searchPowNonce`:** a mint cannot be cancelled. A node stopped mid-search keeps searching for up to the budget. After stop, the walk's register fails the same way any in-flight network round trip already does across a stop, so this adds no new failure class. db-p2p's mocha runs without `--exit`, but no spec stops a node while a mint is in flight (every host spec uses `powDifficultyBits: 0`).
- **Tripwire already parked by the implementer:** the `NOTE:` on `PowCandidate` about midstate hashing (`IRingHash` has only a one-shot `H`). Left as is.
- **Tests.** The added budget-and-yield spec meets the bar: it pins the new contract (the budget ends the search, and timers run during it) and it needs real branching to pass. Its "at least 3 ticks" margin is safe at Windows' ~15 ms timer granularity over a 300 ms budget. The `bits: 12` change is justified above. Nothing was cut and nothing was added.
- **Docs.** Read docs/cohort-topic.md §Anti-DoS, the docs/debugging.md namespace row and the builder header. Grepped docs and sources for older claims ("sub-second", "never hangs", "2^bits"), and none remain stale. The db-core comment on `DEFAULT_POW_DIFFICULTY_BITS` ("~2^bits hashes to mint") is still accurate. `tickets/blocked/cold-start-evidence-that-a-phone-can-afford` still describes the builder correctly. `yarn lint:docs` is clean.
- **Not done here, as in the handoff:** no Hermes or phone measurement, and the integration suites (`yarn test:integration`) were not run. Both are out of reach for an agent run. Whether a phone should mine at all is `blocked/cold-start-evidence-that-a-phone-can-afford`.
- **Validation run:** db-p2p `yarn typecheck` is clean. eslint on the builder is clean. `test/cohort-topic/**` gives 262 passing and 4 pending. The builder specs pass.
