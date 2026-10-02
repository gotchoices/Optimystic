description: When a machine checks a group-signed message, it accepts a membership certificate that describes a different group than the one the message claims to come from, so one dishonest machine can get a forged message accepted. Make the checker, and the fetch that feeds it, refuse a certificate for any coordinate but the one asked about.
architecture: docs/cohort-topic.md#bootstrapping-trust
files: packages/db-core/src/cohort-topic/membership/verifier.ts, packages/db-core/test/cohort-topic/membership.spec.ts, packages/db-p2p/src/cohort-topic/membership-source.ts, docs/cohort-topic.md
difficulty: easy
repro: verified
----

# The membership verifier accepts a certificate for another coordinate

## The defect

`CachingMembershipVerifier.verifyMessage` (`packages/db-core/src/cohort-topic/membership/verifier.ts`) asks its membership source for the certificate of `expectedCoord`, then hands the bytes to `loadFrom`. `loadFrom` decodes the certificate and keys everything on the certificate's **own** `cohortCoord` field — the trust gate (`certIsTrusted` → `fallbackTrust`, `chainGrantsTrust`, `staleGapRecovery` all look up `heldUnder(cert.cohortCoord, …)`), the direct anchor (`anchor.directAnchor(cert, …)` judges the binding the cert claims), and the cache write (`byCoord.set(cert.cohortCoord, …)`). Nothing compares `cert.cohortCoord` with `expectedCoord`. The returned cert is then used to verify the message at `expectedCoord`.

Consequence: a self-consistent certificate for some unrelated coordinate X (an attacker's 14 keys signing their own member list) passes the gate as "unknown → trust on first use" for X, and the message signed by those keys verifies as coming from Y — even when the direct anchor would have rejected a forgery for Y, and even when Y is trust-locked. Anyone answering the membership fetch first can do it (`FretMembershipSource.fetch` in `packages/db-p2p/src/cohort-topic/membership-source.ts` takes the first reply from any of the coordinate's cohort peers). It also pollutes the verifier's cache entry for X.

Reproduced during fix with a throwaway spec: direct anchor returning `"rejected"` for coordinate Y and `"unknown"` otherwise, a source whose `fetch` returns a 14-member cert for X signed by all 14, and `verifyMessage(those14, Y, 2, payload, sig)` returned `"verified"`. Expected `"untrusted"`.

## The fix

### Verifier (the security fix)

`loadFrom` takes the expected coordinate key (`bytesToB64url(expectedCoord)`, already computed as `coordKey` in `verifyMessage`) and, immediately after decoding, treats a cert whose `cohortCoord !== coordKey` exactly like an absent cert: return `undefined`, before the trust gate runs, before anything is cached. That one check covers both loads (`source.current` and `source.fetch`) and both threshold rules, because both go through `loadFrom`. Since the mismatched cert reads as absent, a mismatch on the `current` load still falls through to the single refetch, and a mismatch on the refetch yields `"untrusted"` — the ticket's expected behavior with no new branches.

Strict string comparison is correct: `bytesToB64url` is canonical, and a cert spelling the same bytes non-canonically is refused, which is the safe direction.

`cache(cert, placement)` (self-published certs) is untouched — a node's own publish names its own coordinate by construction.

### Membership source (the liveness and `has` half)

`FretMembershipSource.fetch` caches and returns the first non-empty reply without decoding it. Decide: **yes, check it there too.** Decode the reply (`decodeMembershipCertV1` and `bytesToB64url` are both exported from `@optimystic/db-core`) and accept it only when its `cohortCoord` equals `bytesToB64url(coord)`; a reply that fails to decode or names another coordinate is skipped, and the loop **tries the next holder** rather than returning. Reasons:

- Liveness. Today a wrong-coordinate reply ends the fetch; the verifier would then (after its fix) discard it and report `untrusted` even though the next holder may hold the right cert. This matters now, not hypothetically: the sibling ticket `the-membership-protocol-serves-one-certificate-for-every-cohort-a-node-is-in` shows honest nodes in two cohorts answer with the wrong cohort's cert. Skipping to the next holder makes a genuine message verifiable while that ticket is open.
- The `has` existence check (`FretMembershipSource.has`, used by the parent-reference bootstrap-evidence existence view) reads the same cache, so an unchecked reply can make a coordinate look populated. After this change only a reply naming the coordinate is cached under it.

Do not verify signatures in the source — that is the verifier's job, and `has` is an existence hint, not a trust decision. Leave a `NOTE:` at `has` saying a cached cert under a coordinate is only checked to *name* that coordinate, not to be trusted.

Decode failures in `fetch` should be logged (house rule: no silent swallowing) at debug level, consistent with how the existing catch in that loop treats an unreachable holder; check what logger the file/package uses (`debug`-based `optimystic:…` namespaces) before adding one. `CohortWireError` is the decode error type; rethrow anything else.

`FretMembershipSource.cache(coord, encoded)` — the host-fed path — is out of scope here; the sibling ticket owns the host handler that caches under the wrong coordinate.

### Docs

In `docs/cohort-topic.md` §Bootstrapping trust, near "Why self-consistency is not enough", add one or two sentences: a fetched certificate is considered only if its `cohortCoord` is the coordinate being verified; a certificate for any other coordinate is treated as no certificate (not trusted, not cached), because otherwise the anchor and the trust lock would be consulted for the wrong coordinate. Mention the source skips such replies and asks the next holder. Cite `CachingMembershipVerifier.loadFrom` / `FretMembershipSource.fetch` per the citation rules in AGENTS.md (symbol + path).

## Tests

One reproduction test in `packages/db-core/test/cohort-topic/membership.spec.ts`, in the `membership trust anchoring` describe (its helpers build anchors and signed certs): direct anchor `"rejected"` for Y, `"unknown"` otherwise; source `fetch` (and/or `current`) returns a self-consistent cert for X; `verifyMessage(signersOfX, Y, …)` must be `"untrusted"`. It fails at HEAD. Optionally assert in the same test that the wrong-coordinate cert was not cached for X (e.g. a subsequent call for X with a source returning nothing does not verify from cache) — only if it fits in a line or two; don't add a separate test.

No new test for the source change unless an existing `membership-source` spec makes it a few lines (check `packages/db-p2p/test` for one); its behavior is glue over the decode.

## TODO

- Add the reproduction test to `membership.spec.ts`; confirm it fails before the fix.
- `verifier.ts`: pass `coordKey` into `loadFrom`; return `undefined` when the decoded `cert.cohortCoord !== coordKey`, before `certIsTrusted`. Update the `loadFrom` doc comment and the module header's step list (step 2/3) to say the cert must name the expected coord.
- `membership-source.ts`: in `fetch`, decode each reply, skip (with a debug log) replies that fail to decode or name another coordinate, continue to the next holder; cache/return only a matching reply. Add the `NOTE:` at `has`.
- `docs/cohort-topic.md` §Bootstrapping trust: add the coordinate-binding sentence(s).
- `yarn build` (db-core then db-p2p), then `yarn test` in `packages/db-core` and `packages/db-p2p`; `yarn lint:docs` from root.
