# Optimystic

Optimystic is a distributed database system built on peer-to-peer networks. It provides a robust, scalable foundation for applications requiring consistent data storage, distributed transactions, and efficient peer coordination across decentralized networks.

## Features

* **Distributed Database Core** - Transactional database with ACID properties across peer-to-peer networks
* **Block-based Storage** - Versioned data blocks with efficient storage and retrieval
* **Block Restoration** - Automatic recovery of missing blocks from cluster peers (Ring Zulu)
* **Matchmaking System** - Efficient peer discovery and task coordination via FRET
* **Archival Storage** - Scalable long-term storage through the Arachnode system
* **Cross-Collection Transactions** - Support for complex operations spanning multiple data collections

See the following documentation:

* [Technical Architecture](docs/architecture.md) — subsystem map and mental model
* [Building on Optimystic](docs/optimystic.md) — application developer's guide
* [Transaction Protocol](docs/transactions.md) — lifecycle, multi-collection, client sync
* [Storage Architecture (Arachnode)](docs/arachnode.md)
* [Block Repository](docs/repository.md)

## Packages

* **Database Core** - packages/db-core - Database core functionality, not specific to any particular storage topology
* **Database P2P** - packages/db-p2p - Database integration with libp2p, including Arachnode ring discovery (also exports `@optimystic/db-p2p/rn` for React Native — see below)
* **Database P2P Storage (Filesystem)** - packages/db-p2p-storage-fs - Node.js filesystem storage backend
* **Database P2P Storage (NativeScript)** - packages/db-p2p-storage-ns - NativeScript storage backend using SQLite
* **Database P2P Storage (React Native)** - packages/db-p2p-storage-rn - React Native storage backend using LevelDB
* **Database P2P Storage (Web)** - packages/db-p2p-storage-web - Browser storage backend using IndexedDB
* **Reference Peer** - packages/reference-peer - CLI for testing peer-to-peer functionality (run via `optimystic-peer`)
* **Quereus Plugin Crypto** - packages/quereus-plugin-crypto - Quereus plugin providing cryptographic functions
* **Quereus Plugin Optimystic** - packages/quereus-plugin-optimystic - Quereus plugin for Optimystic distributed tree collections
* **Demo** - packages/demo - Hello world demo app exercising Tree and Diary collections across the full stack
* **Substrate Simulator** - packages/substrate-simulator - Discrete-event virtual-clock engine for the design simulator (mock-only dev tooling; not shipped to runtime consumers)

## Installation

A fresh clone installs with no other repositories checked out:

```bash
yarn install
```

The two dependencies that used to require sibling checkouts — `@quereus/quereus`
and `p2p-fret` — now resolve to their published npm versions by default. CI and
new contributors need nothing beyond this repo.

### Local co-development against sibling repos (opt-in)

If you are changing `@quereus/quereus` or `p2p-fret` alongside Optimystic, check
those repos out next to this one so the relative paths line up:

```
<parent>/
  optimystic/                 ← this repo
  quereus/packages/quereus    ← @quereus/quereus source
  Fret/packages/fret          ← p2p-fret source
```

Then overlay the local sources with:

```bash
yarn dev:link      # point @quereus/quereus + p2p-fret at the sibling checkouts
yarn dev:unlink    # revert to the published npm versions
```

`dev:link` uses `yarn link`, which writes `portal:` `resolutions` entries into
the tracked root `package.json`. **Do not commit those lines** — they only make
sense on a machine that has the sibling repos. Run `yarn dev:unlink` (and
re-`yarn install`) before committing. If you accidentally staged them, drop the
two `portal:` `resolutions` entries and the regenerated `yarn.lock` before
pushing.

<!-- NOTE: dev:link writes portal: resolutions into the tracked package.json;
     a co-developer must not commit them. If this bites someone, a pre-commit
     guard rejecting a `portal:` resolution is a reasonable future hardening. -->

## How to use:

### Host a stand-alone node

Stand-alone nodes can be hosted on any platform supporting Node.js. A node can be configured as either of the following:

  * **Transaction Node** - limited storage capacity
    * Facilitates data storage and matchmaking operations, such as:
      * Processing distributed transactions
      * Coordinating peer matchmaking
      * Maintaining short-term data caches
  * **Storage Node** - server or cloud service with long-term storage capability
    * Typical users: enterprises, service providers, institutions
    * Facilitates:
      * Long-term data durability and availability
      * Archival of historical data
      * Network stability and robustness

Whether transactional or storage-focused, a stand-alone node can optionally serve as:
  * **Public Gateway** - providing a public IP/DNS address for incoming connections from mobile apps and NAT traversal
  * **Bootstrap Node** - providing stable entry points for new nodes joining the network

## React Native

`@optimystic/db-p2p/rn` provides a Metro/Hermes-safe entrypoint that excludes Node-only
transports (`@libp2p/tcp`).  Callers must supply their own transports:

```typescript
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { createLibp2pNode } from '@optimystic/db-p2p/rn';

const node = await createLibp2pNode({
    networkName: 'mynet',
    bootstrapNodes: ['/dns4/relay.example.com/tcp/443/wss/p2p/12D3...'],
    transports: [webSockets(), circuitRelayTransport()],
});
```

For persistent storage on RN, use `@optimystic/db-p2p-storage-rn` (LevelDB backend via `rn-leveldb`). It shares the same native module as `@quereus/plugin-react-native-leveldb`, so apps embedding both stacks install one binding.

Hermes requires polyfills for several globals (crypto, structuredClone,
Promise.withResolvers, EventTarget, etc.) and Metro module aliases for Node.js
built-ins (os, crypto, stream, buffer).  See [packages/db-p2p README](packages/db-p2p/README.md#react-native)
for the full polyfill checklist and recommended shims.

## Use Cases

Optimystic is suitable for applications requiring:
* **Distributed Ledgers** - Tamper-evident records across multiple parties
* **Content Distribution** - Reliable data replication across geographic regions  
* **Collaborative Applications** - Shared data structures for multiple users
* **Audit Trails** - Immutable logs of system events and changes
* **Decentralized Storage** - Resilient data storage without central points of failure

## Testing

An automated test suite with VS Code debugging is ready for use:

```bash
# Quick test with detailed output
yarn workspace @optimystic/reference-peer build
yarn workspace @optimystic/reference-peer test:quick
```

**📖 See [START-HERE.md](START-HERE.md) to begin using the automated test loop!**

Additional documentation:
- [TESTING-GUIDE.md](TESTING-GUIDE.md) - Comprehensive testing guide
- [QUICK-REFERENCE.md](QUICK-REFERENCE.md) - Command reference
- [packages/reference-peer/test/README.md](packages/reference-peer/test/README.md) - Test-specific docs

## Contributing

If you would like to help out, the following skills will be most useful:

* TypeScript
* Node.js
* React Native
* libp2p

We can always use help with documentation, testing, translation, and other tasks.

Submit pull requests to the [Optimystic repository](https://github.com/gotchoices/optimystic)
