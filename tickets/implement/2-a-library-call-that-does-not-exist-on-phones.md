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
3. **Extend the guard to the siblings, using the list below.** The same class of gap — a platform API
   present in Node and absent in Hermes — has already produced `Buffer`, `structuredClone`,
   `TextDecoder` and static class blocks in this repository. The RN session has now supplied an
   evidenced list (next section). Add the ones that are (a) statically detectable and (b) plausible
   in this repository's library source; if extending it turns into a project, file that rather than
   growing this ticket.

# The evidenced list (2026-09-16, from the device session)

Every entry below is backed by `reference-app-rn/polyfills/hermes.js` in the sereus reference app,
where each polyfill names the consumer that needed it. That file is the artefact to read before
writing the rule — it is a record of what actually broke on hardware, not a compatibility table.

- **`AbortSignal.timeout`** — this ticket's subject, found on the device.
- **`AbortSignal.any`** — same family, same session.
- **`AbortSignal.prototype.throwIfAborted`**.
- **`Promise.withResolvers`** — needed by libp2p/utils, ping, yamux, it-queue, mortice and
  abort-error. Third-party, so a lint rule over our source will not catch it; it is a reason the RN
  entry needs its own runtime check rather than only a static one.
- **`structuredClone`** — used by db-core's transform tracker, cache-source and coordinator. Already
  known here; confirm whether our source still reaches it.
- **`TextDecoder`** — `uint8arrays` touches it at module scope, and its absence made yamux's default
  export `undefined`, which is the kind of failure that looks like anything but a missing global.
- **`ReadableStream` / `WritableStream` / `TransformStream`**.
- **`Symbol.asyncIterator`** — absent on some Hermes builds.
- **`crypto.getRandomValues`** and **`crypto.subtle.digest`**.
- **Node-style timer handles** — Hermes returns plain numbers, so `.ref()` / `.unref()` do not exist.
  Worth a rule of its own, since this repository clears and holds timers deliberately.
- **`DOMException` construction** — not guaranteed under Hermes; the reference app's abort reason
  falls back to a named `Error`. Worth banning in library source for the same reason.

**One that a lint rule cannot catch, recorded so it is not forgotten:** `WebSocket.bufferedAmount` is
a property, not a call — and per that session it is the one that actually broke every dial. A static
rule will not see it. If the guard is to be honest about its coverage, say in its documentation that
property-shaped gaps are out of scope and name this one as the known example.

This also sharpens the `check:rn` point above: every item here bundles and compiles cleanly and fails
only when reached, which is exactly how the device session found them.

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
