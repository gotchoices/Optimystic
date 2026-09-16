description: One file in the networking package calls a JavaScript timer function that does not exist on the engine React Native uses, so that code path would fail on a phone. A neighbouring file already avoids the same call and says why in a comment, so this looks like an oversight rather than a decision.
prereq:
files:
  - packages/db-p2p/src/dispute/client.ts (line 32, `sendChallenge` — `AbortSignal.timeout(timeoutMs)`; the only use left in library source)
  - packages/db-p2p/src/network/relay-reservation.ts (line 533, `dialRelay` — the precedent: an explicit controller "rather than `AbortSignal.timeout`, which is unreliable on Hermes", and it doubles as the stop path)
  - packages/db-p2p/eslint or the package's lint configuration (wherever the `no-restricted-globals` ban on the `Buffer` global from `1-block-transfer-uses-node-only-buffer-global` lives — the same class of guard belongs here)
  - packages/db-p2p/readme.md (§ React Native, if it lists the engine's gaps)
difficulty: easy
----

# Why

Found 2026-09-16 by the session driving the React Native reference app on a physical Android phone,
while reading for Hermes hazards after that night's run. It did **not** bite on the device, because
the dispute path was never exercised — which is exactly why it is worth fixing now rather than when a
user finds it.

`DisputeClient.sendChallenge` builds its deadline with `AbortSignal.timeout(timeoutMs)`. Hermes does
not provide `AbortSignal.timeout`. This repository already knows that: `relay-reservation.ts` uses an
explicit `AbortController` plus a timer instead, and its comment says so in as many words —
"unreliable on Hermes". One file follows the rule and the other does not, with nothing to keep them
in step.

Verified at `0f963518`: these are the only two occurrences in `packages/*/src`. Test files use
`AbortSignal.timeout` freely and may keep doing so — they run under Node.

Note that `yarn check:rn` cannot catch this. It bundles the RN entry with Metro and compiles it with
Hermes; a call to a function that does not exist compiles perfectly well and fails only when reached.
A static rule is what closes it.

# What to build

1. **Replace the call** in `sendChallenge` with the pattern `relay-reservation.ts` already uses: an
   explicit `AbortController` with a timer that is cleared on every exit path, success or throw. Keep
   the existing `timeoutMs` → `signal` contract exactly as the comment above it describes — the
   signal must still tear down the *response read*, not merely the dial, and the default dial cap
   must still apply when no `timeoutMs` is given. A leaked timer here would hold a stopped node
   alive, which this repository has already been bitten by once
   (`BlockTransferCoordinator.withTimeout`), so clearing it is part of the work, not a nicety.
2. **Add the static guard**, mirroring the `Buffer` global ban that came out of
   `1-block-transfer-uses-node-only-buffer-global`: a lint rule that fails on `AbortSignal.timeout`
   in library source, with an error message naming the replacement pattern and pointing at
   `relay-reservation.ts`. Scope it so tests are unaffected.
3. **Check for siblings while you are there.** The same class of gap — a platform API present in Node
   and absent in Hermes — has already produced `Buffer`, `structuredClone`, `TextDecoder` and static
   class blocks in this repository. If the guard is cheap to extend to the ones already known and
   documented, extend it; if that turns into a project, file it rather than doing it here.

# Edge cases & interactions

- **Do not change the timeout semantics.** The comment above line 32 records a deliberate decision
  about what the signal bounds; preserve it, and keep the comment accurate if the mechanism beneath
  it changes.
- **`sendResolution` sits just below** and takes `RpcDeadlineOptions` instead; it is not affected,
  but read it to make sure the two stay consistent in how a deadline reaches `processMessage`.
- **A test that pins this** should assert the behaviour (the challenge gives up after `timeoutMs`,
  and the timer does not outlive the call), not merely that the string is absent — the lint rule
  covers the string.

# TODO

- Replace the call, clearing the timer on every path.
- Add the lint rule and confirm it fails on the old shape.
- Run the dispute tests plus `yarn lint`, `yarn build`, `yarn workspace @optimystic/db-p2p test`, and
  `yarn check:rn`.
