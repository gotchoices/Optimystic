description: A gated integration test for the membership verifier's stale-cert refetch is broken — it sets up a scenario the security trust-model now deliberately rejects. Redesign the test to match the trust model (or, as a blessed lighter alternative, delete it since the same behavior is already unit-tested).
prereq:
files:
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts (§2 MembershipCertV1 block; the "one-fetch-and-retry … when its cached cert is stale" test at ~L450-475; helper staleMemberBytes ~L141; harness RealNode/spawnNode ~L208-270)
  - packages/db-core/src/cohort-topic/membership/verifier.ts (cache L135-139, verifyMessage L141-168, loadFrom L196-219, certIsTrusted L227-246, fallbackTrust L255-257)
  - packages/db-core/test/cohort-topic/membership.spec.ts (the FAITHFUL stale-refetch unit coverage already exists at L77-88 — read this first; it is the model to mirror)
  - packages/db-p2p/src/cohort-topic/membership-source.ts (FretMembershipSource: current() reads local cache L35-37, fetch() dials L48-62, cache(coord, encoded) L65-67)
  - packages/db-p2p/src/cohort-topic/host.ts (CohortTopicHost interface L439-465; membershipSource constructed L565; host object assembled ~L786-830)
difficulty: easy
----

# Fix the stale-cert refetch integration test to match the membership trust-anchor gate

## Summary of the bug (confirmed)

The gated integration test
`the verifier does a one-fetch-and-retry over /membership when its cached cert is stale`
(`substrate-real-libp2p.integration.spec.ts:450`, asserts at `:474`) fails deterministically:

```
- expected - actual
- untrusted
+ verified
```

It primes the verifier with a fabricated stale cert via `verifier.cache(staleCert)`. But
`CachingMembershipVerifier.cache()` stores the entry as **`trusted: true`** (it is documented as
feeding a node its *own* freshly-published cert — `verifier.ts:135-139`). On the failed
message-verify, the single `/membership` refetch returns the genuine cohort cert, which is
self-consistent but carries **no** rotation attestation off the fabricated `[9,9,9]` epoch, so the
gate falls through to `fallbackTrust` (`verifier.ts:255-257`). Because coord_0 already holds a
**trusted** cert (the primed stale one), `fallbackTrust` returns `"reject"` — the deliberate
"no silent TOFU downgrade" property — and `verifyMessage` returns `"untrusted"`.

So `"untrusted"` is **correct under the trust-anchor model**. The test models a scenario the gate now
rejects by design (replacing a *trusted* cached cert with an un-anchored refetch). The trust gate
landed in `c8eba08` *after* the test was authored (`c34032d`) and never updated it. The gate is
intentional and security-relevant; **do not weaken it** (that would require a separate security
review — see "Ruled out" in the source fix ticket). The fix belongs in the test.

## Decision: redesign the test (preferred) — delete-and-rely-on-unit-coverage is a blessed fallback

The behavioral assertion the broken test *intended* — "a stale cached cert triggers exactly one
refetch, then succeeds" — is **already covered faithfully** at the unit level:
`packages/db-core/test/cohort-topic/membership.spec.ts:77-88`. That test seeds the stale cert through
the **source** (so it is TOFU-cached, *not* trusted), which is exactly what the trust model permits a
refetch to replace; its inline comment (L78-81) calls out precisely the `cache()`-marks-trusted
distinction that breaks the integration test. The cold-cache, current()-before-fetch, and
untrusted-when-absent variants are covered there too (L120-144).

The integration test's only *distinct* value is exercising this over the **real `/membership`
network**. Note that real-network one-fetch+verify is *also* already touched by integration test 1
(`:427`), where a participant cold-verifies a genuine cert end-to-end over the real protocol.

Pick **one** of the two paths below. The redesign (Path A) is preferred because it preserves a
real-network *refetch-replaces-an-unusable-cached-view* assertion that neither the unit test nor
integration test 1 makes; Path B is an acceptable lighter alternative if exposing the source is judged
not worth the surface.

### Path A — redesign to seed the stale cert through the membership SOURCE (preferred)

Make the integration test consistent with the trust model: the stale cert must arrive via the
membership *source*'s local cache (so the verifier treats it as TOFU / non-trusted), **not** via
`verifier.cache()`. Flow once seeded: verifier `byCoord` empty → `source.current()` yields the stale
cert → the gate rejects it (the existing fabricated stale cert is not self-consistent:
`thresholdSig:[0]`) → exactly one real `/membership` `source.fetch()` → genuine cert → no trusted
entry exists for the coord → `fallbackTrust` → TOFU accept → message verifies → `"verified"`.

Two harness facts that constrain this (both verified):

