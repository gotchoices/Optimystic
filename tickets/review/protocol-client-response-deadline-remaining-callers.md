description: A silent peer could still freeze cluster, sync, dispute, and transaction requests forever; this work wires the existing "give up if no reply" deadline into all of those paths and fixes a stream leak in the transaction client. Review the new deadline defaults and the leak fix.
prereq:
files: packages/db-p2p/src/rpc-deadline.ts, packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/sync/client.ts, packages/db-p2p/src/dispute/client.ts, packages/db-p2p/src/repo/client.ts, packages/db-p2p/test/rpc-response-deadline.spec.ts, packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/cluster/spread-on-churn.ts
difficulty: medium
----

# Review: response deadline for the remaining ProtocolClient callers

## What was built

`ProtocolClient.processMessage` already supported `dialTimeoutMs` / `responseTimeoutMs` / parent
`signal` and actively `stream.abort(...)`s the response read on expiry; only the block-transfer path
used it. This work wired the **same** primitive into the four remaining subclasses and fixed a
stream-leak in the repo client. No wire-protocol or server-handler changes.

### New shared module — `src/rpc-deadline.ts`
- `RpcDeadlineOptions = { signal?, dialTimeoutMs?, responseTimeoutMs? }`.
- `DEFAULT_DIAL_TIMEOUT_MS = 3000`, `DEFAULT_RESPONSE_TIMEOUT_MS = 10000` — **lifted verbatim from
  `spread-on-churn.ts` (`pushDialTimeoutMs` / `pushResponseTimeoutMs`)**, the codebase's reference
  convention.
- `withRpcDeadlineDefaults(options)` merges with `??` so an absent key gets the default but an
  explicit value (incl. a deliberate `0`, which `processMessage` reads as "no cap") is honored;
  `signal` has no default.

### cluster / sync / dispute (simple forwarders + client-level defaults)
- **`cluster/client.ts`** — `update(record, hop = 0, options?)`. Forwards `withRpcDeadlineDefaults(options)`
  to `processMessage`; threads the **original** `options` (not re-defaulted) through the redirect
  recursion `nextClient.update(record, hop + 1, options)` so a redirected hop keeps a deadline (it
  re-applies its own defaults). `ICluster.update(record)` is unchanged and still satisfied (the extra
  params are optional).
- **`sync/client.ts`** — `requestBlock(request, options?)`, forwards merged defaults.
- **`dispute/client.ts`** — `sendResolution(resolution, options?)`, forwards merged defaults.
  `sendChallenge(challenge, timeoutMs?)` **preserves** its `timeoutMs`→`AbortSignal.timeout` contract
  (which, post-`processMessage`-deadline-work, now genuinely tears down the *read*, not just the dial)
  and additionally passes `dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS` so an unreachable arbitrator fails
  the dial fast even when no `timeoutMs` was given. It does **not** add a response cap when `timeoutMs`
  is absent (response semantics preserved); in practice `dispute-service.ts:331` always passes a
  `timeoutMs`.

### repo/client.ts — the leak fix (most scrutiny here)
Replaced the leaky `Promise.race([processMessage(), setTimeout(reject('RepoClient timeout'))])` —
whose losing branch left the inner stream read running and leaked a pending read + stream on every
timed-out RPC to a silent peer — with an `AbortController` whose **abort reason is
`new Error('RepoClient timeout')`**, combined with the caller's `options.signal` via
`AbortSignal.any([...])`, passed as `signal` into `super.processMessage(...)`. Because `processMessage`
forwards `signal` to the read and rethrows `signal.reason` on abort, the deadline now genuinely
cancels the inner read while the caller still observes `.message === 'RepoClient timeout'`. `timer` is
cleared in `finally`. The redirect retry still passes the **original `options`** and rebuilds its own
deadline (unchanged). Deliberately **no `responseTimeoutMs`** — the combined signal already bounds the
read; a second shorter cap would surface as `ResponseTimeoutError` and mask the `'RepoClient timeout'`
message (documented in-code).

`AbortSignal.any` confirmed available: Node ≥18.17/20.3, `@types/node` ^22 (root) / ^25 (db-p2p);
`AbortSignal.timeout` already compiled in this file's sibling. Build (`tsc`) is clean.

