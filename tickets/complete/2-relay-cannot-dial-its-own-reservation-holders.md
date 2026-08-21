description: A machine acting as a relay for phones behind a home router knew those phones only by an address that routed back through itself, kept trying to use it anyway, and reported the failure in words indistinguishable from "we were never told an address". It now recognises that state before dialing and says so.
files: packages/db-p2p/src/peer-address-book.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/test/peer-address-book.spec.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/test/relay-self-relay-only-dial.spec.ts, packages/db-p2p/docs/cluster.md, docs/internals.md
----

# Complete: a relay now fails fast on peers it can only reach through itself

Upstream: [gotchoices/Optimystic#14](https://github.com/gotchoices/Optimystic/issues/14). Companion
to `findcluster-publishes-inbound-source-addresses` (#13).

## The condition

When a relay-only client reserves a circuit on a relay `R`, the only address it can advertise is
`/<R's transport addr>/p2p/<R's peer id>/p2p-circuit`. Every node in the mesh can use that address
except `R`, which would have to relay to the client through itself. So `R` holds a **non-empty**
address-book entry it can never dial, and libp2p reports the resulting failure with the same text as
"nobody ever taught us an address". Only the second condition is ever repaired by a retry — once the
client's connection drops, only the client can re-initiate — so the two had to be separated.

## What shipped

**`peer-address-book.ts`** gained the "can *we* dial this?" question, deliberately separate from the
existing "may we publish this to a third party?" (`publishableConnectionAddr`). A self-relay address
is *publishable* — a cohort sibling reaching the client through our relay is the working path — and
simply not dialable by the one node the circuit terminates on.

- `routesThroughRelay(addr, relayPeerId, log)` — walks the multiaddr's **components** and returns
  true when any `p2p-circuit` marker is immediately preceded by a `p2p` component naming
  `relayPeerId`. Not a substring test: the target peer id appended after the marker, a circuit
  naming no relay, and multi-hop chains all read differently as text. Falls back to a canonical
  `peerIdFromString` compare so a CIDv1-spelled peer id is recognised.
- `classifySelfDialability(addrs, selfPeerId, log)` → `'none' | 'self-relay-only' | 'dialable'`.
  Fails open on an unparseable address.

**`Libp2pKeyPeerNetwork.connect`** is now `async` and, on the **cold** path only, reads the peerStore
once and refuses the dial when the verdict is `self-relay-only`, throwing `SelfRelayOnlyAddressesError`
(`code = SELF_RELAY_ONLY_ADDRESSES`, reachable from the package root via `export *`). Empty peerStore
still dials, so a genuinely-unknown peer keeps libp2p's own error. The warm path is untouched and
pays no peerStore read.

**`findCluster`** counts the condition as `selfRelayOnly` on `findCluster:done` alongside the
existing `addressless`, plus a `findCluster:self-relay-only-members` line when non-zero. It does
**not** drop those addresses from the published record.

**Docs**: `packages/db-p2p/docs/cluster.md` § "Which Addresses *We* Can Dial (Not The Same Question)"
and a paragraph in `docs/internals.md` next to the existing producer rule.

## Review findings

### Verification run in this pass

- `yarn lint` — clean (no output from `eslint .`).
- `yarn build`, `yarn typecheck` — clean.
- `yarn workspace @optimystic/db-p2p test` — **1869 passing, 44 pending** (1866 before the three
  tests added below; no failures, no skips).
- `yarn workspace @optimystic/db-p2p test:integration` — **30 passing, 2 pending**.
- `yarn test` (whole monorepo) — every workspace green, zero failing. No pre-existing failures
  surfaced, so nothing was written to `tickets/.pre-existing-error.md`.

### Mutation checks — the tests are guards, not tautologies

Two claims in the handoff were re-verified by breaking the code and watching a test fail, then
restoring it (working tree confirmed clean afterwards with `git status --porcelain`):

- Commenting out `await this.assertNotSelfRelayOnly(...)` in `connect` made
  `test/relay-self-relay-only-dial.spec.ts` fail with
  `AggregateError: All multiaddr dials failed` — the pre-fix behavior, over real sockets. Confirms
  the handoff's load-bearing check independently.
- Replacing the CIDv1 fallback in `isRelayComponent` with `return false` failed exactly one row,
  `flags our own relay written as a CIDv1 peer id`. Confirms the handoff's claim that
  `@multiformats/multiaddr` 13.0.1 keeps a `/p2p/` value verbatim rather than normalizing it —
  the fallback is load-bearing, not defensive padding.

### Minor findings — fixed in this pass

- **The documented fail-open on a peerStore failure had no test.** `getPeerStoreAddrsByPeer`
  swallows a failing `store.get` and reports the peer as holding nothing, which resolves to a
  normal dial — deliberate, but it also means a persistently broken peerStore makes the whole
  guard silently inert, and nothing pinned the direction. Added
  `dials when the peerStore read itself fails, rather than inventing a verdict`
  (`test/libp2p-key-network.spec.ts`), using the existing `onPeerStoreRead` hook to throw.
- **`classifySelfDialability` had no unparseable-address row.** `routesThroughRelay` fails open and
  is tested for it, but the classifier's own behavior on garbage was untested — and the case that
  matters is garbage *beside* a self-relay address, where a wrong answer converts a dial libp2p
  would have rejected on its own into a hard refusal of ours. Added two table rows
  (`test/peer-address-book.spec.ts`).
- **The integration spec's runtime comment was 4× the real number.** It claimed `~5 s`; measured
  alone it is **1233 ms**, matching the handoff's `~1.5 s`. Corrected in the spec header, since that
  number is what a future reader uses to decide whether to env-gate it.

### Checked and found clean — no action

- **No hot-spin from failing fast.** The main risk of converting a ~3 s dial timeout
  (`DEFAULT_DIAL_TIMEOUT_MS = 3000`, `network-transactor.ts` / `rpc-deadline.ts`) into an instant
  rejection is that some retry loop was being paced by it. Traced every loop that can observe a
  dial throw: `batch-coordinator.ts:126-158` (no sleep, but bounded by *monotonic peer exclusion* —
  each retry adds the failed peer to `excludedPeers`, so the walk terminates at cluster size and now
  terminates *faster*); `coordinator.ts:1059` (`for (let attempt = 0; attempt < 3; ...)`, hard cap);
  `cluster-coordinator.ts:160` (cap 2); `subscription-manager.ts:253` (cap 1). Every unbounded loop
  in the area (`coordinator.ts:156`, `collection.ts:520`, `block-transfer.ts:202/244/332`,
  `scheduleCommitRetry`) sleeps unconditionally on its retry path and does not retry a thrown dial
  error at all. No loop becomes unbounded or sleepless; attempt *rate* rises but total attempts fall.
- **Error propagation is genuinely transparent.** Re-verified the handoff's static claim:
  `ProtocolClient.processMessage` (`protocol-client.ts:86-108`) logs and rethrows with no retry;
  `repo/client.ts` and `cluster/client.ts` have no catch, and their only re-dial is a
  *success*-driven redirect bounded at `hop >= 2`. Cohort fan-outs are `Promise.allSettled`. The
  new error needs no special-casing anywhere.
- **No regression from refusing a dial libp2p might have joined.** libp2p's dial queue can join an
  in-flight dial started from an explicit multiaddr that never entered the peerStore — the guard
  would pre-empt that. Grepped `packages/*/src` for `.dial(` excluding `dialProtocol`: **zero
  sites**. Nothing in this codebase dials by raw multiaddr, so the case cannot arise here.
- **Docs match the code.** Read both changed doc paragraphs against the implementation rather than
  trusting them: the cold/warm split, the three-way verdict, the "published but not dialable"
  distinction, and the `NoValidAddressesError`-vs-`AggregateError` note are all accurate, and the
  `AggregateError` half was confirmed by the mutation run above. No other doc or readme mentions
  `findCluster:done`, `addressless`, or dial-error names, so nothing else was stale.
- **`SELF_RELAY_ONLY_ERROR_CODE` and the error class are reachable from the package root** —
  `src/index.ts:36` is `export * from "./libp2p-key-network.js"`.
- **`addressLog` field.** The five separately-written `(fmt, ...args) => this.log(...)` adapters
  collapsing into one instance field is a clean DRY win; the arrow-function initializer is lazy, so
  it is safe despite `this.log` being assigned in the constructor body.
- **Double-parse on the `findCluster` path.** `validMultiaddrStrings` parses each address and
  `routesThroughRelay` parses again. Not parked as a tripwire because `classifySelfDialability`
  short-circuits on the first non-self-relay address, so the common case costs exactly one extra
  parse per member — too small to be worth a note.

### Tripwires recorded (conditional; not tickets)

- **Cold-dial peerStore double-read.** Every cold dial now reads the peerStore once here and again
  inside libp2p's dial queue moments later — on all peers, not just relays. Unmeasured and
  negligible against a dial's own cost. Parked as a `NOTE:` on `assertNotSelfRelayOnly`
  (`libp2p-key-network.ts`), with the revisit condition: cold-dial latency or peerStore contention
  showing up in a profile.
- **`findCoordinator` is blind to self-dialability.** A relay can still select one of its own
  reservation holders as coordinator and discover the problem only at dial. The exclude-and-continue
  walk absorbs it and each pick now costs an instant refusal rather than a burned timeout, so it is
  a selection round-trip, not a stall — and the verdict is a live peerStore read a stale eligibility
  filter would have to guess at. Parked as a `NOTE:` on `isSelectable`
  (`libp2p-key-network.ts`), with the revisit condition: a relay serving many reservation holders
  measured spending real time walking through them.

### Major findings

**None.** No finding warranted a new `fix/`, `plan/`, or `backlog/` ticket. The gaps the handoff
listed honestly were each re-examined and resolved as above: the peerStore fail-open became a test,
the multi-hop and CIDv1 judgement calls were confirmed by mutation, and the two performance items
were genuinely conditional and became tripwires. The one gap left standing is the handoff's own —
no end-to-end consensus test proves the exclude-and-continue path with a self-relay-only cohort
member — but the code path was traced site-by-site above and every fan-out is `Promise.allSettled`,
so there is no unsettled question behind it, only an absent demonstration. Filing a ticket for a
test of an already-verified path would lengthen the queue without making the codebase harder to
break.

### Considered and declined

No accepted-tradeoff `NOTE:` sites exist in the touched code, so nothing was left alone on that
basis.

## Adjacent, deliberately untouched

`tickets/backlog/debt-shared-limited-connection-dial-options.md` covers dial *options*
(`runOnLimitedConnection`, dropped `AbortOptions`) at other stream-open sites in the same file —
unaffected; the cold path's `dialOptions` and the warm path's `newStream` options are byte-identical
to before. `tickets/implement/3-address-book-merge-logs-under-two-namespaces.md` moves the inbound
address-book log sink onto this package's logger namespace; it touches `peer-address-book.ts` but
not any predicate this ticket added.

## End
