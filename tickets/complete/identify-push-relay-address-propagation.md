---
description: A peer reachable only through a relay never told its already-connected neighbours the address the relay gave it, so they later failed to reconnect to it. The missing address-push is registered and is now covered by tests that were confirmed to fail when the fix is removed.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/relay-address-propagation.spec.ts, packages/db-p2p/test/identify-push-propagation.spec.ts, packages/db-p2p/test/node-service-set.spec.ts, packages/db-p2p/test/identify-protocol-id.spec.ts, packages/db-p2p/test/util/peer-store-wait.ts, packages/db-p2p/test/util/protocol-ids.ts, packages/db-p2p/test/util/relay-topology.ts, packages/db-p2p/test/dcutr-direct-upgrade.spec.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts, AGENTS.md
difficulty: medium
---

Closes [gotchoices/Optimystic#7](https://github.com/gotchoices/Optimystic/issues/7) (the missing
address/protocol re-push) and [#6](https://github.com/gotchoices/Optimystic/issues/6) (a malformed
protocol id with a doubled slash).

## What shipped

**Production change** (commit `849fd94`, made before this ticket and reviewed on its merits here):
`identifyPush` is registered alongside `identify` in `createLibp2pNodeBase`, and both are handed a
slash-less protocol prefix because `@libp2p/identify` prepends the leading slash itself. Every other
service (`cluster` / `repo` / `sync` / `blockTransfer`) builds its own id and keeps the
slash-prefixed form; the comment at the registration site explains the asymmetry.

The implement stage changed no production behaviour. It added the tests that make the fix a guard
rather than a claim, plus a shared well-formedness assertion over the whole advertised protocol
list — which is the check that would have caught #6 without anyone having suspected `identify`
specifically.

**Tests added:** `relay-address-propagation.spec.ts` (relay + relay-only client + sibling; asserts
the relay's address-book view, plus a gated negative control that reproduces `NoValidAddressesError`
with push removed), `identify-push-propagation.spec.ts` (a protocol handler registered after the
initial handshake propagates and flips a peer from `foreign` to `serves`), `node-service-set.spec.ts`
(the complete service key set across four node shapes, replacing the one-name-at-a-time
`dcutr-autonat-registration.spec.ts`), `identify-protocol-id.spec.ts`, and shared helpers
`util/protocol-ids.ts` / `util/peer-store-wait.ts`. Three node-wiring specs had their expected
protocol ids converted from self-derived to written-out literals.

## Review findings

### Verification performed

The load-bearing question for this ticket is whether the new specs are real guards or specs that
pass for unrelated reasons. That was tested directly rather than taken on trust — the fix was
mutated two ways and the suite re-run each time:

| Mutation | Result |
| --- | --- |
| `identifyPush` removed from the services map | **7 failures.** `relay-address-propagation` propagation case, `identify-push-propagation`, all 4 `node-service-set` cases, `identify-protocol-id`. |
| `identifyPush` prefix reverted to the slash-prefixed (`#6`-malformed) form | **6 failures**, including `expectWellFormedProtocolIds` naming the offending id verbatim: `["//optimystic/<net>/id/push/1.0.0"]`. |

Source was restored after each mutation and confirmed byte-identical to `HEAD` (`git diff` over
`packages/db-p2p/src/` empty).

Two documented non-guards were confirmed as documented, not silently assumed: the sibling re-dial
case in `relay-address-propagation.spec.ts` still passes with push removed (its own comment says so
and explains what it *does* earn its place for), and the new peer-id-only re-dial in
`real-libp2p.integration.spec.ts` completes in 76 ms — i.e. it resolves from the initial handshake,
not from a push. Both are honest about their scope in-file.

