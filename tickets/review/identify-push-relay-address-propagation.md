---
description: A peer reachable only through a relay never told its already-connected neighbours the address it got from that relay, so they later failed to reconnect to it. The missing address-push is now registered and covered by tests that reproduce the original failure when the fix is removed.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/relay-address-propagation.spec.ts, packages/db-p2p/test/identify-push-propagation.spec.ts, packages/db-p2p/test/node-service-set.spec.ts, packages/db-p2p/test/identify-protocol-id.spec.ts, packages/db-p2p/test/util/peer-store-wait.ts, packages/db-p2p/test/util/protocol-ids.ts, packages/db-p2p/test/util/relay-topology.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts, packages/db-p2p/test/rebalance-monitor-node-wiring.spec.ts, packages/db-p2p/test/spread-on-churn-node-wiring.spec.ts, packages/db-p2p/test/reactivity/node-wiring.spec.ts
difficulty: medium
---

Closes [gotchoices/Optimystic#7](https://github.com/gotchoices/Optimystic/issues/7) (missing
`identifyPush`) and [#6](https://github.com/gotchoices/Optimystic/issues/6) (malformed double-slash
identify protocol id).

## What the defect was, in plain terms

libp2p's `identify` protocol exchanges a peer's addresses and supported protocols exactly once, when
a connection opens. Its companion `identify/push` re-sends that information to peers you are
*already* connected to whenever it changes. Only `identify` was registered; `identify/push` was not.

That bites hardest for a peer that can only be reached through a relay. Such a peer gets its usable
address (a `/p2p-circuit` address) when the relay grants it a reservation — and the reservation is
requested *by* the connection to the relay, so it always completes after that connection's initial
identify exchange. The result: the relay's address book entry for that peer stayed empty, and any
later attempt to dial the peer by its id alone failed with `NoValidAddressesError` against a peer
that was genuinely reachable.

Separately, `@libp2p/identify` prepends a leading `/` to whatever protocol prefix you hand it. It was
being handed `/optimystic/<network>`, so it advertised `//optimystic/<network>/id/1.0.0` — a
malformed id with an empty path segment.

## What was already done before this ticket

Commit `849fd94` ("Fix for issue #7") registered `identifyPush` and dropped the leading slash from the
prefix handed to both identify services, keeping the slash-prefixed form for `cluster` / `repo` /
`sync` / `blockTransfer` (which build their own ids). `identify-protocol-id.spec.ts` existed but was
untracked. Both were reviewed on their merits and kept; neither was reverted or rewritten.

**No production behavior was changed by this ticket.** The only source edit is an expanded comment at
the `identifyPush` registration site pointing at the specs that now prove its two claims.

## What this ticket added

**A verified reproduction.** `identifyPush` was temporarily disabled in `libp2p-node-base.ts` and the
suite re-run. Both new propagation specs fail with the fix removed, and the gated negative control
reproduces the exact upstream error (`NoValidAddressesError`). Source was restored afterwards and
confirmed byte-identical to `HEAD` via `git diff`.

**`relay-address-propagation.spec.ts`** — the regression guard for the reported bug. One relay plus
one relay-only client:
- *Propagation:* the client's post-reservation circuit address must reach the relay's address book.
  Asserted on the **relay's** view, not the client's own `getMultiaddrs()` — the client's own view
  only proves the reservation happened, not that it propagated.
- *Reconnect:* a third "sibling" peer drops its connection to the client and re-dials it by peer id
  alone, with no address supplied by the test.
- *Negative control* (gated, see below): the identical topology with a hand-built client that has no
  `identify/push`. The address never arrives and the peer-id-only dial fails with
  `NoValidAddressesError`.

**`identify-push-propagation.spec.ts`** — the protocol half of the same mechanism, and the
follow-through the ticket asked for. Two peers connect; one then registers a protocol handler *after*
the initial identify exchange; the other must learn it. The observable consequence is asserted too:
`membershipOf` in `libp2p-key-network.ts` classifies peers as `serves` / `foreign` / `unknown` purely
from the address book's protocol list, and coordinator and cohort selection drop anything not
`serves`. The spec watches a peer flip from `foreign` to `serves` when the late handler propagates.
This makes true a claim the code comment previously only asserted.

**`node-service-set.spec.ts`** — replaces `dcutr-autonat-registration.spec.ts` (deleted). The old spec
checked named services one at a time (`expect(services.dcutr).to.not.equal(undefined)`), a pattern
that structurally cannot catch a *missing* service — you can only assert over names you already
thought of, and `identifyPush` was on nobody's list. The new spec asserts the **complete** service key
set against a written-out list, across four node shapes: default TCP, browser-shaped (WebSocket-only
custom transports), the `@optimystic/db-p2p/rn` entrypoint, and a relay-server node.

