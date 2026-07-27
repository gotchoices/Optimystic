description: Every peer in our tests is built by our own code, so if we get a networking convention wrong, all our test peers get it wrong the same way and still talk to each other happily. Add a test peer built by hand, the way an outside project would build one, so mistakes like that fail a test instead of reaching users.
prereq: identify-push-relay-address-propagation
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/identify-protocol-id.spec.ts, packages/db-p2p/test/multi-coordinator-cross-network-write.integration.spec.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/package.json
difficulty: medium
----

# Test debt: no test peer is built by anything other than our own factory

## Background

Optimystic nodes talk over libp2p. Two peers connect only if they agree on the exact **protocol id**
strings for each service, and on the shape of what flows over them. Those strings are built in one
place — `createLibp2pNodeBase` in `libp2p-node-base.ts` — and every node in every test, unit and
integration alike, comes out of that one factory.

## The gap

**A shared mistake is invisible to a homogeneous mesh.** If the factory produces a wrong-but-
self-consistent protocol id, every test peer produces the *same* wrong id, negotiation succeeds
between them, and the whole suite is green. The system only fails against a peer somebody else built.

That is exactly what happened with [gotchoices/Optimystic#6](https://github.com/gotchoices/Optimystic/issues/6):
the identify service was registered at `//optimystic/<net>/id/1.0.0` (a stray double slash) across
several releases. Every test passed, including the whole integration tier. It was found by an outside
consumer whose own peer, built to the documented convention, could not negotiate.

This was measured rather than assumed: reverting `libp2p-node-base.ts` to the pre-fix state and
running the full integration suite produced **23 passing / 2 pending — byte-identical to the fixed
run**. Raising transport fidelity does not help here, because fidelity is not independence. Every one
of those 23 specs uses real sockets, real FRET, and real Ed25519 threshold certificates, and all of
them agreed on the wrong string.

Notably `multi-coordinator-cross-network-write.integration.spec.ts:16` reasons explicitly about
network-scoped identify — its comment names `/optimystic/<network>/id/1.0.0` — and still could not
catch it, because its assertion is that identify **fails** between two different networks. A negative
assertion, satisfied by any namespacing scheme, correct or malformed. Closest miss in the suite and
structurally incapable of catching it.

So the class of bug is: **any convention we get wrong uniformly.** Protocol id spelling today;
tomorrow a version suffix, a payload framing, or a service we quietly stopped registering.

## Relationship to the sibling ticket

`identify-push-relay-address-propagation` (the `prereq:`) hardens assertions *within* our own peers —
whole-set instead of named-member, literals instead of values recomputed from the code under test,
and one integration edge that resolves through the peerStore the way production does. That closes the
misses visible from inside the system.

This ticket adds the perspective never tested from at all: a peer that does not share our source.
The two are complementary, and the ordering matters — the shared test helpers and the
literal-expectation convention land there first, and this fixture builds on them rather than
inventing a parallel set.

## Expected behavior

A hand-built peer, assembled in the test the way an outside project would assemble one, interoperates
with a real node from our factory:

- it completes identify against an Optimystic node, and that node's peer store ends up listing the
  expected protocols for it;
- it dials the repo protocol — the documented client-facing entry point — and gets a well-formed
  response;
- correspondingly, the Optimystic node's view of it settles as a **serving** member. `membershipOf()`
  in `libp2p-key-network.ts:768-772` classifies peers `serves` / `foreign` / `unknown` from their
  advertised protocol list and refuses to route work to anything not confirmed `serves`, so this
  classification flipping correctly is the real user-visible consequence of getting the ids right.

## Design decisions (settled — do not re-litigate)

Three questions were open when this was first filed. Each is settled below with its tradeoff, so the
implementer builds rather than deliberates.

**Where the expected protocol ids live — written out as literals in the test file.** Not imported
from `src/`, not recomputed by calling a builder, and not imported transitively via a constants module
that production also consumes. If any of those creep in, the fixture inherits the exact tautology it
exists to break. *Tradeoff:* a deliberate protocol version bump now requires hand-editing this file,
and the test fails loudly until someone does. That failure is the feature — it is the review
checkpoint that a wire-format change was intentional.

**How much of a peer to build — the minimum that exercises negotiation, and no more.** Real TCP
transport, `noise()`, `yamux()`, a hand-configured `identify()` with its prefix written out, and a
single hand-registered stream handler for the repo protocol. *Tradeoff:* this does not validate
payload semantics beyond one round trip, and it is deliberately not a second implementation of
Optimystic — that would be unmaintainable and is explicitly not wanted. It validates the negotiation
surface, which is where this defect class lives. Anything beyond the minimum must be justified by
naming the specific convention it protects.

**Gating — name it `*.integration.spec.ts` and gate on `OPTIMYSTIC_INTEGRATION=1`,** following the
neighbouring integration specs. The naming is load-bearing: the root `yarn test:integration` script
fans out to each workspace's `test:integration`, whose mocha glob is `test/**/*.integration.spec.ts`.
A file named otherwise is not picked up by `yarn check` and will silently never run. *Tradeoff:* it
stays out of the default `yarn test`, so it gates releases (via `yarn check`) rather than every
commit. Given it spawns real sockets, that is the right tier.

## Edge cases & interactions

- **The prefix asymmetry is a live trap, and this fixture is where it will bite.** `@libp2p/identify`
  prepends its own leading slash and so takes a **bare** prefix (`optimystic/<net>`); every service
  that builds its own id via template literal takes the **slash-prefixed** form (`/optimystic/<net>`).
  The hand-built peer must reproduce both conventions from the *documentation*, not by copying our
  call site. Getting this wrong in the fixture produces a failing test that looks like a production
  bug.
- **Library version skew must not become the variable under test.** If the hand-built peer resolves a
  different `@chainsafe/libp2p-noise` or `@chainsafe/libp2p-yamux` than the factory does, negotiation
  can fail for reasons unrelated to our protocol ids, and the test becomes a false alarm that
  eventually gets muted. Assemble it from the same resolved versions the package already depends on.
- **Assert on error *type*, never a bare timeout.** A regression must report something diagnosable — an
  unsupported-protocol error or `NoValidAddressesError` — not "timed out after 30s", which is
  indistinguishable from a slow machine and trains people to re-run instead of investigate.
- **Both sides need identify registered** for either peer store to populate. The hand-built peer must
  register its own identify handler, not merely dial ours, or the classification assertion fails for
  the wrong reason.
- **`membershipOf()` returns `unknown` until identify completes**, and `unknown` is deliberately never
  selected. The classification assertion must poll to a bounded timeout rather than read once after
  connect — an immediate read races the identify exchange and flakes.
- **Use a distinct `networkName`.** Protocol ids are network-scoped; a name shared with a concurrently
  running spec lets the two cross-talk.
- **Scope creep guard.** The temptation is to keep teaching the fixture more of the protocol until it
  becomes a second client. Resist it. When a future convention needs covering, add one assertion, not
  one more subsystem.

## TODO

- Read the sibling ticket's shared test helper and literal-expectation convention first; build on
  them rather than inventing a parallel set.
- Add the hand-built peer fixture — plain `createLibp2p(...)` in the test, protocol ids as literals,
  minimum service surface per the settled decision above.
- Assert identify completes and the Optimystic node's peer store lists the expected protocols for it.
- Assert a repo-protocol dial from the hand-built peer returns a well-formed response.
- Assert `membershipOf()` on the Optimystic node settles the hand-built peer to `serves`, polled to a
  bounded timeout.
- Name the file `*.integration.spec.ts`, gate on `OPTIMYSTIC_INTEGRATION=1`, then confirm it is
  actually picked up by `yarn test:integration` from the repo root — run it and check it appears in
  the output rather than assuming the glob matched.
- Record the spec's wall-clock in the review handoff so a human can judge whether the integration tier
  is still fast enough to be run willingly.
- Note in the handoff whether the same fixture shape is worth adding for
  `packages/quereus-plugin-optimystic`, which builds nodes through the same factory.
