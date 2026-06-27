description: Teach the peer-ranking layer (FRET) to talk directly between two nodes that can only reach each other through a relay, so peer discovery stops depending on a third node and stops being flaky in relay-heavy setups.
prereq:
files:
  - C:/projects/Fret/packages/fret/src/rpc/neighbors.ts  (UPSTREAM source — fetchNeighbors/announceNeighbors)
  - C:/projects/Fret/packages/fret/src/rpc/ping.ts        (UPSTREAM source — sendPing)
  - C:/projects/Fret/packages/fret/src/rpc/maybe-act.ts   (UPSTREAM source — sendMaybeAct)
  - C:/projects/Fret/packages/fret/src/rpc/leave.ts       (UPSTREAM source — sendLeave)
  - C:/projects/Fret/packages/fret/src/rpc/protocols.ts   (UPSTREAM — good home for a shared open-stream helper)
  - C:/projects/Fret/packages/fret/package.json           (UPSTREAM — version bump 0.5.0 -> 0.5.1)
  - packages/db-p2p/node_modules/p2p-fret/                (vendored copy the integration test actually imports — byte-identical to upstream)
  - packages/db-p2p/src/libp2p-key-network.ts             (in-repo precedent: connect() prefer-direct + runOnLimitedConnection/negotiateFully)
  - packages/db-p2p/package.json                          (consumes p2p-fret@^0.5.0 — bump the spec)
  - package.json                                          (root resolutions — `portal:` precedent for sibling repos, see @quereus/quereus)
  - packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts  (acceptance: must stop this.skip()-ing on FRET stabilization)
difficulty: medium
----

# FRET wire RPCs must run over circuit-relay (limited) connections

## Root cause (confirmed)

All four `p2p-fret` wire RPCs open their libp2p stream without
`runOnLimitedConnection: true`. libp2p **rejects** a stream over a circuit-relay
("limited") connection unless that flag is set, so when two peers reach each
other *only* through a relay (browser/NAT "relay-only" topology — the
Sereus-realistic case of two always-on storage nodes behind NAT meeting through a
reference/relay node), the direct A↔B FRET exchange throws and is swallowed every
gossip round. Convergence still happens, but only **transitively** — and only
when some third node is itself a FRET participant *directly* connected to both
NAT'd peers. That makes it fragile (a pure transport relay never converges) and
slow/flaky even in the favorable case (the acceptance spec `this.skip()`s a
meaningful fraction of runs).

The eight offending call sites (current code, no options passed):

| file | reuse path | dial fallback |
| --- | --- | --- |
| `neighbors.ts` `fetchNeighbors` | `conns[0].newStream([proto])` | *(none — skips if no conn)* |
| `neighbors.ts` `announceNeighbors` | `conns[0].newStream([proto])` | *(none — skips if no conn)* |
| `ping.ts` `sendPing` | `conns[0].newStream([proto])` | `node.dialProtocol(pid, [proto])` |
| `maybe-act.ts` `sendMaybeAct` | `conns[0].newStream([proto])` | `node.dialProtocol(pid, [proto])` |
| `leave.ts` `sendLeave` | `conns[0].newStream([proto])` | `node.dialProtocol(pid, [proto])` |

## In-repo precedent

`Libp2pKeyPeerNetwork.connect()` in `packages/db-p2p/src/libp2p-key-network.ts`
already does exactly the right thing for db-p2p's own cluster RPC and is the
pattern to mirror upstream:

- Filter to **open** connections (`c.status === 'open' && typeof c.newStream === 'function'`)
  so a closing/closed-but-not-yet-evicted connection isn't picked.
- **Prefer a DIRECT connection** over a limited one: `open.find(c => !isLimited(c)) ?? open[0]`.
  A relayed/limited connection can be reset by the relay when a per-circuit cap or
  reservation lapses; after DCUtR upgrades a relayed link to direct both briefly
  coexist, and picking the direct one avoids riding the soon-to-be-reset circuit.
- Open the stream with `{ runOnLimitedConnection: true, negotiateFully: false }`
  (harmless no-op on the direct connection; required on the limited one).
