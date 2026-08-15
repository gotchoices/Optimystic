description: Peers reachable only through a relay — the normal situation for phones and machines behind a home router — get silently cut off by any part of the system that forgets one easy-to-miss opt-in flag when opening a connection; one place still forgets it today, and nothing stops the next new connection site from forgetting it too.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-core/src/network/i-peer-network.ts
difficulty: medium
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: The one broken site is a one-line patch, so a maintainer could reasonably fix just that and skip the shared-helper refactor — the refactor touches an interface (`IPeerNetwork`) that other implementations depend on, and pays off only if more connection sites get added later.
----
## Background, in plain terms

A peer behind a NAT (a phone, a laptop on home wifi) usually cannot be dialed directly. It reaches the
network through a *relay* — a third node that forwards traffic. libp2p represents such a connection as
a **limited connection**, and by default it refuses to open a protocol stream over one. The caller must
explicitly opt in by passing `runOnLimitedConnection: true` in the options object.

The flag is per-call-site and easy to omit. Omitting it does not produce a compile error or an obvious
failure — it produces "that peer just never answers", which reads like an unrelated connectivity
problem.

## Why this is filed at the architecture rung, not as a one-line bug

This is the **second** instance of the same class in this repo:

- **Instance 1 (fixed).** `packages/db-p2p/src/cohort-topic/stream-util.ts` — all four dial paths
  omitted the flag, so any cohort member reachable only through a relay had every cohort-topic message
  rejected. Fixed under ticket `cohort-topic-streams-rejected-on-limited-relay-connections`.
- **Instance 2 (still broken, see below).** `packages/db-p2p/src/libp2p-node-base.ts:1041`.

Two instances in the same codebase means the failure mode is the design, not the typo. Filing a third
one-line patch when a third site appears is the outcome worth avoiding.

## Instance 2 — the concrete live defect

`packages/db-p2p/src/libp2p-node-base.ts:1041` constructs the `RestorationCoordinator` with an inline
object literal standing in for `IPeerNetwork`:

```ts
{ connect: (pid, protocol) => node.dialProtocol(pid as Parameters<typeof node.dialProtocol>[0], [protocol]) }
```

Two problems in that one expression:

- **No `runOnLimitedConnection: true`.** Arachnode block restoration therefore cannot pull a block
  from a holder that is only reachable via relay. The restore attempt fails at stream-open and the
  coordinator moves on as though that peer did not have the block — a silent false negative, not a
  visible error.
- **The `options?: AbortOptions` parameter is dropped entirely.** The interface is
  `connect(peerId, protocol, options?): Promise<Stream>`
  (`packages/db-core/src/network/i-peer-network.ts:7`), so any caller passing an `AbortSignal` through
  this path has it silently ignored and cannot cancel the dial.

Contrast with the *other* implementation of the same interface method,
`packages/db-p2p/src/libp2p-key-network.ts:542-553`, which correctly sets `runOnLimitedConnection: true`,
forwards `options?.signal`, and sets `negotiateFully: false`. Two implementations of one interface
method, one of them a lambda written inline at the construction site, is how the divergence happened.

`repro: static` — established by reading the code and comparing the two implementations of the same
interface method, not by observing a failed restoration. What would confirm it: stand up a relay, a
relay-only peer holding a block, and an arachnode peer that must restore that block, and watch the
restore return empty. `packages/db-p2p/test/util/relay-topology.ts` already has the relay/relay-only-peer
scaffolding for this (`spawnRelayNode`, `spawnTcpServicePeer`, and a relay-only peer helper), used by
the `RUN_LONG_TESTS`-gated specs.

## What "make it unrepresentable" looks like here

The shape of the fix is open — this ticket specifies the requirement, not the design. The requirement:
**a new place in the codebase that opens a libp2p protocol stream should get relay support by default,
without its author having to know this flag exists.** Directions worth weighing:

- A single exported dial-options constant/builder in `db-p2p` that every dial site spreads, so the
  default is correct and any deviation is a visible override rather than a silent omission.
- Better for instance 2 specifically: delete the inline lambda and have `libp2p-node-base.ts` reuse the
  existing correct `IPeerNetwork` implementation from `libp2p-key-network.ts`, rather than re-deriving
  one at the construction site. That removes the divergence instead of documenting it.
- A test that enumerates dial sites, or a lint rule, is the weakest option — it catches the omission
  but still lets it be written.

## Scope

- Fix instance 2 (both the missing flag and the dropped `AbortOptions`).
- Land whichever "cannot forget it" mechanism the implementer judges best, and apply it to the existing
  sites (`stream-util.ts`, `libp2p-key-network.ts`, `libp2p-node-base.ts`).
- Test coverage should be at the class level per the ladder — one test that holds for *every* dial site
  beats three per-site assertions. `packages/db-p2p/test/cohort-topic/stream-util.spec.ts` is the
  existing per-site pattern to generalize from.
