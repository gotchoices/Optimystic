description: Different parts of our networking stack quietly ended up built against different versions of the same core library, and nothing tells us when that happens — we only found out because one of them turned out to be broken. Add a check that catches the split, and clean up the two places we already know about.
prereq: bug-gossipsub-pubsub-service-cannot-work-on-libp2p-3
files:
  - packages/db-p2p/package.json (pins `@libp2p/interface: ^3.1.0`)
  - packages/quereus-plugin-optimystic/package.json (same pin)
  - packages/substrate-simulator/package.json (same pin)
  - packages/db-core/package.json:53 (`@libp2p/peer-id-factory: ^4.2.4` — the only v1-era holdout)
  - packages/db-core/test/simulation.ts:2 (its one importer, `createEd25519PeerId`)
  - packages/db-p2p/src/libp2p-node-base.ts:536-544 (the `services:` cast whose `NOTE:` this would let us delete)
  - packages/db-p2p/test/node-service-set.spec.ts (nearest home for a tree-shape guard, if a test is the chosen form)
difficulty: medium
tradeoffs: This is prevention with no user-visible symptom today — after the gossipsub removal lands, the remaining version splits are minor-version drift that TypeScript papers over with one documented cast, and a maintainer could reasonably say a lockfile-shape assertion is a brittle test that will fail on unrelated dependency bumps and get muted.
----

# We have no invariant on which libp2p interface version anything resolves to

## What happened, in plain terms

libp2p is split across many small packages, and they all share one package of common type
definitions and base classes: `@libp2p/interface`. For two libp2p components to interoperate, they
have to be built against the *same* version of it. Nothing in this repository checks that they are.

We found this out the expensive way. `@chainsafe/libp2p-gossipsub@14` was built against
`@libp2p/interface` version 2; everything else here is on version 3. Between those two versions the
shape of a network stream changed completely. Gossipsub therefore failed on every message it tried
to send — silently, because it catches and logs its own error. It shipped that way, and an outside
user had to diagnose it for us (GitHub issue #9). Full write-up:
ticket `bug-gossipsub-pubsub-service-cannot-work-on-libp2p-3` (in `tickets/implement/` at time of
writing; it carries the reproductions and the stack trace).

The package manager could not help. Gossipsub lists `@libp2p/interface` as a regular dependency
rather than a peer dependency, so the resolver just installs a second copy alongside ours and
reports success. Version ranges did what they were told; the incompatibility is invisible to them.

## Why this is one ticket and not three

Three separate-looking cleanups all come from that same missing invariant, and doing any one of them
alone leaves the hole open. They are arms of one change:

**Arm 1 — the version pins disagree with each other.** Three workspaces pin
`@libp2p/interface: ^3.1.0` (`db-p2p`, `quereus-plugin-optimystic`, `substrate-simulator`) while two
pin `^3.2.4` (`db-core`, `reference-peer`). Several libp2p packages we depend on — `@libp2p/autonat`,
`@libp2p/dcutr`, `@libp2p/crypto` — require `^3.2.3`, so under `db-p2p` they each get their own
nested 3.2.3 copy beside the hoisted 3.1.0. Enumerated under `packages/db-p2p/node_modules` (after
the gossipsub removal lands, the 2.x rows are gone and these remain):

```
3.1.0   packages/db-p2p/node_modules/@libp2p/interface
3.2.3   .../@libp2p/crypto/node_modules/@libp2p/interface
3.2.3   .../@libp2p/autonat/node_modules/@libp2p/interface
3.2.3   .../@libp2p/dcutr/node_modules/@libp2p/interface
```

That split is exactly what forces the cast at `libp2p-node-base.ts:544`. Its own `NOTE:` invites
removal "if that dedups" — raising the three low pins to `^3.2.4` is the change that should let it
go. Do not delete the cast on faith; raise the pins, reinstall, then try removing it and keep it if
the compiler still objects.

**Arm 2 — one dependency is still on the version-1 line.** `db-core` depends on
`@libp2p/peer-id-factory@^4.2.4`, which pulls `@libp2p/crypto@4.1.9` and through it
`@libp2p/interface@1.7.0`. That package is superseded — the modern equivalent is
`generateKeyPair` from `@libp2p/crypto/keys` plus `peerIdFromPrivateKey` from `@libp2p/peer-id`, both
of which this repo already uses elsewhere. It has exactly one importer,
`packages/db-core/test/simulation.ts:2` (`createEd25519PeerId`), so the swap is small. Until it is
done, any check written for arm 3 fails on day one — which is precisely why this arm belongs here
and not in a follow-up.

**Arm 3 — the guard itself.** Once arms 1 and 2 land, the tree should contain exactly one
`@libp2p/interface` major. Assert it, so the next dependency that drags in a mismatched copy is
caught by CI instead of by a user. Two plausible shapes, and the choice is genuinely open:

- A small script wired into `yarn check` that walks the installed tree (or parses `yarn.lock`) and
  fails when more than one `@libp2p/interface` **major** is resolved. Catches the real failure mode —
  a major split is what breaks interop — while tolerating minor drift, which TypeScript can be made
  to live with.
- Or an assertion inside `packages/db-p2p/test/node-service-set.spec.ts`, which is already the
  "prove the service map is intact" spec and already exists to catch things nobody thought to list.

Whichever is chosen, the failure message must name the offending package and its parent chain — the
useful output here is the `yarn why` answer, not "versions differ".

## What this would and would not have caught

It **would** have caught gossipsub: a 2.x copy against a 3.x host, at install time, before release.

It **would not** catch a package that declares `@libp2p/interface` correctly as a peer dependency
and is still behaviourally wrong. That is a narrower class and not what bit us.

It **would** be noisy in one predictable way: a routine dependency bump that briefly lands a
mismatched transitive copy would fail CI until the tree settles. That is the cost, and it is the
main reason a maintainer might decline this — see `tradeoffs:`.

## Not in scope

Fixing gossipsub is upstream (ChainSafe) and needs an upstream release; there is no published
version to move to. Removing the dead service is the separate ticket named in `prereq:`.