- Fall back to `dialProtocol(pid, [proto], { runOnLimitedConnection: true, negotiateFully: false, signal })`.

`isLimitedConnection(c)` there: `c.limits != null`, else multiaddr contains
`/p2p-circuit`. Reuse that exact heuristic.

## Where the change lands (read carefully — cross-repo)

`p2p-fret` is a **published npm package**, NOT an optimystic workspace. The
canonical source is the **sibling checkout** at
`C:/projects/Fret` (`fret-workspace`, GitHub `gotchoices/Fret`), package in
`packages/fret`, currently `p2p-fret@0.5.0`. The copy under
`packages/db-p2p/node_modules/p2p-fret` is byte-identical and is what the
integration test imports (`main: dist/src/index.js`).

So the fix is two-part:
1. **Make the real change upstream** in `C:/projects/Fret/packages/fret/src/rpc/*.ts`,
   build, run Fret's own test suite, bump version to `0.5.1`, and commit **in the
   Fret repo** (that repo is outside optimystic's runner-commit scope — commit it
   there yourself; the optimystic runner only commits the optimystic tree).
2. **Consume it locally** so optimystic's acceptance test runs against the fixed
   code. The repo already consumes a sibling via yarn-berry `portal:` (see
   `@quereus/quereus` → `portal:../quereus/packages/quereus` in root
   `resolutions`). Add the parallel `"p2p-fret": "portal:../Fret/packages/fret"`,
   `yarn install`, and confirm `node_modules/p2p-fret/dist` now reflects the fix.
   Also bump `packages/db-p2p` dependency spec to `p2p-fret@^0.5.1` to record the
   intended published floor. (The eventual npm publish of `0.5.1` and dropping the
   portal back to a plain version is a human/CI follow-up — document it, don't
   attempt to publish.)

   **Fallback if `yarn install` is problematic under the runner:** the portal
   protocol is local (no network), but if install fails, build Fret and copy its
   `dist/` and `src/` into `packages/db-p2p/node_modules/p2p-fret/` so the test
   imports the fixed `dist`. Document whichever path you used.

## Recommended shape of the upstream change

Add one small shared helper (e.g. in `protocols.ts` or a new `open-stream.ts`) so
prefer-direct + the limited-connection flags aren't copy-pasted five times:

```ts
import type { Libp2p } from 'libp2p';
import type { Connection, PeerId, Stream } from '@libp2p/interface';

function isLimitedConnection(c: Connection): boolean {
  if ((c as { limits?: unknown }).limits != null) return true;
  const addr = c.remoteAddr?.toString?.();
  return addr != null && addr.includes('/p2p-circuit');
}

/**
 * Open an RPC stream to `pid`, preferring a direct open connection and falling
 * back to a limited (circuit-relay) one. `runOnLimitedConnection: true` is
 * required for the relayed path and a harmless no-op on a direct connection.
 * When `requireExisting` is set the caller skips dialing if no connection exists
 * (neighbors fetch/announce reduce churn this way); otherwise we dialProtocol.
 */
export async function openRpcStream(
  node: Libp2p,
  pid: PeerId,
  protocols: string[],
  opts: { requireExisting?: boolean } = {}
): Promise<Stream | undefined> {
  const open = node.getConnections(pid)
    .filter(c => c?.status === 'open' && typeof c?.newStream === 'function');
  const chosen = open.find(c => !isLimitedConnection(c)) ?? open[0];
  const streamOpts = { runOnLimitedConnection: true, negotiateFully: false } as const;
  if (chosen) return chosen.newStream(protocols, streamOpts);
  if (opts.requireExisting) return undefined;
  return node.dialProtocol(pid, protocols, streamOpts);
}
```

Then:
- `fetchNeighbors` / `announceNeighbors`: use `openRpcStream(node, pid, [protocol], { requireExisting: true })`
  and keep their existing "return empty snapshot / skip" behavior when it returns
  `undefined` (preserves the current no-connection churn guard).
- `sendPing` / `sendMaybeAct` / `sendLeave`: use `openRpcStream(node, pid, [protocol])`
  (dial fallback).