- **The source is not currently reachable from a test.** `CohortTopicHost` (`host.ts:439-465`)
  exposes `promoteGate` and `gossipTransport` "for test/diagnostic introspection" but not the
  `FretMembershipSource` (constructed at `host.ts:565`, local var). Add `membershipSource` to the
  `CohortTopicHost` interface and to the assembled host object (same introspection spirit as
  `promoteGate`/`gossipTransport`). Type it as `IMembershipSource` (or expose just a
  `seedMembership(coord, encodedCert)` shim) — enough to call `cache(coord, encoded)` from the test.
- **Use a FRESH participant node.** All §2 tests reuse `nodes.find(n => n.idStr !== primary.idStr)`
  (the first non-primary), whose verifier has already TOFU-cached coord_0 after test 1 — so its
  `byCoord` is non-empty and `current()` would never be consulted. The stale test must pick a
  *different* non-primary node (e.g. exclude both the primary and the test-1 participant) so the
  verifier starts cold for coord_0. Any node works as a refetch target: coord_0's cohort is the whole
  mesh, so the fresh node can resolve cohort peers and dial `/membership`.

Encode the stale cert for the source with `encodeCohortMessage` (already exported from
`@optimystic/db-core`, `wire/codec.ts:125`) — e.g. `membershipSource.cache(coord0,
encodeCohortMessage(staleCert))`. Reuse the existing `staleMemberBytes()` / `staleCert` shape
(`:141`, `:461-469`); it stays a non-self-consistent placeholder, which is fine — the assertion is
that an unusable cached view forces exactly one real `/membership` refetch that then verifies. Rename
the test to reflect the source-seeded path (e.g. "a stale cert in the membership source forces one
real /membership refetch, then verifies").

### Path B — delete the broken test (blessed lighter alternative)

If exposing the membership source on `CohortTopicHost` is judged not worth the added surface, delete
the broken test outright. Justification to record in the review handoff: the faithful behavioral
assertion is fully unit-covered (`membership.spec.ts:77`), and real-network one-fetch+verify is
covered by integration test 1 (`:427`). If you take this path, leave a one-line comment near the §2
block pointing at `membership.spec.ts:77` so the coverage is discoverable, and do **not** leave the
`staleMemberBytes()` helper (`:141`) orphaned — remove it if nothing else references it (grep first).

## Validation

This test is **gated** behind `OPTIMYSTIC_INTEGRATION=1` (the `describe` is `describe.skip`
otherwise), so it is not part of the default `yarn test`. From `packages/db-p2p`:

```
OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/**/*.integration.spec.ts" --grep "stale" --reporter spec 2>&1 | tee /tmp/stale.log
```

For Path A, also run the full §2 MembershipCertV1 block to confirm no cross-test state regression
(stream with `tee`, do not silently redirect):

```
OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/**/*.integration.spec.ts" --grep "MembershipCertV1|membership|stale|threshold-signed" --reporter spec 2>&1 | tee /tmp/membership.log
```

Whichever path: keep the default `yarn test` (db-p2p) green, and keep the db-core unit suite green
(the stale-refetch unit test must remain passing and untouched):

```
# from packages/db-core
yarn test 2>&1 | tee /tmp/db-core.log
```

If the real-libp2p suite cannot boot the N-node mesh in this environment (FRET stabilization is
timing-bound and may exceed the agent idle budget), note that in the review handoff and rely on the
db-core unit suite + a code-read of the verify flow for correctness; do not let a flaky mesh boot
block the ticket.

## TODO

- Read `packages/db-core/test/cohort-topic/membership.spec.ts:77-88` (and L120-144) to internalize the
  faithful, trust-model-consistent stale-refetch pattern before touching anything.
- Choose Path A (preferred) or Path B and record the choice + rationale in the review handoff.
- **Path A:**
  - Expose the membership source for test introspection: add `membershipSource` (typed
    `IMembershipSource`, or a `seedMembership(coord, encoded)` shim) to the `CohortTopicHost` interface
    (`host.ts:439-465`) and to the assembled host object (~`host.ts:786-830`), wiring the existing
    `membershipSource` local (`host.ts:565`).
  - Rewrite the §2 test (`:450-475`): drop `verifier.cache(staleCert)`; pick a fresh non-primary
    participant whose verifier has not yet cached coord_0; seed that node's source via
    `membershipSource.cache(coord0, encodeCohortMessage(staleCert))`; assert `verifyMessage(...)` →
    `"verified"`. Import `encodeCohortMessage` from `@optimystic/db-core`. Rename the test to the
    source-seeded phrasing.
- **Path B:**
  - Delete the broken test; add a one-line pointer comment to `membership.spec.ts:77`; grep for and
    remove the now-orphaned `staleMemberBytes()` helper if unreferenced.
- Run the gated `--grep "stale"` command above and confirm it passes (Path A) or is gone (Path B).
- Run the §2 membership block (Path A) and the db-core unit suite; confirm both green and that the
  default `yarn test` is unaffected.
- Write the review handoff: which path, why, the exact commands run with their results, and (if the
  mesh could not boot here) an explicit note that the gated suite was validated by code-read + unit
  suite rather than a live run.
