description: Solving the proof-of-work puzzle a first registration needs locks up the machine until it is done — seconds on a desktop, minutes on a phone, where the relay connection drops and the app hangs. Make the search pause regularly so the machine keeps working, make each try about three times cheaper, and give up before the answer would be too old for the other machines to accept anyway.
architecture: docs/cohort-topic.md#anti-dos
files: packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts, packages/db-p2p/test/cohort-topic/bootstrap-evidence-verifiers.spec.ts, packages/db-core/src/cohort-topic/antidos/bootstrap-evidence-envelope.ts, packages/db-core/src/cohort-topic/antidos/replay-guard.ts, packages/db-p2p/src/cohort-topic/host.ts, docs/cohort-topic.md
repro: verified
----

# The proof-of-work mint yields the thread and stops before its timestamp goes stale

GitHub: [#31](https://github.com/gotchoices/Optimystic/issues/31). Supersedes the deleted backlog ticket `bug-first-registration-proof-of-work-freezes-the-node-for-seconds` (its measurements are folded in below).

## Background

A cold-start registration (`bootstrap: true` or `followOn: true`) at tier T2 or T3 carries a proof of work: a nonce such that `RingHash.H(powPreimage(boundFields, nonce))` has `bits` leading zero bits (default 20, `DEFAULT_POW_DIFFICULTY_BITS` in `packages/db-core/src/cohort-topic/antidos/bootstrap-evidence-envelope.ts`). The participant finds it in `createBootstrapEvidenceBuilder` (`packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts`); the serving group checks it with one hash in `createPoWVerifier` (`packages/db-p2p/src/cohort-topic/bootstrap-evidence-verifiers.ts`). Reactivity registers at T3 (`ReactivitySubscriptionManager`), so the first watch of a log block, and the first watch after the log starts a new block, pays it. Production nodes always run the real verifier at T2/T3, because `libp2p-node-base.ts` always passes a reputation view into `antiDos`, which marks the gate configured.

The search is a synchronous `for` loop with no `await`, so nothing else on the JavaScript thread runs until it ends.

## Reproduction (Node 24, Windows 11 dev machine)

Four mints at tier 3 with default options, a 10 ms `setInterval` running alongside:

```
run 0: mint 17592 ms, interval ticks during the mint: 0
run 1: mint  2324 ms, interval ticks during the mint: 0
run 2: mint  7513 ms, interval ticks during the mint: 0
run 3: mint 14386 ms, interval ticks during the mint: 0
```

(The only ticks counted came in the 20 ms after each mint returned.) The deleted backlog ticket measured 12 mints at 445 ms to 10.4 s, mean 3.9 s, and a watch-to-attached median of 3.0 s over 42 runs of the "every machine in every cohort" integration spec, almost all of it the mint. The try count is geometrically distributed around `2^20`, hence the spread.

Per-try cost, 200 000 tries each, same machine:

| loop body | µs per try | ≈ time for 2^20 tries |
| --- | --- | --- |
| today: `randomBytes(16)` + `powPreimage` + `hash.H` + `meetsDifficulty` | 3.83 | 4.0 s |
| `randomBytes(16)` alone | 1.44 | 1.5 s |
| `powPreimage` alone (re-runs `JSON.stringify` + UTF-8 encode + a fresh allocation every try) | 0.90 | 0.9 s |
| preimage built once, counter written into it in place, `sha256` + `meetsDifficulty` | 1.19 | 1.2 s |
| `sha256` alone (180-byte preimage) | 1.15 | 1.2 s |

So a per-try random nonce and a per-try preimage rebuild are about two thirds of the cost; the hash is the rest.

The reporter (taleus / MyCHIPs on Sereus, cadre-rn 1.12, Optimystic 1.10.1, Hermes) saw the same loop at the top of the CPU profile, no timers for minutes, the circuit-relay reservation lapse (`NO_RESERVATION` on strand joins), and queries taking 50 s or more.

## A second defect inside the first: a slow mint produces evidence nobody will accept

The bound fields include the register's `timestamp`, set before the mint starts (`CohortTopicService`'s register builder in `packages/db-core/src/cohort-topic/service.ts` stamps `timestamp: this.clock()` and then awaits `buildBootstrapEvidence`). The serving group's replay guard drops a register whose timestamp is older than `DEFAULT_REPLAY_MAX_AGE_MS` = 60 s (`packages/db-core/src/cohort-topic/antidos/replay-guard.ts`). A mint that runs past the window — run 0 above took 17.6 s on a desktop; the reporter saw minutes on a phone — produces a register that is refused as stale on arrival. The work is wasted, and the walk mints again on the next attempt. Re-stamping is not possible: the timestamp is inside the hashed preimage.

