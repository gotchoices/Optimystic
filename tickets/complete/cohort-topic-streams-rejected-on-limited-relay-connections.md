description: Peers reachable only through a relay — phones, machines behind a home router — were being cut off from cohort messages because the code that opens a connection to them skipped an opt-in step; that is fixed, and the review found the same code was also picking dead and second-best connections, which is fixed too.
files: packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/test/cohort-topic/stream-util.spec.ts, tickets/backlog/debt-shared-limited-connection-dial-options.md
prereq:
----
## What shipped

`packages/db-p2p/src/cohort-topic/stream-util.ts` — despite the file name, this is the shared
single-frame stream helper for **cohort-topic, matchmaking, and reactivity** (six importers), so the
fix is wider-reaching than the original ticket title suggests.

**Implement stage** added `{ runOnLimitedConnection: true }` to the four inline stream-open
expressions. libp2p classifies a circuit-relay connection as *limited* and refuses to open a protocol
stream over one without that opt-in, so a cohort member reachable only via a relay held a working
relayed connection and had every stream rejected at open time.

**Review stage** replaced those four inline expressions with a single private `openStream(node, peer,
protocol)` that both helpers call, and fixed two further defects found in the same expression (see
findings below). The flag now lives in one `STREAM_OPTIONS` constant in this module instead of four
literals.

Final shape:

```ts
const STREAM_OPTIONS = { runOnLimitedConnection: true } as const;

async function openStream(node: Libp2p, peer: PeerId, protocol: string): Promise<Stream> {
	const open = node.getConnections(peer).filter(c => c?.status === "open" && typeof c?.newStream === "function");
	const chosen = open.find(c => !isLimitedConnection(c)) ?? open[0];
	return chosen ? await chosen.newStream([protocol], STREAM_OPTIONS) : await node.dialProtocol(peer, [protocol], STREAM_OPTIONS);
}
```

`handleRequestResponse` (inbound) needed no change — it registers a handler and never dials.

## Review findings

### Checked

- Read the implement-stage diff (`0448430`) before the handoff summary. It contains **only ticket
  files** — the actual code landed one commit earlier in the fix stage (`a3f7065`), which is where the
  code review was performed.
