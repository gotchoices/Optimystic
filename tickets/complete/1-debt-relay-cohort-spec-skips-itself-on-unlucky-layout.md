description: A test that was silently skipping itself about one run in ten — while the suite still reported green — now runs every time and fails loudly if the thing it exists to check cannot be exercised. Reviewed and landed.
files: packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts, packages/db-p2p/test/util/relay-topology.ts
----

# The relay-crossing write spec now runs every time

## What landed

Two test files; no production code touched.

`packages/db-p2p/test/util/relay-topology.ts` gained `spawnPlainRelayNode(network, { host? })` — a hand-assembled libp2p node with webSockets + noise + yamux and exactly two services: `identify` under the network-scoped slash-less prefix `optimystic/<network>`, and `circuitRelayServer({ reservations: { applyDefaultLimit: false } })`. It advertises neither `/optimystic/<net>/cluster/1.0.0` nor `/optimystic/<net>/repo/1.0.0`. `spawnRelayNode` and all seven of its callers are unchanged; the helper is purely additive.

`packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts` was rewritten around that relay. The 24-candidate keyspace search and the `this.skip()` that followed it are gone, as is the 40 s FRET `exportTable` convergence wait. One fixed block id. The only remaining `skip` is the `OPTIMYSTIC_INTEGRATION` gate in `before`. The coordinator spawner returns `OptimysticNode`, so the `(a as any).keyNetwork` / `.coordinatedRepo` casts are gone; the `commit({...} as any)` request cast stays, as the plan directed (that conversion belongs to `debt-node-attachment-reads-bypass-typed-surface`).

## Why the skip is gone rather than rarer

`findCluster` reserves one cohort slot for self and keeps `clusterSize - 1` others — at this spec's `clusterSize: 2`, exactly one non-self slot — and admits only peers it has positively classified as serving this network. An Optimystic relay advertises this network's cluster/repo protocols, so it classified as `serves` and competed with coordinator B for that one slot; which of the two won a given key was fixed by the run's random peer-id layout, so on an unlucky layout all 24 probes missed together.

A plain relay advertises neither protocol, so `membershipOf` classifies it `foreign` and drops it from every cohort on every layout. A and B are then the only serving peers, and the single non-self slot can only be B. Verified against the source during review: `membershipOf` (`packages/db-p2p/src/libp2p-key-network.ts:1220`) returns `foreign` for any peer whose non-empty protocol list lacks both ids, and `findCluster` builds `others` from `serves` only.

## Review findings

### Checked and clean

- **The central claim, against the production source.** `findCluster`'s membership-scoped path and `membershipOf` do behave as the spec's header and the helper's doc comment describe. The over-fetch band (`max(clusterSize * 4, clusterSize + 16)` = 18 here) is wider than the three-node mesh, so B is always a candidate — the cohort wait is gated on identify and ring convergence alone, with no residual keyspace lottery.
- **Resource cleanup.** Each node is assigned to its `let` before the next `await`, so a mid-setup throw still leaves every already-started node visible to `afterEach`, which stops all three together under `Promise.allSettled`.
- **Vacuity.** All four assertions can fail: the cohort set-equality and the two protocol-absence assertions were shown red by negative control A, and the identify-presence assertion by control B (both re-run this pass — see below). The `aToB.length > 0` guard stops `every` passing on an empty list.
- **`relay-topology.ts`'s rewritten header.** Its list of eight consumer specs matches the tree. Its dropped claim that these helpers are "only used by the `RUN_LONG_TESTS`-gated specs, never by the default unit suite" was **false** — four of the eight (`open-protocol-stream-relay`, `relay-inbound-source-address`, `relay-self-relay-only-dial`, `relay-third-party-address-gap`) are ungated and do run in the default unit suite. Dropping it was a correct de-staling, so it was not restored.
- **Docs.** Read every doc that could plausibly describe this spec or these helpers — `docs/architecture.md` (its two `it.skip` inventory paragraphs and the per-subsystem table), `docs/releasing.md`, `docs/cohort-topic.md`, `AGENTS.md` § Testing, and `packages/db-p2p/docs/{cluster,repo,storage}.md`. None names this spec, `relay-topology.ts`, or a pending-count expectation. Nothing to update — stated explicitly rather than left silent.
- **Same-class instances elsewhere.** Swept every spec that spawns a relay *and* touches cohort membership. Only `relay-inbound-source-address.spec.ts` also runs an Optimystic relay at `clusterSize: 2`, but its topology holds just two Optimystic nodes, so the one non-self slot is uncontested — no lottery. It also already carries a vacuity guard and ends in a red assertion rather than a skip. Not an instance.

### Minor — fixed in this pass

- **The limited-connection predicate was re-derived in the test.** The spec defined a local `isRelayed` with a loose structural parameter type (`{ limits?: unknown; remoteAddr?: { toString(): string } }`), commented as "the same rule as `isLimitedConnection`". Two problems: the copy can silently drift from the production rule it claims to mirror, and the weak type would accept anything. Replaced with a direct import of `isLimitedConnection` from `src/network/open-protocol-stream.ts`, typed `(c: Connection)`. The `dial-options-single-site.spec.ts` guard is unaffected — it restricts `dialProtocol`/`newStream`/`handle` calls under `src`, not imports from tests.
- **The cohort was read twice.** The `waitFor` polled one `findCluster` result and the set-equality assertion took a second, independent one — the implementer flagged the window himself. Switched to `waitForValue`, which returns the cohort the poll actually accepted, so the assertion judges that same observation. One fewer `findCluster` call and no window.
- **The relay's cohort mechanics were stated in three places** — the spec header, `spawnPlainRelayNode`'s doc comment, and the call-site comment — with three chances to drift. Trimmed the spec header's re-derivation to a short statement pointing at the helper's doc, which is the right home for it. The header's unique content (the measured history of the two earlier preconditions, and the conclusion) is kept in full; the one-sentence "do not simplify this back" call-site comment is kept as the regression guard the plan asked for.

