description: Fixed and reviewed a broken integration test for the membership verifier's stale-cert refetch — it now seeds the stale cert through the TOFU path the trust model permits, and asserts the real refetch actually replaced the stale view.
prereq:
files:
  - packages/db-p2p/src/cohort-topic/host.ts (CohortTopicHost.membershipSource introspection shim L463-469, return object L883)
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts (stale-refetch test L451-490)
  - packages/db-core/src/cohort-topic/membership/verifier.ts (trust gate — read-only reference)
  - packages/db-core/test/cohort-topic/membership.spec.ts (unit coverage of exact fetch-count — read-only reference)
difficulty: easy
----

# Stale-cert refetch integration test vs. trust-anchor gate — implemented & reviewed

## What was implemented (Path A)

The gated integration test had primed the verifier via `verifier.cache(staleCert)`, which marks the
cert **trusted**; a genuine but un-anchored `/membership` refetch then hit the "no silent TOFU
downgrade" invariant (`fallbackTrust` → `"reject"`) and the verdict was correctly `"untrusted"` —
contradicting the test's `"verified"` expectation. The implement stage redesigned the test to seed
the stale cert through the membership **source** (TOFU-cached, *not* trusted), which the trust gate
permits a refetch to replace. To reach the source from a test it added a `membershipSource`
introspection shim to the `CohortTopicHost` interface (same spirit as `promoteGate` /
`gossipTransport`).

## Review findings

**Scope reviewed:** the implement diff (`4441ba7`), `host.ts` interface + return object, the rewritten
integration test, the membership verifier trust gate (`verifier.ts`), `FretMembershipSource`, and the
unit coverage at `membership.spec.ts:77-144`. Ran `tsc` build, the gated `§2 MembershipCertV1`
integration block, the db-p2p default unit suite, and the db-core unit suite.

### Correctness / trust-model — confirmed sound
- The redesigned flow matches the gate: verifier `byCoord` cold → `source.current()` yields the
  seeded stale cert → non-self-consistent (`thresholdSig:[0]`) → `certIsTrusted` = `"reject"`, not
  cached → exactly one `source.fetch()` → genuine cert → no trusted entry exists → `fallbackTrust` =
  `"tofu"` → message verifies → `"verified"`. Verified against `verifier.ts:141-218,255-257`.
- `freshParticipant` (third distinct node) is always defined: `clampN` floors N at 3
  (`integration.spec.ts:103-106`), so the `!` is safe.
- The `membershipSource` shim type is structurally satisfied by `FretMembershipSource`; build is clean.

### Finding (MAJOR weakness in the implement test) — **fixed inline this pass**
The implement-stage test asserted **only** the final verdict `"verified"`. Because the seeded stale
cert is non-self-consistent it is *rejected outright* and never cached — behaviorally identical to an
empty cache. So the test would have reached `"verified"` **even if the seed line were deleted**
(`current()` → undefined → fetch → verified), making the seed inert and the test near-redundant with
integration test 1's cold-verify path. Its name ("forces one real /membership refetch") was not
backed by any assertion that a refetch fired or replaced the stale view.

**Fix applied (minor, inline):**
- Widened the `CohortTopicHost.membershipSource` shim to also expose
  `current(coord): Promise<Uint8Array | undefined>` (already present on `FretMembershipSource`).
- The test now (a) asserts `current(coord0)` equals the seeded stale bytes *before* the verify
  (proving the seed took, so it is no longer inert), and (b) asserts `current(coord0)` is no longer
  the stale bytes *after* the verify — `FretMembershipSource.fetch()` re-caches the genuine
  `/membership` reply (`membership-source.ts:54`), so a changed `current()` is direct proof the
  refetch fired and replaced the unusable cached view.
- Bonus: the post-verify assertion now also **guards the verifier-cold assumption** — if a future
  change caused `freshParticipant`'s verifier to pre-cache coord0 (short-circuiting the source path),
  the test fails loudly instead of passing vacuously. It passed, empirically confirming the verifier
  is cold and the refetch genuinely fires.
- Exact fetch-count ("exactly one refetch", `current()` consulted once) remains faithfully
  unit-covered at `membership.spec.ts:77-88` with a counting `MockSource`; the integration test now
  pins the *refetch-replaces-stale* behavior at the real-network layer, which the unit test cannot.

### Other aspects — checked, no findings
- **Resource cleanup / lifecycle:** no new resources; the change is a read-only introspection seam
  plus a test. Empty (nothing to clean up).
- **Error handling:** the verify path's error handling is unchanged; the test's `current()` reads are
  guarded for `undefined`. Empty.
- **Docs:** `docs/cohort-topic.md` does not enumerate `CohortTopicHost` members field-by-field (the
  sibling introspection fields `promoteGate`/`gossipTransport` are likewise undocumented there), so the
  additive test-introspection field needs no doc update. No doc the diff touches went stale.
- **Type safety / DRY / SPP:** shim is structurally satisfied, no `any`/unsafe casts; reuses the
  existing `staleMemberBytes()`/`staleCert` shape and the imported `bytesEqual`. Empty.

## Validation results (this review pass, after the inline fix)

All commands streamed (`tee`), no silent redirection.

- **Build (tsc, type-check):** `cd packages/db-p2p && yarn build` → exit 0, clean.
- **Gated §2 integration block:**
  `OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.integration.spec.ts" --grep "MembershipCertV1|membership|stale|threshold-signed" --reporter spec`
  → **3 passing (740ms)**, including ✔ `a stale cert in the membership source forces one real /membership refetch, then verifies` (now with the before/after `current()` assertions).
- **db-p2p default unit suite:** `cd packages/db-p2p && yarn test` → **1062 passing, 37 pending**, exit 0.
- **db-core unit suite:** `cd packages/db-core && yarn test` → **996 passing**, exit 0 (stale-refetch unit test at `membership.spec.ts:77` untouched and passing).
- **Lint:** root `lint` script is a no-op (`echo 'Lint not configured for all packages'`); `tsc` is the type gate and is clean.

## Outcome
Implementation accepted with one inline strengthening of the integration test (assertion weakness →
the refetch is now observably proven). No new tickets filed; the behavior is fully covered between the
strengthened integration test and the existing db-core unit suite.