Also checked and found correct: `EXPECTED_SERVICE_KEYS` matches the services map exactly (12 base
keys + `relay`; the reactivity/cohort-topic handlers are registered via `node.handle`, not as service
keys, so their absence from the list is right); every written-out protocol-id literal matches its
builder (`buildBlockTransferProtocol`, `DEFAULT_REACTIVITY_PROTOCOLS`, `membershipOf`'s
`cluster`/`repo` suffixes); `Libp2pKeyPeerNetwork`'s 7-argument constructor call and the
`membershipOf` signature the push spec reaches into; `findMalformedProtocolIds` rejects leading,
interior and trailing empty segments; every new spec tears its nodes down (`afterEach` or
`try`/`finally`), and the new integration case registers its nodes with the existing teardown array;
`identify()` has exactly one production call site, so no other package needed the same fix.

### Fixed in this pass (minor)

- **Dangling reference to a deleted file.** `dcutr-direct-upgrade.spec.ts` pointed readers at
  `dcutr-autonat-registration.spec.ts` for service-presence coverage — the file this ticket deleted.
  Repointed at `node-service-set.spec.ts`.
- **Duplicated polling loop.** `util/peer-store-wait.ts` had two near-identical 12-line
  poll-until-timeout loops differing only in what they read off the peer record. Extracted a private
  `pollPeerStore` generic; both exported wrappers keep their signatures and result shapes unchanged.
- **Two unnecessary `as any` casts.** `identify-push-propagation.spec.ts` and
  `identify-protocol-id.spec.ts` cast their `createLibp2pNode` options object. Every field
  (`fretProfile`, `clusterPolicy`, `arachnode`, …) is a real `NodeOptions` member — the casts
  compiled away to nothing but would have hidden a future typo in the options. Removed; `tsc` clean
  without them.
- **Stale header inside a brand-new file.** `node-service-set.spec.ts` described itself as covering
  three node shapes; it has four cases (the `relay: true` one was missing from the list).
- **Repeated backstory.** The `#6` explanation is restated at length in six files. Trimmed the
  worst instance (16 comment lines for 3 constants in `reactivity/node-wiring.spec.ts`) to a pointer
  at the canonical explanation in `util/protocol-ids.ts`. The remaining copies were left: each sits
  at a site where a reader plausibly starts cold, and churning five more files' comments during a
  review pass buys less than it risks.
- **Documentation gap the change opened.** `AGENTS.md` gained a paragraph in this same commit
  calling `yarn check` "the full gate". It is not — a third tier of specs gates on its own env var
  (`RUN_LONG_TESTS`, `RUN_DCUTR_HOLEPUNCH`, and `RUN_LONG_TESTS_CONTROL`, the one this ticket's
  negative control uses) and runs in no script at all. Documented that tier, with the grep that
  enumerates it.

### Filed as a new ticket (major)

`backlog/debt-mixed-version-identify-incompatibility.md` — fixing #6 changed the protocol string
peers use to introduce themselves, so a node built before the fix and one built after can no longer
complete that handshake. They still connect, but neither learns the other's service list, and
peer-selection skips any peer whose service list is empty. A staged upgrade therefore splits the
network silently. Filed rather than fixed because the right response (coordinated upgrade + a
release note, a transitional release speaking both strings, or making the skip legible in logs) is a
human decision, and the repository has no changelog to hang the note on.

### Recorded as a tripwire, not a ticket

`spawnCircuitOnlyPeerWithoutPush` in `relay-address-propagation.spec.ts` hand-builds a libp2p node,
duplicating the production transport list. That is deliberate and correct today — `NodeOptions` has
no seam for removing a service, and adding one purely so a test can disable a fix would put the
fix's kill switch into production code. The conditional risk is that if the base node's transports
ever diverge, this control could stop propagating for the *wrong* reason and still assert green.
Parked as a `NOTE:` at the function, naming the right response if it trips (rebuild from the shared
transport list — do not relax the assertion).

### Checked and found nothing