## Fix

All in `createBootstrapEvidenceBuilder`. The wire format, the preimage bytes and the verifier are unchanged, so a minted nonce verifies exactly as before.

- **Yield on a time slice, not an iteration count.** Check the clock every so many tries (1024 is a reasonable stride: well under a millisecond of work) and, once the current slice has run for its budget (on the order of 25–50 ms), `await` a `setTimeout(0)` before continuing. Use `setTimeout`, not `setImmediate` or a resolved promise: a promise continuation is a microtask and lets no timer or socket callback in, and on React Native `setImmediate` runs inside the same JS batch, so native events still wait. A per-iteration-count yield is wrong because a `setTimeout(0)` costs about 15 ms on Windows Node (measured: 15.2 ms average over 1000) and about 4 ms in browsers once nested, so yielding too often would multiply the mint time. Pick the slice so the yield overhead stays a small fraction.
- **Build the preimage once.** Compute `powPreimage(bound, nonce)` (or `bootstrapBoundImage` plus a nonce region) a single time into one buffer, and write each try's nonce into the buffer's nonce region in place. The nonce stays 16 bytes: a random prefix drawn once per mint, plus a counter in the low bytes. `maxIterations` ≤ 2^32 fits a 4-byte counter; keep the cap check. Copy the nonce bytes out of the buffer when it wins, since the buffer is reused. The nonce does not need per-try randomness — the bound fields already make each mint's search space unique to its `(topic, tier, participant, timestamp)`.
- **A time budget below the replay window.** Add a `timeBudgetMs` option (default derived from `DEFAULT_REPLAY_MAX_AGE_MS`, e.g. half of it, so the register still has time to travel), measured from the bound `timestamp` (or from the call, if simpler — say which in the comment). When the budget runs out, return `undefined` exactly as the iteration cap does, and log it once with the elapsed time and try count, since on a slow device this is the line that explains why a cold start keeps being refused. A clock seam (`now?: () => number`) is fine if the test needs it; real timers are also fine.
- **Correct the comments.** The builder's header says the default is "~1 M, sub-second"; replace it with what it costs (the table above), and say that it yields and stops at the budget. Do the same in the PoW bullet of [docs/cohort-topic.md §Anti-DoS](../../docs/cohort-topic.md#anti-dos) (the "nonce search ≈ `2^bits` hashes; capped so the register path never hangs" sentence). `host.ts`'s `powDifficultyBits` comment can stay.

## What this does not fix

On Hermes the hash is pure JavaScript with no JIT, so even at a third of today's per-try cost a 20-bit mint will take far longer on a phone than the 1.2 s above (not measured; the reporter offered a `.cpuprofile`). After this lands a phone no longer hangs, but a cold start on a slow phone can spend the whole time budget, give up, and register without evidence, which a configured serving group refuses. The watch still wakes on its periodic tail check (30 s Core, 20 s Edge), so it degrades to polling rather than breaking. Whether a phone should mine at all is the decision in `blocked/cold-start-evidence-that-a-phone-can-afford`; this ticket is correct under every option there.

## Test

One spec beside the existing builder specs in `packages/db-p2p/test/cohort-topic/bootstrap-evidence-verifiers.spec.ts`: an unsolvable mint (`bits: 256`, a large `maxIterations`, a small `timeBudgetMs` such as 200 ms) with a short `setInterval` running alongside; assert the interval fired several times during the mint and the builder returned `undefined`. That covers both the yield and the budget. The existing "mints a PoW (low bits) that the matching verifier accepts" spec already pins byte-compatibility with the verifier — keep it passing; do not add a separate one.

## TODO

- Rewrite the T2/T3 branch of `createBootstrapEvidenceBuilder`: preimage built once, random prefix plus in-place counter nonce, clock check every stride, `setTimeout(0)` yield per time slice, `timeBudgetMs` option with a default below `DEFAULT_REPLAY_MAX_AGE_MS`, one log line on give-up.
- Replace the "sub-second" claims in the builder header and in docs/cohort-topic.md §Anti-DoS with measured cost and the new yield/budget behaviour.
- Add the one spec above; run `yarn workspace @optimystic/db-p2p test -- --grep "createBootstrapEvidenceBuilder"` and the cohort-topic specs (`host-antidos-coldstart.spec.ts`).
- Re-time a few default-difficulty mints on Node for the review handoff (expect roughly a third of today's time), and confirm a `setInterval` now ticks during them.
- `yarn lint:docs` after the docs edit.
