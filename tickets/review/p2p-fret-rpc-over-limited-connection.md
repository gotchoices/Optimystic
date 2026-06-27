description: Peer-discovery (FRET) can now talk directly between two nodes that only reach each other through a relay; the relay-topology acceptance test that used to randomly skip now passes reliably.
prereq:
files:
  - C:/projects/Fret/packages/fret/src/rpc/protocols.ts            (UPSTREAM — new openRpcStream + isLimitedConnection helper)
  - C:/projects/Fret/packages/fret/src/rpc/neighbors.ts           (UPSTREAM — fetch/announce use openRpcStream, requireExisting)
  - C:/projects/Fret/packages/fret/src/rpc/ping.ts                (UPSTREAM — sendPing uses openRpcStream)
  - C:/projects/Fret/packages/fret/src/rpc/maybe-act.ts           (UPSTREAM — sendMaybeAct uses openRpcStream)
  - C:/projects/Fret/packages/fret/src/rpc/leave.ts               (UPSTREAM — sendLeave uses openRpcStream)
  - C:/projects/Fret/packages/fret/package.json                   (UPSTREAM — 0.5.0 -> 0.5.1)
  - package.json                                                   (root resolutions — added p2p-fret portal entry)
  - packages/db-p2p/package.json                                  (p2p-fret ^0.5.0 -> ^0.5.1)
  - packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts  (stabilization precondition rewritten)
difficulty: medium
----

# Review: FRET wire RPCs over circuit-relay (limited) connections

## What shipped (two repos)

This was a cross-repo change. The substantive fix lives **upstream in the sibling
Fret checkout** (`C:/projects/Fret`, package `p2p-fret`); optimystic consumes it
via a yarn-berry `portal:` resolution.

### Upstream (Fret repo, committed there as `f46c82e` — NOT in optimystic history)
`p2p-fret` 0.5.0 → **0.5.1**. All four wire RPCs opened their libp2p stream
without `runOnLimitedConnection`, so libp2p rejected the stream over a
circuit-relay ("limited") connection. New shared helper `openRpcStream` in
`rpc/protocols.ts`:

- filters to **open** connections (`status === 'open' && typeof newStream === 'function'`);
- **prefers a DIRECT** connection, falls back to a limited one (`open.find(c => !isLimited(c)) ?? open[0]`);
- opens with `{ runOnLimitedConnection: true, negotiateFully: false }`;
- `dialProtocol` fallback uses the same flags, unless `requireExisting` is set.

Call sites: `fetchNeighbors`/`announceNeighbors` pass `requireExisting: true`
(preserving their no-connection skip / empty-snapshot churn guard);
`sendPing`/`sendMaybeAct`/`sendLeave` keep the dial fallback. Mirrors the in-repo
precedent `Libp2pKeyPeerNetwork.connect()`.

### optimystic (this working tree — runner commits)
- root `package.json`: `"p2p-fret": "portal:../Fret/packages/fret"` in `resolutions`
  (mirrors the existing `@quereus/quereus` portal). `node_modules/p2p-fret` is now
  a symlink to the Fret checkout; the dist it serves contains the fix.
- `packages/db-p2p/package.json`: spec `^0.5.0` → `^0.5.1` (records intended floor).
- `packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts`:
  **stabilization precondition rewritten** (see "The real root cause" below).
- `yarn.lock`: portal resolution recorded.

## The real root cause of the test skip — READ THIS

The ticket's premise was "the RPC fix will make the acceptance spec stop
`this.skip()`-ing on FRET stabilization." **That attribution turned out to be
wrong, and the reviewer should weigh this.** Empirically (instrumented + diagnostic
runs):

1. **The RPC fix works and is genuinely needed for production.** With temporary
   stderr instrumentation in `openRpcStream`, a single relay-topology run showed
   **~81 RPC stream opens succeeding over LIMITED (circuit-relay) connections**
   (40 `neighbors`, 40 `ping`, 1 `leave`), versus only ~6 transient EOF/abort
   failures out of ~250 opens. The pre-fix code would have failed all 81. So FRET
   gossip now runs directly over relay-only links — the production win.

2. **But that is NOT why the test was skipping.** A one-shot diagnostic at the
   skip point printed both nodes' FRET rings and the cohort:
   ```
   [DIAG] A=jeQaEK cohort=[r524we, jeQaEK] storeIds=[kPnuz6, jeQaEK, r524we]
   [DIAG] B=kPnuz6 cohort=[r524we, jeQaEK] storeIds=[kPnuz6, jeQaEK, r524we]
   [DIAG] want A=jeQaEK B=kPnuz6 relay=r524we
   ```
   **Both rings were fully converged** (each held A, B, *and* relay). The skip
   fired because the old precondition required `assembleCohort(probe, 2)` to equal
   `{A,B}` for a single fixed `probe` — but the relay is itself a FRET participant
   in the keyspace, and for a large fraction of random per-run peer-id layouts it
   ranks in the top-2 for that probe and crowds a storage node out of the size-2
   cohort. That is a **coordinate lottery**, independent of the RPC fix.

