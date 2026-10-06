description: Watching a collection over the network makes a phone solve a proof-of-work puzzle in one unbroken loop of pure-JavaScript hashing. On React Native that runs for minutes with no timers firing, the relay reservation lapses, and the app hangs. Supersedes the backlog ticket bug-first-registration-proof-of-work-freezes-the-node-for-seconds, which measured the same loop at about 4 s on Node.
architecture: docs/cohort-topic.md#anti-dos
files: packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts, packages/db-core/src/cohort-topic/ring-hash.ts, packages/db-core/src/cohort-topic/antidos/bootstrap-evidence-envelope.ts, packages/db-p2p/src/reactivity/subscription-manager.ts, docs/cohort-topic.md, docs/reactivity.md
repro: verified-by-reporter
severity: high
likelihood: normal-use
tradeoffs: The work is the anti-DoS cost of a cold start. Yielding and a cheaper nonce do not reduce that cost; lowering difficulty per platform does, and the serving group must still be able to check it.
----

# Cohort-topic bootstrap proof of work blocks the JS thread on React Native

GitHub: [#31](https://github.com/gotchoices/Optimystic/issues/31). Same defect as `tickets/backlog/bug-first-registration-proof-of-work-freezes-the-node-for-seconds.md` (Node: 12 mints from 445 ms to 10.4 s, mean 3.9 s; watch-to-attached median 3.0 s over 42 runs). Fold that ticket's measurements in and delete it when this one moves on.

## Verified in code

`createBootstrapEvidenceBuilder` (`packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts`), for T2/T3: `for (let i = 0; i < maxIterations; i++)` calling `randomBytes(16)` from `@libp2p/crypto` per iteration, `powPreimage(...)`, and `RingHash.H` — `@noble/hashes` sha256 (`packages/db-core/src/cohort-topic/ring-hash.ts`). No `await` inside the loop. Expected ~2^20 iterations (`DEFAULT_POW_DIFFICULTY_BITS = 20`), cap `DEFAULT_POW_MAX_ITERATIONS = 1 << 24`. The header comment still says "sub-second". Reactivity registers at T3 (`ReactivitySubscriptionManager`), so every first watch of a log block pays it.

## What the reporter saw (taleus / MyCHIPs on Sereus, cadre-rn 1.12, Optimystic 1.10.1)

With `strandReactivity` on and `optimystic.network_watch` tags, the app hung. The Hermes CPU profile was dominated by `powPreimage`, `meetsDifficulty` and noble `sha256` under the builder. No timers ran for minutes at a stretch (Android emulator; a Galaxy S7 is slower). The circuit-relay reservation lapsed, strand joins failed with `NO_RESERVATION`, and queries took 50 s or more. With `strandReactivity` off it all goes away, which is how they run phones now.

Repro: any RN kit node (sereus-chat, the cadre-rn reference app), enable `strandReactivity`, tag a table `with tags ("optimystic.network_watch" = true)`, open the inspector's profiler. Reporter offers the `.cpuprofile` and PRs for fixes 1 and 2.

## Suggested fixes (reporter's order of payoff)

1. Yield a macrotask every N iterations (the builder is already async), so timers, keepalives and relay refreshes keep running. `setTimeout(0)` is the portable yield.
2. Counter nonce: one random 16-byte prefix, then increment a counter, instead of `randomBytes(16)` per iteration (a native CSPRNG trip each on RN).
3. Injectable hash: let host options supply `IRingHash` (or `H`) so the RN kit can pass native SHA-256 (react-native-quick-crypto). Must be byte-identical to the verifier's hash.
4. Difficulty / time budget via host options (`bits`, `maxIterations`, a time cap). The serving group demands a minimum bit count, so a mobile node cannot simply mint fewer bits; this needs a design decision.

## TODO

- Reproduce on Node: a `setInterval` does not fire during a mint. Fix 1 and 2; spec that a timer fires during a mint.
- Decide 3 and 4 (hash injection is cheap; difficulty may need a human call).
- Correct the "sub-second" claim in the builder comment and docs/cohort-topic.md.
