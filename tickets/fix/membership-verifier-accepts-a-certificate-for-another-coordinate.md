description: When a machine checks a group-signed message, it accepts a membership certificate that describes a different group than the one the message claims to come from, so one dishonest machine can get a forged message accepted.
architecture: docs/cohort-topic.md#bootstrapping-trust
files: packages/db-core/src/cohort-topic/membership/verifier.ts, packages/db-core/test/cohort-topic/membership.spec.ts, packages/db-p2p/src/cohort-topic/membership-source.ts, docs/cohort-topic.md
difficulty: easy
repro: verified
----

# The membership verifier accepts a certificate for another coordinate

## What is wrong

A cohort-topic message that several machines signed together (a promotion or demotion notice, a child link, a reactivity notification) is checked against a **membership certificate**: the signed list of machines that make up the cohort at a ring coordinate. The verifier is told which coordinate the signers should belong to (`expectedCoord`), asks its membership source for that coordinate's certificate, and then checks the message's signers against whatever certificate comes back.

It never checks that the certificate it got back is **for the coordinate it asked about**. `loadFrom` in `packages/db-core/src/cohort-topic/membership/verifier.ts` decodes the certificate, runs the trust checks keyed on the certificate's own `cohortCoord`, caches it under that same field, and returns it; `verifyMessage` then uses it for the message at `expectedCoord`.

So a certificate for some unrelated coordinate X, listing 14 keys the attacker generated and signed by those same keys, is accepted as the membership of coordinate Y:

- The self-consistency check passes (the attacker's keys signed their own list).
- The direct trust anchor is asked about X, not Y. A machine that serves Y would reject a forged certificate *for Y*; asked about an X it does not serve, it answers "unknown".
- The trust lock (a coordinate that already holds a trusted certificate refuses an unanchored replacement) is also looked up under X, so a lock on Y is not consulted.
- "Unknown" with no lock falls to trust-on-first-use, and the certificate is accepted.

The message, signed by the attacker's 14 keys, then verifies as coming from Y's cohort.

## Who can do it

Whoever answers the membership fetch. `FretMembershipSource.fetch` in `packages/db-p2p/src/cohort-topic/membership-source.ts` asks the cohort members around the coordinate in turn and takes the first reply, caching the reply bytes under the requested coordinate without decoding them. One dishonest machine among the peers asked is enough, provided it answers first. The fetch happens when a message does not verify against the certificate already held — which the attacker triggers by sending the forged message.

This goes beyond the documented trust-on-first-use limit (`docs/cohort-topic.md` § Bootstrapping trust), which is about a coordinate the verifying machine cannot anchor and has no certificate for. Here the machine *can* anchor Y, or already holds a trusted certificate for Y, and both protections are sidestepped.

## Reproduction (ran it, saw `verified`)

A throwaway spec against the working tree at the time of filing, not kept:

- A verifier whose direct anchor returns `"rejected"` for any certificate claiming coordinate Y and `"unknown"` otherwise.
- A membership source whose `fetch` returns a certificate with `cohortCoord` = X (≠ Y), 14 made-up members, signed by all 14.
- `verifyMessage(those14, Y, 2, payload, sig)` returned `"verified"`.

Expected: `"untrusted"`.

## Expected behavior

A certificate whose `cohortCoord` is not the coordinate being verified is treated like no certificate at all — not trusted, not cached, and not used for the message — so the single refetch still happens and the result is `"untrusted"` if nothing better arrives. The same holds on both loads (`current` and `fetch`), and under either threshold rule (the default one and the root-placement one).

Worth settling while here: whether `FretMembershipSource` should also refuse to cache reply bytes it has not checked name the coordinate it asked for. Its cache backs `has`, the "does this parent topic exist" check, so an unchecked reply can also make a coordinate look populated.

## Related open tickets

`cohort-topic-trust-anchor-fret-stabilization-proof` and `cohort-topic-trust-anchor-txlog-committed-binding` (both under `tickets/backlog/hardening/`) touch the same file. They close the trust-on-first-use gap for coordinates a machine cannot anchor. This is a different gap — the anchor and the lock exist and are bypassed — and is not covered by either.