3. Convergence in this 3-node topology comes from `peer:connect` (FRET upserts the
   peer on connect, including over the relayed A↔B link) — so it happens even
   without the RPC fix. The old test was bimodal (~1/3 real pass, ~2/3 skip)
   *because of the lottery*, not because of the RPC.

**The fix that makes the test reliable** is therefore the precondition rewrite:
gate on actual convergence — both nodes' `exportTable()` rings hold both A and B —
instead of the lottery-prone cohort-top-2 proxy. The downstream keyspace-search
loop (24 block ids) already absorbs per-probe cohort variance, so the real
relayed-write assertions are reached every run. The precondition is now an
`expect(...)` rather than a `this.skip()` (convergence is reliable; a meaningful
regression guard).

## Validation performed

- **Fret suite:** `yarn workspace p2p-fret test` → **232 passing** (~3m). Green.
- **db-p2p build:** `yarn workspace @optimystic/db-p2p build` → clean (no type
  breakage at the p2p-fret consumption boundary or in the edited spec).
- **db-p2p unit suite:** `yarn test` → **1045 passing, 36 pending, 0 failing**
  (~35s). The pending are env-gated integration specs; the lone "parent
  unreachable" line is expected console output from a passing error-path test.
- **Acceptance spec** (`OPTIMYSTIC_INTEGRATION=1`, single file): ran clean
  **5×** post-fix → **5/5 passing** in ~280–460 ms each, all reaching and passing
  the real `pend` super-majority + `commit` consensus assertions (no skip, no
  pending). Pre-fix the same spec skipped on ~4–5 of 6 runs.

Run the acceptance spec yourself with:
```
OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/multi-coordinator-write-relay.integration.spec.ts" --reporter spec 2>&1 | tee /tmp/fret-relay-it.log
```
(from `packages/db-p2p`). Note the spec's setup is fast on loopback (~300 ms); a
real pass and the old fast "lottery" pass look alike on the clock — that is
expected, not an artifact.

## Use cases / what to scrutinize

- **Cross-repo durability.** The Fret fix is committed in `C:/projects/Fret`
  (`f46c82e`), outside optimystic's history. The portal resolution points at that
  local sibling checkout — if it moves or its `dist/` goes stale, optimystic
  `yarn install` / the symlinked dist breaks. **Durable fix = publish
  `p2p-fret@0.5.1` to npm and drop the portal back to the plain version**
  (human/CI step, intentionally not done here).
- **Does the acceptance test actually exercise the RPC fix?** Honestly: not
  strictly. This 3-node topology converges via `peer:connect` regardless of the
  RPC change, so the spec passing is necessary-but-not-sufficient evidence for the
  fix. The fix's value is demonstrated by the instrumentation (81 successful
  LIMITED opens), not by this test. **Consider whether a dedicated test belongs**
  that isolates direct A↔B FRET gossip over a limited link where `peer:connect`
  does NOT already populate the ring (e.g. a 4th peer reachable only transitively),
  either as a Fret-level unit test or a db-p2p integration spec. Filed as a
  follow-up candidate, not built here.
- **Test-logic change.** I modified an acceptance spec's precondition to make it
  pass. The change is justified (the old precondition was a lottery-prone
  false-negative; stores were proven converged) but it is a behavioral change to a
  test — verify the new convergence gate matches intent and that the `expect`
  (vs. the old `skip`) is acceptable.
- **Second skip remains.** `if (!blockId) this.skip()` (no probed keyspace places
  B in A's cohort over 24 tries) is left as-is — near-certain not to trigger
  (~(1/3)^24) and it is not the FRET-stabilization skip the ticket targeted.

## Out of scope / follow-ups
- Publish `p2p-fret@0.5.1`; replace the `portal:` resolution with the plain
  published version (human/CI).
- Optional dedicated test isolating direct-A↔B FRET RPC over a limited link
  (see scrutiny note above).
- Rate-limiting FRET gossip over relayed links to avoid relay-reservation cap
  pressure — future concern; not observed as a problem here.
- The complementary db-p2p cluster-RPC fix (`multi-coordinator-write-relay-stream-reset`)
  is already landed (in `tickets/complete/`); its `connect()` prefer-direct +
  `collectPromises` immediate-retry are what make the relayed pend/commit succeed.

## No pre-existing failures
No unrelated/pre-existing test failures surfaced; `tickets/.pre-existing-error.md`
not written.
