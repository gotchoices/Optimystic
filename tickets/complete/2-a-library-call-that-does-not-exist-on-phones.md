description: Fixed two places in the networking package that called JavaScript functions a phone's engine does not provide — one of them on the path a phone takes to read any block it does not already hold — and added automated checks so the same mistake fails a code review instead of only showing up on a physical device.
files:
  - packages/db-p2p/src/dispute/client.ts (`sendChallenge`, line ~24)
  - packages/db-p2p/src/repo/client.ts (`processRepoMessage`, line ~59)
  - packages/db-p2p/src/logger.ts (`isAggregateError`, line ~115)
  - eslint.config.js (new `NO_ABORT_SIGNAL_TIMEOUT`, `NO_ABORT_SIGNAL_ANY`, `NO_PROMISE_WITH_RESOLVERS`, `NO_DOM_EXCEPTION`)
  - packages/db-p2p/readme.md (§ React Native)
  - packages/db-p2p/test/rpc-response-deadline.spec.ts (two new `sendChallenge` cases)
  - tickets/implement/rn-entry-throws-during-import-on-a-bare-phone.md (new follow-up ticket, filed rather than folded in — see "Deliberately not done" below)
difficulty: easy
----

# What changed

**`DisputeClient.sendChallenge`** (`dispute/client.ts`) called `AbortSignal.timeout(timeoutMs)`,
which Hermes (React Native's JS engine) does not implement. Replaced with an explicit
`AbortController` + `setTimeout`, cleared in a `finally` on every exit path — the same pattern
`network/relay-reservation.ts`'s `dialRelay` already uses (its own comment calls out
`AbortSignal.timeout` as "unreliable on Hermes", which is what led to this ticket). The existing
`timeoutMs`→`signal` contract (bounds the *response read*, not just the dial; the default
`DEFAULT_DIAL_TIMEOUT_MS` dial cap still applies even with no `timeoutMs`) is unchanged — only the
mechanism that builds `signal` changed.

**`RepoClient.processRepoMessage`** (`repo/client.ts`) — the RPC every block read/write against a
remote peer goes through — called `AbortSignal.any([options.signal, deadlineController.signal])`,
which Hermes also does not implement. This is the more consequential of the two: it is on the path
a phone takes to read any block it does not hold locally, so before a host's own polyfill patched
it, this threw a `TypeError` on every such call that carried a caller `signal`.

**This one is not a drop-in replacement for `AbortSignal.any`.** I initially planned to swap in the
`any-signal` npm package (already a transitive dependency via libp2p; the ticket itself suggested
it, and libp2p uses it for the same purpose). Testing it directly against Node's native
`AbortSignal.any` showed `any-signal`'s combined signal calls `AbortController.abort()` with **no
argument**, discarding whichever source signal's `.reason` actually fired and replacing it with a
generic `DOMException [AbortError]`. `RepoClient` depends on the specific reason surviving the
combine — `deadlineController.abort(new Error('RepoClient timeout'))` a few lines above only
produces the caller-facing `.message === 'RepoClient timeout'` (asserted by
`test/rpc-response-deadline.spec.ts`) if that exact reason reaches the caller. So I wrote a small
explicit combinator instead (also fixes a real listener leak: the old `AbortSignal.any` call
attached to a caller's `options.signal` with no corresponding removal, so a long-lived caller
signal reused across many `RepoClient` calls would accumulate one listener per call). Full
reasoning is in the code comment at the call site — read it before "simplifying" this back to
`any-signal`.

**`logger.ts`'s `isAggregateError`** did `err instanceof AggregateError` unguarded. If Hermes
doesn't define the `AggregateError` global (unconfirmed either way — needs a device), evaluating
that bare identifier throws a `ReferenceError`, on the error-*formatting* path — exactly where an
exception would otherwise go unreported. Guarded with `typeof AggregateError !== 'undefined'`
first, which never throws for an undeclared global.

**Lint** (`eslint.config.js`): added `no-restricted-syntax` entries banning `AbortSignal.timeout`,
`AbortSignal.any`, `Promise.withResolvers`, and `new DOMException` in `packages/*/src/**/*.ts`
(same scope as the existing `Buffer` ban from `1-block-transfer-uses-node-only-buffer-global`).
Verified each one fires (built a scratch file with all four, confirmed 4/4 errors, deleted it) and
that `yarn lint` is clean across the whole repo with the real fixes in place.