### Major — one ticket filed

- **Nothing stops the next author writing the same self-excusing test.** The defect this ticket fixed was an instance of a class: a test that inspects the network it just built and calls `this.skip()` when it does not like what it sees, producing a pending count that varies run to run inside an otherwise-green suite. Climbing the ladder past a point fix: all thirteen remaining `this.skip()` calls under `packages/db-p2p/test` now decide purely from `process.env`, which makes "a skip condition reads only configuration" a currently-true, mechanically-checkable invariant — and this package already enforces two structural rules of exactly this shape (`dial-options-single-site.spec.ts`, `testing-entry-runtime-deps.spec.ts`), both for silent failure modes. Filed as `backlog/debt-a-test-can-quietly-decide-not-to-run` (a boundary-invariant guard, not a point fix). Site-claim grep over the whole board found nothing open touching those paths.

### Considered and declined, with reasons

- **No negative control for "every A→B connection is relayed"** — the implementer named this the weakest-evidenced assertion. Building one means giving A and B a direct transport, which dismantles the topology the rest of the spec rests on. Resolved structurally instead: both coordinators carry only `webSockets()` + `circuitRelayTransport()` and listen *only* on `<relay>/p2p-circuit`, so neither has a direct address for anything — DCUtR included — to dial. There is no path to circumvent the assertion in this topology, and after this pass it delegates to production's own `isLimitedConnection`, so its definition of "relayed" cannot drift from the write path's.
- **Re-asserting the relayed-connection property after the write** rather than only before it. Would convert "held as a precondition" into "held across the write" for three lines, but by the same structural argument no direct connection can appear mid-write. Left as a precondition; adding it would be noise.
- **`spawnPlainRelayNode` hard-codes `applyDefaultLimit: false`** where `spawnRelayNode` takes it as an option. No caller needs a capped plain relay, and adding an unused parameter for symmetry is speculative. Trivially added when something needs it.
- **The spec's comment density (88 of 219 lines).** High, but after the de-duplication above what remains is the measured history and the reasoning that stops the next reader from undoing the fix — the expensive knowledge, not restatement of the code. Left as is.

### Tripwire

- The implementer parked a `NOTE:` on `COHORT_TIMEOUT_MS` recording that a genuinely-failing cohort precondition burns the full 60 s before going red. Confirmed live this pass: negative-control run 6 of 6 timed out at exactly 60 s, against ~0.4 s for a passing run. The note and its revisit condition are accurate; left in place, no ticket.

## Verification run during review (all on this tree, Windows, loopback)

| gate | result |
|---|---|
| `yarn workspace @optimystic/db-p2p typecheck` | exit 0 |
| `npx eslint` on both changed files | exit 0 |
| the spec, 20 consecutive runs, after the review edits | **20 passing / 0 failing / 0 pending**, 329–633 ms each |
| `yarn workspace @optimystic/db-p2p test` | 2705 passing, 50 pending, 0 failing |
| `yarn workspace @optimystic/db-p2p test:integration` | 31 passing, 2 pending, 0 failing — the relay spec ran and passed in 245 ms |

Negative controls re-run against the reviewed code, both restored from scratchpad copies afterwards (`git status` shows only the intended spec change):

- **Control A** — an Optimystic relay put back in the keyspace (`spawnRelayNode as spawnPlainRelayNode`), 6 runs: **0 passing / 6 failing.** Five failed on `the relay must not serve this network's cluster protocol`; one on `waitForValue timed out after 60000ms: A's cohort for 'mcw-relay-block' includes the relay-only coordinator B` — the unlucky layout that the old spec would have silently skipped, now red, and the substituted `waitForValue` still names the condition.
- **Control B** — `identify` dropped from the plain relay, 1 run: failed with `A never saw the relay's identify protocol /optimystic/multi-coord-write-relay-it/id/1.0.0; its peerStore holds: ["/ipfs/ping/1.0.0","/libp2p/circuit/relay/0.2.0/hop","/libp2p/circuit/relay/0.2.0/stop"]`. The spec still distinguishes exclusion-as-`foreign` from exclusion-as-`unknown`.

The 2 pendings in the integration run are both pre-existing static `it.skip`s in the cohort-topic substrate suite, tagged with their own tracking tickets and unrelated to this work. The relay spec contributes zero pendings, which is the symptom this ticket existed to remove. No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Not done

- `yarn check` at repo root (lint + lint:docs + build + typecheck + test + test:integration across all workspaces) was not run, in review either. The change is test-only and confined to `packages/db-p2p/test/`, which the five gates above cover end to end; the root gate's wall clock puts it outside an agent run. It is the documented pre-release gate (`docs/releasing.md`) and a human or CI should run it before release.
- No production code was read for the underlying relayed-promise *behaviour* beyond what was needed to verify the spec's claims (`findCluster`, `membershipOf`, `isLimitedConnection`). This ticket was about the test's honesty, not the write path it exercises.

## Follow-on filed

- `backlog/debt-a-test-can-quietly-decide-not-to-run` — a structural guard so no future test can decide at run time, from observed state, whether to run at all.