**Written-out protocol ids instead of self-derived ones.** `rebalance-monitor-node-wiring.spec.ts` and
`spread-on-churn-node-wiring.spec.ts` computed their expected id by calling the same builder
production calls — a malformed id would have appeared identically on both sides of the assertion and
passed. `reactivity/node-wiring.spec.ts` had the same problem via imported constants: the check was
confirmed to import the very same constant object the node registers from, so it was given the same
treatment. All three now use literals with a comment naming the owning service.

**Shared helpers.**
- `test/util/protocol-ids.ts` — `expectWellFormedProtocolIds`, which rejects any advertised id that
  is not `/`-rooted or that has an empty path segment. This is the assertion that catches an id
  nobody named, which is exactly how the `//` defect survived several releases.
- `test/util/peer-store-wait.ts` — polling waits on an observer's address-book view of a remote peer
  (addresses and protocols).
- `test/util/relay-topology.ts` — gained `spawnCircuitOnlyPeer`, the relay-only client shape.

**One integration-tier edge that resolves the production way.** Added to
`real-libp2p.integration.spec.ts`: connect two nodes as that file already does, drop the connection,
then re-dial by peer id alone. Deliberately **not** wrapped in a swallowing `try`/`catch`.

## How to exercise it

```
# default run — includes both propagation specs (~2 s of the total)
yarn workspace @optimystic/db-p2p test

# the slow negative control (asserts a timeout; ~20 s)
# PowerShell:
$env:RUN_LONG_TESTS_CONTROL=1; yarn workspace @optimystic/db-p2p test --grep "Relay address propagation"
# bash:
RUN_LONG_TESTS_CONTROL=1 yarn workspace @optimystic/db-p2p test --grep "Relay address propagation"

# the new integration edge
# PowerShell:
$env:OPTIMYSTIC_INTEGRATION=1; yarn workspace @optimystic/db-p2p test:integration
```

## Validation actually run

| What | Result |
| --- | --- |
| `yarn workspace @optimystic/db-p2p build` (`tsc`, covers `src` + `test`) | clean |
| `yarn build` (all workspaces) | clean |
| Full `db-p2p` suite | **1318 passing, 38 pending, 0 failing**, 29 s |
| `real-libp2p.integration.spec.ts` with `OPTIMYSTIC_INTEGRATION=1` | 9 passing, 8 s |
| `relay-address-propagation.spec.ts` incl. gated control | 3 passing, 21 s |
| Fix-removed probe (identifyPush disabled) | both propagation specs fail; control reproduces `NoValidAddressesError` |

Wall-clock for the new work in the default run: relay propagation ~1.3 s, identify/push protocol
propagation ~2.2 s. No pre-existing failures were encountered, so `tickets/.pre-existing-error.md`
was not written.

## Deliberate deviations from the implement ticket — please sanity-check these

**The relay spec is NOT gated behind `RUN_LONG_TESTS`.** The ticket suggested gating it "if a full
pass exceeds a few seconds". Measured, the two positive cases take ~1.3 s combined, so gating them
would have meant the actual regression guard for the reported bug only runs when someone remembers an
environment variable — and this repository has no CI at all (no `.github/` directory; the root `test`
script only fans out to each workspace). Only the negative control is gated, because it asserts a
timeout and therefore always costs its full ~20 s budget. Push back if you disagree.

**The peerStore poll helper lives in `test/util/peer-store-wait.ts`, not `relay-topology.ts`.** The
ticket named `relay-topology.ts`. It was split out because the protocol-propagation spec needs the
same polling with no relay involved, and importing a file called `relay-topology` from a spec with no
relay in it reads wrong.

**The well-formedness helper is called from the specs covering each distinct node shape, not from all
18 node-spawning spec files.** Coverage as it stands: default TCP, browser-shaped, RN entrypoint and
relay-server (`node-service-set.spec.ts`); FRET-edge default (`identify-protocol-id.spec.ts`);
arachnode-enabled (`rebalance-monitor-node-wiring.spec.ts`); arachnode-disabled solo
(`spread-on-churn-node-wiring.spec.ts`); cohort-topic-enabled (`reactivity/node-wiring.spec.ts`);
relay-only circuit client and relay server (`relay-address-propagation.spec.ts`). That is every
branch of the services map. The remaining files spawn one of those same shapes, and most are gated
behind `OPTIMYSTIC_INTEGRATION` or `RUN_LONG_TESTS`, so the marginal value there is near zero against
a dozen scattered edits. The ticket asked for "every spec that spawns a node" — this is a judgement
call worth a second opinion.