**Not banned, deliberately: `AbortSignal.prototype.throwIfAborted`.** Grepping only for the literal
spelling `AbortSignal.prototype.throwIfAborted` (matching the ticket's own verification) missed
that it's actually called as `signal?.throwIfAborted()` — an instance method — in
`libp2p-key-network.ts` and `network/open-protocol-stream.ts`. Both are legitimate, and the
readme's polyfill table already lists this as a required host polyfill (libp2p itself needs it).
Banning it would just move the requirement into this file without removing it, so I left it alone
and documented why in the eslint config.

**`readme.md` § React Native**: added a paragraph alongside the existing `Buffer` note stating
Optimystic's own code avoids `AbortSignal.timeout`/`.any`/`Promise.withResolvers`/`DOMException`
construction (pointing at the lint rule and the two fixed call sites), and a short "Dormant, not
yet reached" note that `@libp2p/keychain`'s AES-GCM and non-Ed25519 `@libp2p/crypto` key import
would throw on React Native's `crypto.subtle` (which only implements `digest`) — nothing in
Optimystic's own code path reaches them today (peer identity is Ed25519 via `@noble/*`), so this is
recorded as a tripwire rather than fixed.

**Tests**: added two cases to `test/rpc-response-deadline.spec.ts` — `sendChallenge` against a
silent peer with `timeoutMs` set (must reject within the deadline, mirroring every other
silent-peer case already in that file) and against a promptly-responding peer (must return the
vote). The existing `RepoClient rejects with "RepoClient timeout"` test already exercises the new
combinator's deadline-only branch; no existing test exercised the caller-`signal`-present branch of
`AbortSignal.any`/the new combinator, so that branch is covered by code review and the reasoning in
the code comment, not a dedicated test — worth a look if the reviewer wants deeper coverage there.

# Validation run

- `yarn lint` (repo-wide) — clean.
- `yarn workspace @optimystic/db-p2p build` (`tsc`) — clean.
- `yarn workspace @optimystic/db-p2p test` (full suite, `test/**/*.spec.ts`) — **2806 passing**, 62
  pending (pre-existing skips, unrelated to this change).
- `yarn check:rn` — passed (Metro bundle + legacy Hermes compile of the `/rn` entry). This only
  proves the bundle compiles, not that it runs correctly on Hermes — see "Known gaps" below.

# Deliberately not done (and why)

The ticket's own investigation surfaced a larger problem than the two call sites above:
`storage/raw-store-codec.ts` constructs `new TextEncoder()`/`new TextDecoder()` at **module
scope**, and that module is re-exported (transitively) by `rn.ts`, the React Native entry point —
so importing `@optimystic/db-p2p/rn` on a bare Hermes runtime with no `TextDecoder` polyfill
installed yet throws before any of the importing app's own code runs. A related instance:
`storage-repo.ts:1188` calls `structuredClone` (not module-scope, but same missing-global class).

I did **not** fix these here. The ticket's own "What to build" list (items 0–3) only covers the two
`AbortSignal` call sites, the `logger.ts` guard, and the lint rule; the module-scope finding is
extensively analyzed in the ticket's narrative but was explicitly left out of the numbered task
list, and the ticket itself flags it as something that "reshapes the ticket" and warns against
letting scope extension "turn into a project." `TextEncoder`/`TextDecoder`/`structuredClone` are
also used pervasively elsewhere in `db-p2p` and `db-core` (dozens of call sites) and are already
documented as required host polyfills in the readme — banning them via lint, as I initially
considered, would have broken that established "declare, don't remove" strategy for the class as a
whole. I filed **`tickets/implement/rn-entry-throws-during-import-on-a-bare-phone.md`** with the
specific fix already scoped (lazy-construct the codec's encoder/decoder; replace the one
`structuredClone` call site with a JSON-round-trip clone helper; update the readme to reflect the
narrower requirement) rather than executing it inline here.

Also not done, and not filed as tickets (genuinely conditional, not present defects):
- Lint rules for `ReadableStream`/`WritableStream`/`TransformStream`, `Symbol.asyncIterator`,
  `crypto.getRandomValues`, `crypto.subtle.digest`, or timer `.ref()`/`.unref()` — none has a
  first-party call site in `packages/*/src` today, so a rule would be pure prevention. Recorded as
  a `NOTE:` in `eslint.config.js` right above the new rule block, naming the condition under which
  it's worth revisiting (any of those gaining a first-party call site) and pointing back at this
  ticket's evidenced list for the full inventory.
- `cluster/cluster-repo.ts` and `libp2p-node-base.ts` call `.unref()` directly on timer handles
  (`this.expirationInterval.unref()`), whereas `relay-reservation.ts` wraps the same operation in a
  private `unref()` helper that no-ops via optional chaining if `.unref` doesn't exist. Both are
  "safe" today only because the readme already declares timer `.ref()`/`.unref()` as a required
  host polyfill (so a host targeting Hermes is expected to have already patched it in); I noticed
  the inconsistency but left it alone since it isn't reachable-and-broken, just less defensive than
  it could be. Flagging for the reviewer to judge whether it's worth its own ticket.

# Use cases / how to validate

- **`sendChallenge` timeout**: `packages/db-p2p/test/rpc-response-deadline.spec.ts` → `DisputeClient
  .sendChallenge gives up when the arbitrator goes silent (timeoutMs configured)` and the
  companion prompt-reply case.
- **`RepoClient` deadline + message contract**: `RPC response deadline (repo, leak fix)` describe
  block in the same file — in particular `RepoClient rejects with "RepoClient timeout" AND tears
  down the read`, which pins the exact message the new combinator has to preserve.
- **Lint catches the regression**: `yarn eslint <file>` on any file under `packages/*/src` that
  reintroduces `AbortSignal.timeout(...)`, `AbortSignal.any(...)`, `Promise.withResolvers()`, or
  `new DOMException(...)` should fail with a `no-restricted-syntax` error naming the replacement
  pattern.
- **Bundle-level regression backstop**: `yarn check:rn` (bundles the `/rn` entry with Metro,
  compiles with legacy Hermes) — this catches syntax Hermes can't parse, not missing globals a
  call only reaches at runtime, so it's a weak signal for *this* class of bug specifically; the
  lint rules are the real guard here.

# Known gaps for the reviewer

- No device-level verification that Hermes actually lacks `AggregateError` — the `logger.ts` fix
  is defensive regardless of the answer, but if the reviewer has device access, confirming either
  way would let a future ticket drop the guard if it turns out to be unnecessary (or keep it
  confidently if not).
- The `RepoClient` combinator's caller-`signal`-present-and-fires branch has no dedicated unit
  test (see "Tests" above) — covered by reasoning in the code comment and the full test suite
  passing, not by a targeted assertion.
- "Timer does not outlive the call" (both fixed call sites) is verified by code inspection
  (`clearTimeout` in every `finally`) rather than an active-handle-count test — no precedent for
  that test style exists elsewhere in this suite, so I matched the existing convention rather than
  introducing a new one.

# Review findings

Read the implement diff (7e9cfbaf) first, then every touched file plus `relay-reservation.ts` (the pattern cited) and readme § React Native.

**Correctness — checked, no defects.** `sendChallenge`: timer created only when `timeoutMs` is set, cleared in `finally`; dial cap unchanged. `RepoClient` combinator: handles a pre-aborted caller signal, forwards the firing source's `reason`, removes both listeners in `finally`; `once: true` plus explicit removal is harmless. `isAggregateError` `typeof` guard is correct. `any-signal` rejection reasoning is sound (it does drop the reason).

**Docs — found and fixed.** The readme said Optimystic's code does not call `AbortSignal.prototype.throwIfAborted`, which contradicts both the code (`libp2p-key-network.ts`, `open-protocol-stream.ts`) and the eslint comment. Reworded to say it is called and stays a required host polyfill. Also fixed "both linked in the code comment there" (nothing is linked there).

**Tests — gap found and fixed.** The implementer flagged no coverage for the caller-signal arm of the combinator. Added three cases to `test/rpc-response-deadline.spec.ts`: a caller abort's reason reaches the caller and tears down the read; an already-aborted caller signal rejects with its reason; a reused caller signal has zero net `abort` listeners after three calls. Mutation-checked the last one (deleting the `removeEventListener` in `finally` makes it fail).

**Lint rules — checked.** Selectors match only the static `AbortSignal.x(...)` / `Promise.withResolvers(...)` / `new DOMException` spellings; aliased access (`const A = AbortSignal; A.any(...)`) would slip through. Not worth hardening — the rule is a guard against the natural spelling, not an adversary. No action.

**Source hygiene — acceptable.** The combinator is inline in an already-long method with a long comment; extracting it to a helper would be slightly cleaner but it has one call site and the comment is the load-bearing warning against re-simplifying to `any-signal`. Left as is.

**Scope follow-up — confirmed filed.** `tickets/implement/rn-entry-throws-during-import-on-a-bare-phone.md` exists for the module-scope `TextEncoder`/`TextDecoder` and `structuredClone` findings. No new tickets from this review.

**Implementer-flagged `.unref()` inconsistency** (`cluster-repo.ts`, `libp2p-node-base.ts` call `.unref()` unguarded vs. `relay-reservation.ts`'s guarded helper) — not a defect: readme declares timer `.ref()/.unref()` a required host polyfill. Conditional only on that polyfill requirement being dropped; the existing eslint `NOTE:` already names timer `.unref()` in its not-banned list, so no further tripwire added.

**Unverified (needs a device):** whether Hermes defines `AggregateError`; the guard is safe either way.

**Validation:** `yarn lint` clean; `yarn workspace @optimystic/db-p2p build` clean; `yarn workspace @optimystic/db-p2p test` 2809 passing, 62 pending (pre-existing).
