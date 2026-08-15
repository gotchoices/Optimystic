description: Cohort members reachable only through a relay (phones, machines behind a home router) could hold a working relayed connection and still have every cohort-topic message rejected, because the code that opens those streams never asked permission to use a relayed link; it now does, with unit tests covering all four places it opens one.
files: packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/test/cohort-topic/stream-util.spec.ts
prereq:
----
## What changed

`packages/db-p2p/src/cohort-topic/stream-util.ts` — both stream helpers now pass
`{ runOnLimitedConnection: true }` when opening a protocol stream.

libp2p classifies a circuit-relay connection as *limited*, and refuses to open a protocol stream over
one unless the caller explicitly opts in with that flag. Cohort-topic was the only subsystem in the
repo that omitted it — `libp2p-key-network.ts:542-553` and FRET's `protocols.ts` already set it. The
effect was that a cohort member reachable only via a relay held a perfectly good relayed connection
and had every cohort-topic stream rejected at open time.

Four call sites, two per helper (reuse an existing connection vs. dial fresh):

| Helper | Reuse path (`Connection.newStream`) | Fresh-dial path (`Libp2p.dialProtocol`) |
| --- | --- | --- |
| `requestResponse` | `stream-util.ts:30` | `stream-util.ts:31` |
| `sendOneWay` | `stream-util.ts:53` | `stream-util.ts:54` |

`handleRequestResponse` (the inbound side) needed no change — it registers a handler and never dials.

## Validation performed at HEAD

Run from `packages/db-p2p`:

- `npx tsc --noEmit` → clean, no output.
- `yarn test` → **1766 passing, 0 failing, 44 pending** (50s). The 44 pending are pre-existing skips
  unrelated to this change. Note the package's `test` script uses mocha's `min` reporter, so it prints
  a summary only — use `yarn test:verbose` to see test names.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cohort-topic/stream-util.spec.ts" --reporter spec`
  → 3 passing.
- **Negative check (mutation test, run this stage, not inherited):** stripped the options argument
  from all four call sites via `sed`, re-ran the spec → **3 of 3 failed**
  (`AssertionError: Target cannot be null or undefined.`), then restored the file and confirmed
  `git diff --stat` was empty. So the tests genuinely fail without the fix; they are not vacuous.

## What the tests actually assert (and what they do not)

`test/cohort-topic/stream-util.spec.ts` mocks a libp2p node and a connection, calls each helper, and
asserts the captured options object deep-includes `{ runOnLimitedConnection: true }`.

This is a **call-site contract test**, not an end-to-end relay test. It proves the flag is passed; it
does not prove libp2p then accepts the stream over a real relayed connection. That is a deliberate
narrowing — deterministic and ~4ms instead of a multi-second real-transport spin-up — but the reviewer
should know the coverage boundary.

## Known gaps — flagged honestly

**1. No end-to-end relay integration test.** The original ticket suggested reproducing over a real
`circuit-relay-v2` connection. Not done. Worth knowing: reusable scaffolding for exactly this
**already exists** at `packages/db-p2p/test/util/relay-topology.ts` — `spawnRelayNode`,
`spawnTcpServicePeer`, a relay-only "browser-shaped" peer helper, and multiaddr pickers, already used
by `circuit-relay-long-lived.spec.ts` and `relay-address-propagation.spec.ts`. Those specs are gated
behind `RUN_LONG_TESTS` and are not in the default suite. If the reviewer wants true end-to-end
coverage, the cheap path is a new `RUN_LONG_TESTS`-gated spec that stands up relay + relay-only peer
and drives one real `requestResponse` — do not write new harness code, reuse that file.

**2. A second dial site elsewhere in the repo still has this bug.** Found while sweeping for other
instances of the class, and **left unfixed on purpose** — it is in a different subsystem
(arachnode block restoration), outside this ticket's stated scope, and silently widening the diff into
it seemed worse than filing it. `packages/db-p2p/src/libp2p-node-base.ts:1041` builds an inline
`IPeerNetwork` whose `connect` calls `node.dialProtocol(pid, [protocol])` with no options at all — no
`runOnLimitedConnection`, and it also drops the caller's `AbortSignal`. This is a live defect, not a
theoretical one: it means arachnode restoration cannot pull a block from a relay-only holder. Filed as
`tickets/backlog/debt-shared-limited-connection-dial-options.md`, written at the architecture rung
(make the flag impossible to forget) with this site as its concrete arm, rather than as a second
one-line point fix. Reviewer's call whether that deserves promotion ahead of backlog.

**3. No shared constant / lint guard.** The original ticket floated "a lint or shared stream-options
constant so the next dial site cannot forget it." Deliberately not done here — it is a cross-file
representation change, not a minimal bug fix. Gap 2 is the evidence that it is warranted; the backlog
ticket above carries it.

## Suggested review focus

- Are all four dial paths in `stream-util.ts` actually covered? (Reuse vs. fresh-dial branches differ
  per helper; a mock that always returns a connection would silently skip the dial branch — check the
  `getConnections: () => []` vs `=> [conn]` setup in the spec.)
- Should `stream-util.ts` also thread an `AbortSignal` through, the way `libp2p-key-network.ts:542-544`
  does? Neither helper accepts one today. Out of scope for this fix, but it is the same options object.
- Is the backlog ticket in gap 2 filed at the right severity, or should it be promoted to `fix/`?