Notes:
- `runOnLimitedConnection` / `negotiateFully` are valid options at this libp2p
  version (peerDep `libp2p ^3.1.x`, same as optimystic) — `libp2p-key-network.ts`
  already passes both.
- Match the upstream package's existing TS/lint idioms.
- These RPCs don't currently thread an `AbortSignal`; adding signal plumbing is
  **out of scope** — keep the change minimal (flags + prefer-direct).

## Acceptance

`packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts` must
converge **reliably** — it should stop hitting the `this.skip()` on the
FRET-stabilization precondition (lines ~111-133) when run with
`OPTIMYSTIC_INTEGRATION=1`. With the fix the relay-only A↔B link exchanges FRET
state **directly**, so `assembleCohort` ranks both peers without depending on the
relay being a directly-connected FRET participant. Run it a handful of times to
confirm stabilization is no longer bimodal/flaky.

Run (streamed, never silent-redirect):
```
OPTIMYSTIC_INTEGRATION=1 yarn workspace @optimystic/db-p2p test:integration 2>&1 | tee /tmp/fret-relay-it.log
```
The spec is slow (three real libp2p nodes + relay). If a single run's wall-clock
approaches the ~10-min idle budget, run it once under the ticket and note any
remaining flakiness for a human rather than looping it.

## Out of scope / follow-ups (do not expand this ticket)

- Rate-limiting FRET gossip over relayed links to avoid relay-reservation cap
  pressure — note as a future concern if you observe churn, but don't build it here.
- The complementary db-p2p cluster-RPC fix is the separate
  `multi-coordinator-write-relay-stream-reset` ticket (already in the pipeline) —
  don't duplicate its changes.
- npm publish of `p2p-fret@0.5.1` and replacing the `portal:` resolution with the
  plain published version — human/CI step.

## TODO

### Phase 1 — upstream fix (in C:/projects/Fret)
- [ ] Add `openRpcStream` helper (prefer-direct + `runOnLimitedConnection: true` + `negotiateFully: false`) in `packages/fret/src/rpc/protocols.ts` (or a new `open-stream.ts`).
- [ ] Rewrite `fetchNeighbors` + `announceNeighbors` (`neighbors.ts`) to use it with `requireExisting: true`, preserving the no-connection skip/empty-snapshot behavior.
- [ ] Rewrite `sendPing` (`ping.ts`), `sendMaybeAct` (`maybe-act.ts`), `sendLeave` (`leave.ts`) to use it with the dial fallback.
- [ ] `yarn build` in `packages/fret`; fix any type errors.
- [ ] Run Fret's own suite (`yarn workspace p2p-fret test` or per its README) and confirm green; stream output via `tee`.
- [ ] Bump `packages/fret/package.json` version `0.5.0` -> `0.5.1`.
- [ ] Commit in the Fret repo (separate from optimystic's runner commit).

### Phase 2 — consume in optimystic
- [ ] Add `"p2p-fret": "portal:../Fret/packages/fret"` to root `package.json` `resolutions` (mirror the `@quereus/quereus` portal entry).
- [ ] `yarn install`; verify `packages/db-p2p/node_modules/p2p-fret/dist` now contains the fix. (Fallback: build Fret + copy `dist/`+`src/` into the vendored dir if install is problematic — document which.)
- [ ] Bump `packages/db-p2p/package.json` `p2p-fret` spec to `^0.5.1`.

### Phase 3 — validate
- [ ] Build db-p2p (`yarn workspace @optimystic/db-p2p build`); confirm no type breakage at the consumption boundary.
- [ ] Run `OPTIMYSTIC_INTEGRATION=1 yarn workspace @optimystic/db-p2p test:integration 2>&1 | tee /tmp/fret-relay-it.log` and confirm `multi-coordinator-write-relay.integration.spec.ts` reaches its assertions (no `this.skip()` on FRET stabilization).
- [ ] If any unrelated/pre-existing failure surfaces, follow the pre-existing-error protocol (`tickets/.pre-existing-error.md`) — don't chase it here.
- [ ] Write the review/ handoff: note the cross-repo nature (upstream commit in Fret + portal consumption), the deferred npm-publish step, and any residual integration-test flakiness.