## How to validate

- Build / type-check: `yarn workspace @optimystic/db-p2p build` → exit 0 (passed).
- Targeted: `yarn workspace @optimystic/db-p2p exec node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/rpc-response-deadline.spec.ts" --reporter spec` → **9 passing**.
- Full suite: `yarn workspace @optimystic/db-p2p test` → **1039 passing, 33 pending, exit 0**. (The
  `cohort-topic cold-start: parent registration ... Error: parent unreachable` console line is an
  expected error-path log emitted by a *passing* test, not a failure. No `.pre-existing-error.md` was
  needed.)

### Test coverage added (`test/rpc-response-deadline.spec.ts`)
Mirrors the silent-peer model from `protocol-client-dial-timeout.spec.ts` / `block-transfer-roundtrip.spec.ts`
(a stream that dials OK, never yields; `abort(err)` ends the never-fed read). Per client:
- **Silent-peer timeout** (tight `responseTimeoutMs: 80` override, `this.timeout(2000)` so a regression
  fails fast): cluster/sync/dispute reject with `ResponseTimeoutError` (`code === RESPONSE_TIMEOUT`);
  repo rejects with `Error('RepoClient timeout')` — all bounded `< 1500ms`.
- **Repo leak assertion**: asserts the silent stream's `abort()` *was* called (`aborted() === true`) —
  the decisive proof the deadline tears down the inner read rather than leaking it.
- **Happy path** (deadline configured, prompt canned reply): each client succeeds and returns the
  decoded payload.
- **Repo redirect**: first dial returns a redirect envelope, second returns the result; asserts the
  retry happens (`dialCount === 2`) and the rebuilt deadline doesn't break it.

## Known gaps / what the reviewer should scrutinize (treat tests as a floor)

1. **Behavior change — every cluster/sync/dispute request now has a default 10s response cap and 3s
   dial cap.** This is intended per the fix ticket, but the reviewer should sanity-check that 10s is
   actually generous enough for the *slowest legitimate* path on each protocol:
   - Cluster `update` participates in consensus; if a member can legitimately take >10s to reply
     under load, this would now surface as `ResponseTimeoutError` where it previously waited. The
     `spread-on-churn` numbers were chosen for a push/replicate path, not necessarily consensus.
   - Sync `requestBlock` returns an archive; a large block/slow link could exceed 10s. Consider
     whether sync callers (`libp2p-node-base.ts:537/626`, `restoration-coordinator-v2.ts:167`) should
     pass a larger `responseTimeoutMs`.
   No caller currently passes an explicit override, so all of them now inherit 10s/3s. If any path
   needs longer, that's a follow-up wiring change (defaults are overridable by design).

2. **Repo dial-phase-deadline error identity is not asserted.** When the deadline fires during the
   *dial* (rather than the response read) and `dialTimeoutMs` is also set, `processMessage` may
   surface a generic abort error instead of `'RepoClient timeout'` (documented as acceptable in the
   ticket). The tests only cover the response-phase case (no `dialTimeoutMs`), which deterministically
   yields `'RepoClient timeout'`. A reviewer wanting full coverage could add a dial-phase case.

3. **Happy-path tests use canned-responder streams, not a real registered server handler** (unlike
   `block-transfer-roundtrip.spec.ts`, which round-trips through the actual service). They exercise the
   client's encode→decode and the deadline machinery, but not a real server. This matches the fact
   that cluster/sync/dispute have no single in-memory handler harness; still a fidelity gap worth
   noting.

4. **`AbortSignal.any` lifecycle.** The composite signal and `deadlineController` are GC'd after the
   call; the timer is `clearTimeout`'d in `finally`, and `processMessage` removes its own listeners in
   its `finally`. Confirm no retained references keep a controller/listener alive across a redirect
   chain (each hop creates a fresh controller; the parent's is cleared before recursion returns).

5. **`sendChallenge` with no `timeoutMs`** now caps the dial (3s) but leaves the response uncapped —
   intentional to preserve the existing contract. If a future caller invokes `sendChallenge` without a
   `timeoutMs`, a silent arbitrator that *connects* would still hang the read. The only current caller
   passes a `timeoutMs`. Decide whether that asymmetry should be tightened.
