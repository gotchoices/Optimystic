# manual-mesh-test.ts annotates getRepo callback with libp2p's PeerId, not db-core's

description: test file imports `PeerId` from `@libp2p/interface`, but `NetworkTransactor.getRepo`'s parameter type is db-core's minimal structural `PeerId` — the libp2p type has extra required fields, breaking contravariant assignment
prereq: none
files:
  - packages/quereus-plugin-optimystic/test/manual-mesh-test.ts
  - packages/db-core/src/network/types.ts
  - packages/db-core/src/transactor/network-transactor.ts
----

## Error

`yarn tsc --noEmit` in `packages/quereus-plugin-optimystic`:

```
test/manual-mesh-test.ts(65,3): TS2322: Type '(peerId: PeerId) => any' is not assignable to type '(peerId: PeerId) => IRepo'.
  Types of parameters 'peerId' and 'peerId' are incompatible.
    Type 'import(".../db-core/dist/src/network/types").PeerId' is not assignable to type 'import(".../db-p2p/node_modules/@libp2p/interface/dist/src/peer-id").PeerId'.
      Type 'PeerId' is missing the following properties from type 'URLPeerId': type, publicKey, toMultihash, toCID
```

## Investigation

The test (manual-mesh-test.ts:18, :61-71):

```ts
import type { PeerId } from '@libp2p/interface';
...
const transactor = new NetworkTransactor({
  ...
  getRepo: (peerId: PeerId) => {                         // <-- L65
    if (peerId.toString() === node.peerId.toString()) {
      return coordinatedRepo;
    }
    return RepoClient.create(peerId, keyNetwork, protocolPrefix);
  }
});
```

`NetworkTransactor` lives in db-core (`packages/db-core/src/transactor/network-transactor.ts:16`):

```ts
type NetworkTransactorInit = {
  ...
  getRepo: (peerId: PeerId) => IRepo;     // PeerId imported from db-core's network/types
};
```

db-core defines its own minimal structural `PeerId` (`packages/db-core/src/network/types.ts:9-13`):

```ts
/** Minimal peer identifier — structurally compatible with libp2p's PeerId. */
export type PeerId = {
  toString(): string;
  equals(other: unknown): boolean;
};
```

This is a deliberate decoupling — db-core does not want a hard dependency on `@libp2p/interface`. Concrete libp2p PeerIds satisfy this structurally (libp2p's PeerId has `toString` and `equals`), so values flow fine in the assignable direction.

## Why the assignment fails

Function parameters are checked **contravariantly**. The callback's parameter type (`libp2p.PeerId`, a discriminated union including `URLPeerId` with required fields `type`, `publicKey`, `toMultihash`, `toCID`) must be a *supertype* of the expected parameter type (db-core's structural `PeerId`).

But db-core's `PeerId` is missing those four members, so a db-core `PeerId` cannot satisfy the callback's parameter contract — the callback is "asking for more" than NetworkTransactor will deliver. This is a real type error, not a compiler quirk.

## Is this a real bug?

Functionally no, because at runtime db-p2p only ever produces full libp2p PeerIds and pipes them through NetworkTransactor unchanged, so the callback always receives a libp2p PeerId in practice. But the declared types do not reflect that — db-core's signature is the source of truth and it promises only the structural minimum.

## Hoisting note (also relevant)

`yarn why @libp2p/interface` (run from the plugin package) shows multiple installed copies due to old transitive ranges (`^1.7.0`, `^2.11.0`, `^3.x.x`). There is no root-level hoist of `@libp2p/interface` in `C:/projects/optimystic/node_modules/@libp2p/`; instead each workspace has its own copy under `<package>/node_modules/@libp2p/interface`. The error message shows the test resolves `@libp2p/interface` via `packages/db-p2p/node_modules/@libp2p/interface` (probably during type resolution from a re-exported symbol), confirming non-deduped installs. All workspace direct deps already pin `^3.1.0`, so this is the older transitives forcing nested installs.

The hoisting smell is real, but it is **not** what causes this specific error. Even if everything resolved to one `@libp2p/interface` copy, the test's annotation type (full libp2p `PeerId` union) would still differ from db-core's structural `PeerId`, and contravariance would still fail.

## Hypothesis

Trivial fix: the test should annotate the callback parameter with db-core's `PeerId` (or omit the annotation and let inference take over). One-line change at manual-mesh-test.ts:18 (and matching usage at :65). No type/runtime change needed in db-core or db-p2p.

```ts
// before:
import type { PeerId } from '@libp2p/interface';
// after:
import type { PeerId } from '@optimystic/db-core';
```

(`PeerId` is already exported from db-core via its `network` barrel — confirm export path before editing.)

The hoisting concern is real but separable; treat it as backlog.

## TODO

- Change the `PeerId` import in `manual-mesh-test.ts:18` to come from `@optimystic/db-core` (verify the public barrel exports it; otherwise import via the network types subpath used elsewhere in the codebase). Keep the annotation at line 65 — just retype it.
- Re-run `yarn tsc --noEmit` in `packages/quereus-plugin-optimystic` and confirm the error is gone.
- (Out of scope here — file a separate `backlog/` ticket if motivated) Investigate whether older transitive `@libp2p/interface` ranges (`^1.7.0`, `^2.11.0`) can be force-resolved or yarn-resolutions'd to dedupe to v3.x for cleaner type resolution and smaller installs.
