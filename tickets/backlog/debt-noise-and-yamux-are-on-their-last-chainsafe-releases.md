description: The two libp2p building blocks that encrypt every connection and split it into streams are installed from packages their original publisher has stopped releasing; the libp2p project now publishes them under new names. Decide when to move, so connection encryption keeps receiving fixes.
architecture: packages/db-p2p/readme.md
files:
  - packages/db-p2p/package.json (`@chainsafe/libp2p-noise`, `@chainsafe/libp2p-yamux`)
  - packages/db-p2p/src/libp2p-node-base.ts (the `noise` and `yamux` imports; `NodeOptions.noiseCrypto`)
  - packages/db-p2p/src/noise-crypto.ts (`NoiseCryptoInterface`, `noisePureJsCrypto` re-exports)
  - packages/quereus-plugin-optimystic/package.json (`@chainsafe/libp2p-yamux`; an unused `@libp2p/noise` ^1.0.1 entry under `dependencies`)
  - packages/db-p2p/test (seven specs and `test/util/relay-topology.ts` import the chainsafe packages)
  - scripts/shared-majors.cjs ("WHAT IS DELIBERATELY NOT HERE")
tradeoffs: The chainsafe releases work today on libp2p 3.3 and nothing is known to be wrong with them, so this is a move made for future fixes rather than a present defect; and it touches the React Native crypto hook that Sereus depends on, which is the riskiest part of the node to change without a device run.
----
# Noise and yamux now ship from the libp2p organisation

## What is true today

`@optimystic/db-p2p` builds every node with `noise` from `@chainsafe/libp2p-noise` (the connection encrypter) and `yamux` from `@chainsafe/libp2p-yamux` (the stream multiplexer). The newest releases of those packages are 17.0.0 and 8.0.1. Both declare `uint8arraylist` ^2.4.8 and `@libp2p/interface` ^3.0.0.

The same code now continues in the libp2p project's own repository (`libp2p/js-libp2p`) as `@libp2p/noise` (17.0.3 at the time of writing) and `@libp2p/yamux` (8.0.3). Those releases declare `@libp2p/interface` ^3.3.0 and `uint8arraylist` ^3.0.2, the same line as libp2p 3.3.11, which this repository moved to under ticket `a-relayed-dial-is-cut-off-by-libp2ps-per-address-timeout`. Checked with `npm view` on the four packages; the API of the new packages was not compared.

## Why it matters

- Fixes to connection encryption and multiplexing will land in the `@libp2p/*` packages. A node here does not get them.
- The chainsafe packages are the last users of `uint8arraylist` 2 in the dependency tree apart from `p2p-fret` (blocked ticket `fret-checkout-cannot-be-linked-on-the-libp2p-3-3-line`). Once both move, `uint8arraylist` has one major and can join the guarded list in `scripts/shared-majors.cjs`.
- `@chainsafe/libp2p-noise` 17.0.0 also depends on `protons-runtime` ^5.6.0, so a second, older copy of that runtime is installed beneath it.

## What a move has to preserve

- `NodeOptions.noiseCrypto` and the two re-exports in `packages/db-p2p/src/noise-crypto.ts`. An application supplies native crypto through them (`packages/db-p2p/readme.md`, the React Native section). The new package must export the same `ICryptoInterface` shape and `pureJsCrypto`, or the re-exports must bridge the difference.
- The React Native default. The readme states that Metro honours the chainsafe package's `browser` field, which maps Noise's default crypto to pure JavaScript. The new package's export map has to be read to see what Metro picks up, and `yarn check:rn` only proves it bundles, not what it runs.
- The wire protocol. A node on the new packages must still complete a handshake with a node on the old ones; `test/foreign-peer-interop.integration.spec.ts` is the place to pin that with one side on each.

The unused `@libp2p/noise` ^1.0.1 entry in `quereus-plugin-optimystic` should go at the same time, whichever way this is decided. Nothing imports it, but it sits under `dependencies`, not `devDependencies`, so every application that installs the plugin also installs `@libp2p/noise` 1.0.1 and the `uint8arraylist` 2 it declares.
