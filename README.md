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

* [Technical Architecture](docs/architecture.md)
* [Distributed Database System](docs/optimystic.md)
* [FRET DHT System](p2p-fret docs/fret.md)
* [Storage Architecture (Arachnode)](docs/arachnode.md)
* [Ring Zulu Integration](docs/ring-zulu-integration.md)
* [Block Repository](docs/repository.md)

## Packages

* **Database Core** - packages/db-core - Database core functionality, not specific to any particular storage topology
* **Database P2P** - packages/db-p2p - Database integration with libp2p, including Arachnode ring discovery
* **Reference Peer** - packages/reference-peer - CLI for testing peer-to-peer functionality
* **Vinz** - packages/vinz - Library for threshold cryptography

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