- Compared `stream-util.ts` against both in-repo reference implementations of the same operation
  (`libp2p-key-network.ts#connect`) and the upstream one (`p2p-fret`'s `rpc/protocols.ts#openRpcStream`).
- Swept every stream-open site in the repo:
  `grep -rn "\.dialProtocol(\|\.newStream(" packages/*/src --include=*.ts` → exactly three, no others.
- Verified the implement stage's gap-2 claim by reading `libp2p-node-base.ts:1041` directly. Accurate.
- Traced whether an unresponsive peer can hang a caller, by reading `readAllBounded`'s actual
  implementation rather than assuming.
- Docs: `docs/cohort-topic.md`, `docs/matchmaking.md`, `docs/reactivity.md`, `docs/architecture.md`,
  and `packages/db-p2p/docs/*`. None describe stream-opening or relay handling at this level, so
  **nothing was stale and nothing needed updating** — this is an internal transport detail no document
  currently claims anything about.

### Found and fixed in this pass (minor)

**1. `conns[0]` could be a dead connection.** The code took the first entry `getConnections(peer)`
returned, with no status check. libp2p does not always evict a closing/closed connection from that
index immediately, so a request could fail against a stale entry while a healthy connection sat at
`conns[1]`. `libp2p-key-network.ts:524-526` already filters for exactly this reason, with a comment
saying so. Fixed — `openStream` filters to `status === 'open'`.

**2. `conns[0]` could be the relayed connection when a direct one was available.** With the flag now
set, a limited connection is *usable*, which makes blindly picking it a live hazard rather than an
error: a relayed connection can be reset when the relay's per-circuit cap or reservation lapses, and
after DCUtR upgrades a link to direct both coexist briefly. `libp2p-key-network.ts:527-535` documents
this failure mode as observed (a `StreamResetError` that fails consensus). Fixed — `openStream`
prefers a direct connection and falls back to the relayed one only when it is the only open path.

**3. Duplicated stream-open logic across four call sites.** Both helpers carried the same ternary.
Extracted to `openStream`; the two helper bodies are now three lines each.

**4. The file header claimed it "mirrors FRET's `rpc/maybe-act.ts` exactly."** It did not — that
false claim is plausibly what let the divergence hide. Rewritten to state what actually diverges and
why. Also corrected the header's implication that this file is cohort-topic-only.

### Found and left to the existing backlog ticket (major)

**The correct version of this logic already exists upstream and is unreachable.** FRET's
`rpc/protocols.ts#openRpcStream` does all three guards correctly, but `p2p-fret`'s `package.json`
`exports` map exposes only the root entry and that entry re-exports `readAllBounded` **without**
`openRpcStream` — so there is no import path to it. The result is three hand-written copies of one
operation in this repo, one of which (`libp2p-node-base.ts:1041`) is still broken.

Per *Architecture first* and the "Nth instance is evidence, not a new ticket" rule, this was **not**
filed as a new ticket. `tickets/backlog/debt-shared-limited-connection-dial-options.md` already claims
these sites (confirmed by the site-claim grep), so an arm was appended to it recording the upstream
export gap, the three-copy count, the completed sweep, and two concrete options that did not exist
when it was written (ask upstream to export the helper and delete all three copies; or seed one
`db-p2p` helper from the now-tested `stream-util.ts` version). Its `description:` was widened, since
the class is *connection selection*, not just the one flag.

**Promotion call:** left in `backlog/`, not promoted to `fix/`. The one live defect it carries
(arachnode restoration cannot pull a block from a relay-only holder) is `repro: static`, on a path
that needs a relay-only block holder to hit. Real, but not urgent enough to jump the queue ahead of
the human's own ordering — that call is theirs, and the ticket now has everything needed to make it.

### Recorded as a tripwire, not a ticket

The implementer asked whether these helpers should thread an `AbortSignal` the way
`libp2p-key-network.ts:542-544` does. **Measured rather than assumed:** `readAllBounded` self-times-out
at 5s (`p2p-fret` `rpc/protocols.js:67`, `timeoutMs = 5000` default) and `dialProtocol` falls back to
libp2p's default dial timeout (~30s), so an unresponsive peer is *slow*, not hung. That makes it
conditional, not a defect. Parked as a `NOTE:` on `requestResponse` in `stream-util.ts`, including the
one place where the latency actually compounds — `membership-source.fetch` walks candidate peers
sequentially, so its worst case is peers × dial-timeout.

### Considered and declined

`negotiateFully: false` — set by both reference implementations, deliberately not adopted here. It
saves a round trip, but it defers an unsupported-protocol failure from stream-open to the first read,
which would turn `sendOneWay` against a peer lacking the protocol into a silent no-op. Recorded as an
accepted-tradeoff `NOTE:` at the `STREAM_OPTIONS` site with "revisit if stream-open latency shows up
in a profile" as the condition, so the next reviewer does not re-derive it.

### Test coverage

The implementer's three tests were a genuine starting point but had a hole the mocks concealed: the
connection stubs carried only a `newStream` method, no `status` and no `remoteAddr`. They asserted the
options object and nothing about *which* connection was chosen — so both defects above were invisible
to them, and adding the open-status filter would have silently broken them.

Rewritten as a table-driven spec: two helpers × six scenarios = **12 tests** (up from 3), so
`requestResponse` and `sendOneWay` cannot diverge without failing, and a future call site generalizes
by adding a row rather than copying a block. Scenarios: reuse path opts in; fresh-dial path opts in;
relayed connection used when it is the only open path; direct preferred over relayed; non-open
connection skipped in favour of a healthy one; fresh dial when every indexed connection is closed.

**Mutation-tested each guard independently** (run this stage) — reverted one guard at a time, ran the
spec, restored:

| Guard removed | Result |
| --- | --- |
| `runOnLimitedConnection: true` | 6 of 12 failing |
| open-status filter | 4 of 12 failing |
| direct-connection preference | 2 of 12 failing |

So every guard is held by tests; none of the assertions are vacuous.

Still **not** covered, and deliberately: no end-to-end test drives a real `circuit-relay-v2`
connection. These remain call-site contract tests. Reusable scaffolding for the real thing exists at
`packages/db-p2p/test/util/relay-topology.ts` (`spawnRelayNode`, `spawnTcpServicePeer`, a relay-only
peer helper), gated behind `RUN_LONG_TESTS` and out of the default suite — the cheap path if anyone
wants true end-to-end coverage is a new gated spec reusing that file, not new harness code.

## Validation

Run from `packages/db-p2p`, all at final state:

- `npx tsc --noEmit` → clean.
- `npx eslint` on both changed files (from repo root) → clean.
- `yarn test` → **1775 passing, 0 failing, 44 pending** (51s). Baseline before this ticket was 1766
  passing; +9 is exactly the net new tests (12 − 3). The 44 pending are pre-existing skips unrelated
  to this change, unchanged in count. No pre-existing failures surfaced, so
  `tickets/.pre-existing-error.md` was not written.
- Note for the next agent: the package's `test` script uses mocha's `min` reporter and prints only a
  summary — use `yarn test:verbose` to see test names.