## Known gaps — treat the tests as a floor

**The sibling re-dial case is not itself a guard for this bug, and says so in its own comment.** In
the relay topology the sibling's connection ordering is not controllable: by the time the client
dials the sibling, the reservation has usually already landed, so the sibling may learn the circuit
address from the initial identify exchange rather than from a push. Confirmed empirically — that case
still passes with `identifyPush` removed. It earns its place by exercising the reconnect modality (a
dial resolved from the address book, with no address supplied by the test) that nothing else in the
repo covered, not by guarding #7. The deterministic guard is the relay-peerStore assertion in the
test above it.

**The relay cannot re-dial its own reserved client.** `relay.dial(clientPeerId)` fails with
`InvalidPeerIdError: Can not dial self`, because every address the relay learns for the client routes
back through the relay itself. That is why the reconnect assertion needed a third peer. Worth knowing
before anyone tries to "simplify" the topology back to two nodes.

**`identify-push-propagation.spec.ts` has no negative control.** Removing push from the *pushing* side
would require hand-building a node that also registers cluster protocols, roughly duplicating the
services map in test code. It was verified manually instead (fails with push disabled). If you want
belt-and-braces, that is a follow-up, not a defect.

**Timing.** Both propagation specs poll rather than sleep, but they poll against two chained libp2p
debounce windows (~1 s address-manager coalescing, ~1 s push debounce). Budgets are 15–20 s, which is
roughly 10× the observed latency on a dev laptop. If these ever go flaky on a loaded CI box, the
budgets are the first thing to raise — not the assertions to loosen.

**No CI exists.** Every guard added here — and every existing gated spec — runs only when a human
remembers to run it. Standing up CI was explicitly out of scope for this ticket, but the exposure is
worth a decision.

**Untested claim now retired.** The comment in `libp2p-node-base.ts` about push flipping membership
classification was previously unverified. It is now backed by
`identify-push-propagation.spec.ts` and rewritten to point at the specs rather than assert.

## Follow-ups noticed, not fixed (candidates for `backlog/`, your call)

**The integration tier routes around this whole class of bug by construction.** Every multi-node spec
wires its mesh by reading the *other* node's live address list in-process and handing it to the
dialer, inside a `try`/`catch` that swallows failures. In production nothing hands you an address:
the routing layer yields a peer id and the address book has to resolve it. One edge was converted in
`real-libp2p.integration.spec.ts` as this ticket asked; the rest of the tier remains blind to
address-book resolution defects. Sites: `real-libp2p.integration.spec.ts:103`,
`multi-coordinator-write.integration.spec.ts:69`,
`multi-coordinator-cross-network-write.integration.spec.ts:59`,
`substrate-real-libp2p.integration.spec.ts:383`, plus both `quereus-plugin-optimystic` distributed
specs.

**`substrate-real-libp2p.integration.spec.ts:375-378` may have been working around this exact bug.**
Its comment justifies full-mesh pre-wiring because a star topology "leaves leaf↔leaf `/sign` dials to
resolve cold and intermittently fall short of quorum". Cold resolution *is* address-book resolution.
Worth re-testing now that push is live; if the pre-warm turns out to be unnecessary, that is a
separate ticket.

**`packages/quereus-plugin-optimystic` needs no separate treatment.** It depends on
`@libp2p/identify@^4.0.10` but never builds a libp2p node of its own — both call sites
(`optimystic-adapter/collection-factory.ts:147` and `optimystic-adapter/key-network.ts:43`) go through
`createLibp2pNode` from `@optimystic/db-p2p`, so they inherit both fixes. Verified, no action needed.

## Review focus suggestions

- The deviations section above — three judgement calls, all reversible.
- `EXPECTED_SERVICE_KEYS` in `node-service-set.spec.ts`: is the literal list right, and is deleting
  `dcutr-autonat-registration.spec.ts` outright the right call versus keeping it alongside?
- Whether the written-out protocol-id literals are correct (they were checked against the builders,
  but that is exactly the kind of thing a second reader catches).
- `spawnCircuitOnlyPeerWithoutPush` in `relay-address-propagation.spec.ts` hand-builds a libp2p node
  in test code. That duplication is deliberate — `NodeOptions` has no seam for removing a service,
  and adding one purely so a test can disable a fix would put the fix's own kill switch into
  production code — but it is duplication, and it will drift if the base node's transports change.