- **Documentation currency.** Read every doc that mentions protocols or peer classification.
  `packages/db-p2p/docs/cluster.md` §Network-Membership Scoping, `docs/repo.md` and
  `multi-coordinator-cross-network-write.integration.spec.ts` all already spell the identify id in
  its corrected single-slash form and describe behaviour that is still accurate. No doc enumerates
  the libp2p services map, so nothing there went stale when `identifyPush` was added. (The `README.md`
  §Libp2p Integration snippet is stale — it shows a `createLibp2pNode({ services: … })` API that does
  not exist — but it was stale before this ticket and is unrelated to it.)
- **Other packages.** `quereus-plugin-optimystic` depends on `@libp2p/identify` but never builds a
  node; both call sites go through `createLibp2pNode`, so they inherit both fixes. Confirmed by
  searching for `identify(` across all packages — one production call site total.
- **The implementer's three flagged judgement calls.** All three were re-examined and all three
  stand. Not gating the positive relay cases is right (measured 1.1 s + 0.24 s, and this repository
  has no CI, so an env-gated guard is a guard that does not run). Splitting the peerStore poll helper
  out of `relay-topology.ts` is right (the protocol spec uses it with no relay involved). Calling the
  well-formedness helper once per *node shape* rather than in all 18 node-spawning specs is right —
  the shapes are what vary, and the mutation run confirmed the coverage catches a malformed id at
  every one of them.
- **Resource cleanup and error paths.** No leaks found; see the verification list above.

### Deliberately not re-litigated

The implementer's "Follow-ups noticed, not fixed" list (the integration tier's habit of wiring meshes
from in-process address lists; the possibility that
`substrate-real-libp2p.integration.spec.ts`'s full-mesh pre-warm was working around this very bug) is
sound analysis and remains unfiled. Both are speculative until someone measures them, and neither is
a defect in this ticket's work. They are preserved in the git history of the implement-stage ticket.

## Validation

All run from a clean tree after the review edits above.

| What | Result |
| --- | --- |
| `yarn lint` (root, eslint) | clean |
| `yarn build` (all workspaces) | clean |
| `yarn workspace @optimystic/db-p2p build` (`tsc`, `src` + `test`) | clean |
| Full `db-p2p` suite | **1318 passing, 38 pending, 0 failing**, 28 s |
| `relay-address-propagation` + `real-libp2p.integration` with `RUN_LONG_TESTS_CONTROL=1 OPTIMYSTIC_INTEGRATION=1` | **12 passing**, 26 s |
| Mutation probes (fix removed; prefix reverted) | fail as expected — table above |

No pre-existing failures were encountered, so `tickets/.pre-existing-error.md` was not written.

## How to exercise it

```
# default run — includes both propagation specs (~2 s of the total)
yarn workspace @optimystic/db-p2p test

# the slow negative control (asserts a timeout; ~20 s)
# PowerShell:
$env:RUN_LONG_TESTS_CONTROL=1; yarn workspace @optimystic/db-p2p test --grep "Relay address propagation"
# bash:
RUN_LONG_TESTS_CONTROL=1 yarn workspace @optimystic/db-p2p test --grep "Relay address propagation"

# the new peer-id-only re-dial edge
# PowerShell:
$env:OPTIMYSTIC_INTEGRATION=1; yarn workspace @optimystic/db-p2p test:integration
```

## Known limits, carried forward

- **Timing budgets.** Both propagation specs poll rather than sleep, but they poll across two chained
  libp2p debounce windows (~1 s address coalescing, ~1 s push debounce). Budgets are 15–20 s against
  an observed ~1 s. If these ever go flaky on a loaded machine, raise the budgets — do not loosen the
  assertions.
- **The relay cannot re-dial its own reserved client** (`InvalidPeerIdError: Can not dial self`,
  because every address it knows for that client routes back through itself). That is why the
  reconnect assertion needs a third peer; worth knowing before anyone "simplifies" the topology.
- **No CI exists.** Every guard here runs only when a human runs it. Out of scope for this ticket,
  but the exposure is real and is now at least documented in `AGENTS.md`.
