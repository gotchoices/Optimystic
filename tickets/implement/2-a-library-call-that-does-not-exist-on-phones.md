description: Two files in the networking package call JavaScript functions that do not exist on the engine React Native uses. One of them is on the path a phone takes to read any block it does not already hold, so on a phone without a host-supplied workaround that read fails outright. A neighbouring file already avoids the same class of call and says why in a comment.
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

Verified at `0f963518`: those are the only two occurrences **of `AbortSignal.timeout`** in
`packages/*/src`. Test files use it freely and may keep doing so — they run under Node.

## Correction (2026-09-16 01:2x): that verification was too narrow, and the real exposure is worse

The grep behind it looked for `AbortSignal.timeout`, so it could not have found anything else. The
reporting session then found the one that matters:

**`packages/db-p2p/src/repo/client.ts:91` calls `AbortSignal.any`**, which Hermes also lacks:

```ts
const combinedSignal = options?.signal
  ? AbortSignal.any([options.signal, deadlineController.signal])
  : deadlineController.signal
```

That is **`RepoClient`'s remote block RPC** — the path a phone takes to read anything it does not hold
locally. Before the reference app's polyfill went in, every such call carrying a caller signal threw
`TypeError: AbortSignal.any is not a function` on device. It is signal-conditional, which is why it
was not the first thing to break: the dial failures masked it.

The consequence to state plainly, because it is the real finding: **optimystic is not React
Native-safe on its own.** It runs on a phone only because a host application happens to polyfill a
web API on its behalf, and nothing declares that dependency. Either remove the dependency or declare
it. The reporting session's recommendation, which looks right, is to use the **`any-signal`**
package — libp2p itself uses it, it degrades where the global is missing, and it removes its
listeners, so it also fixes a leak this call site has today. (They also corrected an earlier claim of
theirs: libp2p does *not* call `AbortSignal.any` heavily, it uses `any-signal` — so this call site is
the main thing driving the polyfill.)

**A second, quieter one in our source:** `packages/db-p2p/src/logger.ts:115-116` tests
`err instanceof AggregateError` before falling back to a duck-typed check. If Hermes does not provide
the `AggregateError` global, evaluating the identifier throws a `ReferenceError` and the fallback is
never reached — on an error-formatting path, where the diagnostics matter most. Whether Hermes
provides it could not be settled from the tree and needs a device; the code can be made safe either
way by ordering the duck-typed test first or guarding with `typeof`. The two `as AggregateError`
casts in `network-transactor.ts` (585, 1149) are type-level only and safe.

**Dormant, recorded so it is not rediscovered:** React Native's `crypto.subtle` provides only
`digest`, so ECDSA/RSA import-export and `@libp2p/keychain`'s AES-GCM would throw if reached. Nothing
reaches them today — the phone uses Ed25519 through noble.

## The worst one, found by grepping the object instead of the method

The lesson from the correction above is that the question "what does this platform gap touch" has to
be asked of the **object** (`AbortSignal\.`), not the method. Applying that to every platform global
at once, across `packages/*/src`, turns up something bigger than any single call:

**`packages/db-p2p/src/storage/raw-store-codec.ts:21-22` constructs `new TextEncoder()` and
`new TextDecoder()` at MODULE SCOPE**, and Hermes provides neither natively. That module is imported
by `kv-raw-storage.ts` and `cached-raw-storage.ts`, and `src/rn.ts` — the React Native entry —
exports both (lines 33 and 36), along with `storage-repo.js` (line 44).

So on Hermes, without a host-supplied polyfill, **importing `@optimystic/db-p2p/rn` throws while the
module graph is still loading**. Not a code path that fails when reached — the entry point itself.
That is the strongest possible form of "not RN-safe on its own", and it is the same failure shape the
device session described for `uint8arrays` touching `TextDecoder` at module scope and leaving yamux's
default export `undefined`.

Also on that entry: **`storage-repo.ts:1188` calls `structuredClone`** (twice, on the materialization
path), which Hermes likewise does not provide. db-core's transform tracker, cache-source and
coordinator were already known to use it.

`test/entry-parity.spec.ts` cannot see any of this: it compares the two entries' module lists, which
are identical by design. The gap is what those modules *evaluate*, not which ones they are.

**This reshapes the ticket.** Fixing `RepoClient` and the dispute client leaves a phone that still
cannot import the entry without help. Two branches were considered:

- **Declare** the required polyfills in one documented place, readme and reference app agreeing.
- **Remove the dependency** — lazy construction instead of module scope for the codec, `any-signal`
  for the combiner, an explicit clone helper instead of `structuredClone`.

**It is not a choice between them, and that is the point.** Even with every first-party use removed,
the RN entry still cannot be imported on a bare Hermes runtime, because the *dependency graph* needs
`TextDecoder` before our code runs: `multiformats` and `yamux` construct `new TextDecoder('utf8')` at
module scope (diagnosed independently in the sereus reference app — see below), and `dial-queue.js`
in libp2p throws `AggregateError` unconditionally. **Those we cannot fix, only require.**

So the honest answer is both, with the line between them stated: fix what is ours, and declare what
is not, as a *requirement* rather than a hope. "We will fix this" and "we cannot fix this, only
require it" are different commitments and should not be blurred into one list. The second branch is
still worth doing on its own merits — lazy construction and a clone helper cost almost nothing and
remove a whole class of first-party exposure — but it should not be sold as making the package
self-sufficient on Hermes, because it will not.

## Prior art to take rather than rebuild (another repository, read before designing)

The sereus reference apps have already walked this ground, and the session tending that repo offered
the artefacts:

- **`packages/reference-app-ns/src/polyfills/audit.ts`** enumerates the globals a phone runtime must
  provide and reports each at boot as `native`, `polyfilled` or `MISSING`. Its list already contains
  `TextEncoder`, `TextDecoder` and `structuredClone` — precisely the three this entry evaluates at
  import time. If the declaration branch happens, that list is the natural seed, and it has the
  advantage of being maintained against a real device rather than derived by reading imports.
- **`polyfills/hermes.ts:63`** in that app carries the same diagnosis reached here independently: a
  module-scope `new TextDecoder('utf8')` in the dependency graph means the polyfill must be installed
  before that module is evaluated.

Two caveats that came with the offer, worth honouring: the NS app is **ahead of the RN app** — RN's
`index.js` gets the ordering right and says so in a comment, but nothing enforces it and there is no
audit or import-order test, so the ordering there is a convention rather than a guarantee (their
`implement/0-rn-polyfill-guard-and-audit` is closing that). And the NS list is what *that app* needed:
a floor for this entry, not a ceiling.

Whatever this ticket lands, the requirement belongs somewhere a consumer will actually meet it —
`packages/db-p2p/readme.md` § React Native at minimum — and the RN checklist there should be checked
against the audit list rather than against this ticket.

Note that `yarn check:rn` cannot catch this. It bundles the RN entry with Metro and compiles it with
Hermes; a call to a function that does not exist compiles perfectly well and fails only when reached.
A static rule is what closes it.

# What to build

0. **Fix `RepoClient` first.** It is the one with a user-visible consequence — a phone that cannot
   read a block it does not hold. Prefer `any-signal` over a hand-rolled combiner, and confirm the
   listener cleanup, since the current call site leaks. Then `logger.ts`'s `AggregateError` test,
   which is a two-line reordering.
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
