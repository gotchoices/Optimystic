description: The gated integration test "the verifier does a one-fetch-and-retry over /membership when its cached cert is stale" fails deterministically — it primes the verifier with a stale cert via `cache()` (which marks it `trusted`), and the trust-anchor gate added later correctly refuses to TOFU-replace a trusted cert with an un-anchored refetch. The test models a scenario the trust model now rejects by design and was never updated when the gate landed; decide whether to redesign the test (seed a non-trusted/TOFU stale cert or serve an attested rotation cert) or adjust the gate.
prereq:
files:
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts (§2 MembershipCertV1 block, the "one-fetch-and-retry ... when its cached cert is stale" test ~L450-474)
  - packages/db-core/src/cohort-topic/membership/verifier.ts (CachingMembershipVerifier.cache, verifyMessage, loadFrom, certIsTrusted, fallbackTrust)
----

# Stale-cert refetch integration test contradicts the membership trust-anchor gate

## Failing test

- Suite: `substrate over real libp2p (cohort-topic / reactivity / matchmaking fidelity)` (§2, the
  MembershipCertV1 block).
- Test: `the verifier does a one-fetch-and-retry over /membership when its cached cert is stale`.
- File: `packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts:474`.
- Gated: requires `OPTIMYSTIC_INTEGRATION=1` (the `describe` is `describe.skip` otherwise), so it is
  **not** part of the default `yarn test`.

Command (from `packages/db-p2p`):

```
OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/**/*.integration.spec.ts" --grep "stale" --reporter spec
```

(equivalently `OPTIMYSTIC_INTEGRATION=1 yarn test:integration`).

### Error output

```
  substrate over real libp2p (cohort-topic / reactivity / matchmaking fidelity)
    1) the verifier does a one-fetch-and-retry over /membership when its cached cert is stale

  0 passing (554ms)
  1 failing

  1) ... the verifier does a one-fetch-and-retry over /membership when its cached cert is stale:
       a stale cached cert triggers one /membership refetch, then verifies
       + expected - actual
       -untrusted
       +verified
       at Context.<anonymous> (test\substrate-real-libp2p.integration.spec.ts:474:93)
```

Reproduces deterministically in isolation (with `--grep "stale"`, none of the matchmaking code
running). It is the §2 membership-verifier path, not the matchmaking walk.

## Root cause

The test primes the verifier with a fabricated stale cert and expects the failed message-verify to
force one `/membership` refetch that returns the genuine cohort cert and verifies:

```ts
const staleCert: MembershipCertV1 = {
  v: 1, cohortCoord: bytesToB64url(coord0),
  cohortEpoch: bytesToB64url(new Uint8Array([9, 9, 9])),
  members: stale, stabilizedAt: Date.now() - 1_000_000,
  thresholdSig: bytesToB64url(new Uint8Array([0])), signers: stale,
};
verifier.cache(staleCert);
```

But `CachingMembershipVerifier.cache()` is documented as feeding the node its *own freshly-published*
cert, so it stores the entry as **`trusted: true`** (`verifier.ts:135-139`).

On `verifyMessage`:
1. the cached (stale) cert fails message verification (the real signers are not a subset of it);
2. the single `source.fetch()` refetch returns the genuine cohort cert;
3. `loadFrom` → `certIsTrusted(genuineCert)`: it is self-consistent but carries **no** rotation
   attestation (it is the original cert, not a rotation off the fabricated `[9,9,9]` epoch), so it
   falls through to `fallbackTrust`;
4. `fallbackTrust` (`verifier.ts:255-257`) sees coord_0 already holds a **trusted** cert (the primed
   stale one) and returns `"reject"` — the deliberate "no silent TOFU downgrade" property that gives
   the attestation chain its teeth;
5. `loadFrom` discards the refetched cert → `verifyMessage` returns `"untrusted"`.

So `"untrusted"` is **by design** under the trust-anchor model. The test models an unrealistic
scenario (replacing a *trusted* cached cert with an un-anchored refetch) that the gate now correctly
rejects.

### History (why it is stale, not a regression)

- The test was authored in `c34032d` (`substrate-e2e-real-libp2p-tier`), **before** the trust gate.
- The trust-anchor gate (`fallbackTrust` / "no TOFU downgrade" / attestation chain) landed in
  `c8eba08` (`cohort-topic-trust-anchor-core`): it added 208 lines to `verifier.ts` but did **not**
  update this integration test.

The production behavior is defensible: in a real rotation the successor cert carries a rotation
attestation (`prevEpoch`/`rotationSig`/`rotationSigners`) and is accepted via `chainGrantsTrust`; the
refetch-and-replace path only legitimately fires for a cold coord (TOFU) or an attested rotation, not
for replacing a fabricated trusted cert.

## What to decide

Pick one (the test redesign is the likely answer; the gate is intentional and well-documented):

1. **Redesign the test** to exercise the refetch path consistently with the trust model, e.g.:
   - seed the stale cert as a **non-trusted / TOFU** entry (it must arrive via the membership
     *source* `current()`/`fetch()`, not via `verifier.cache()` which marks trusted) so the
     fallback permits a one-time replacement; or
   - have the cohort serve a cert carrying a valid **rotation attestation** off the primed
     predecessor so `chainGrantsTrust` accepts the refetch; or
   - start from a **cold** verifier cache (missing, not stale) so the refetch is plain TOFU.
   Note the verifier's own `byCoord` cache and the source's cache are separate, and the only public
   verifier seeding API (`cache()`) marks `trusted` — a faithful "stale TOFU cache" test needs to
   seed through the source.
2. **Adjust the gate** only if product intent is that an un-anchored refetch *should* be able to
   replace a trusted-but-stale cert — this would weaken the "no TOFU downgrade" property and should
   not be done without a security review.

## Ruled out

- Not caused by the matchmaking `matchmaking-query-rpc-seeker-walk` diff: that diff does not touch
  `verifier.ts` or this §2 block, and the test reproduces in isolation with none of the matchmaking
  code running.
- Not a flaky/timing failure: deterministic across runs in isolation (unlike the separate
  `mesh-lifecycle` withdraw flake, which was a per-run random-key effect and is fixed separately).
- Not gated in default CI: requires `OPTIMYSTIC_INTEGRATION=1`, so it does not affect `yarn test`.
