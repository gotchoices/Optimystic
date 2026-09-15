description: The sereus integration-test harness no longer type-checks against this repository, because optimystic now only accepts a block's lookup key when it comes from one shared helper, and the harness builds its own bytes in three places. Someone with access to sereus needs to land a three-line type fix there.
files:
  - ../sereus/packages/integration-tests/src/harness/control-cohort.ts (line 73 `CONTROL_COHORT_PROBE_KEY`; line 275 `findCluster` patch wrapper)
  - ../sereus/packages/integration-tests/src/harness/forced-cluster.ts (line 243 `findCluster` patch wrapper)
  - packages/db-core/src/network/routing-key.ts (the `RoutingKey` type and `routingKeyForBlock` helper sereus should use)
----

# What changed here

Optimystic's key network (`IKeyNetwork.findCluster` / `findCoordinator` / `recordCoordinator`) used to take any `Uint8Array`. The client pre-hashed block ids while the servers did not, so on networks wider than one replica group the client asked the wrong machines for blocks. The fix (ticket `routing-key-single-encoding`) made every caller go through `routingKeyForBlock(blockId)`, which returns a branded `RoutingKey` type: the raw utf8 bytes of the id, typed so a plain byte array no longer compiles as an argument.

The bytes did not change for sereus. Sereus already passed raw utf8, so its runtime behaviour is unaffected. Only its types break.

# What breaks in sereus

Sereus symlinks `@optimystic/db-core` and `@optimystic/db-p2p` to this checkout. Running `tsc -p tsconfig.typecheck.json` in `../sereus/packages/integration-tests` gives exactly three errors, as measured by the implementer of `routing-key-single-encoding`:

- `src/harness/control-cohort.ts`: `CONTROL_COHORT_PROBE_KEY` is declared `Uint8Array` (`new TextEncoder().encode('sereus-control-cohort-probe')`) and passed to `findCluster`.
- `src/harness/control-cohort.ts` (about line 275) and `src/harness/forced-cluster.ts` (about line 243): the `findCluster` patch wrappers declare `key: Uint8Array` and forward it with `inner.call(this, key)`.

# The fix (in sereus, same bytes)

- `export const CONTROL_COHORT_PROBE_KEY = routingKeyForBlock('sereus-control-cohort-probe');` (import `routingKeyForBlock` from `@optimystic/db-core`).
- Type both wrapper parameters as `RoutingKey` (a type import from `@optimystic/db-core`).
- The `_key: Uint8Array` stubs at `forced-cluster.ts` lines 170 and 234 do not forward the key, so a wider parameter type is still assignable. They can stay, or be retyped for consistency.

Afterwards, run sereus's `strand-membership-closed-strand-e2e` and `harness-party-control-cohort` scenarios once. Nobody has run them against this change.

# Why this is blocked

The code lives in a sibling repository that this pipeline does not edit. The alternative is to decide the brand should not reach sereus's harness, for example by loosening the wrapper-facing types in db-p2p. That would reopen the class of bug the brand closes, so the recommendation is the sereus-side fix above.
