# Optimystic

Optimystic is a distributed database system built on peer-to-peer networks. It provides a robust, scalable foundation for applications requiring consistent data storage, distributed transactions, and efficient peer coordination across decentralized networks.

## Features

* **Distributed Database Core** - Transactional database with ACID properties across peer-to-peer networks
* **Block-based Storage** - Versioned data blocks with efficient storage and retrieval
* **Matchmaking System** - Efficient peer discovery and task coordination
* **Archival Storage** - Scalable long-term storage through the Arachnode system
* **Cross-Collection Transactions** - Support for complex operations spanning multiple data collections

See the following documentation:

* [Technical Architecture](docs/architecture.md)
* [Distributed Database System](docs/optimystic.md)
* [Matchmaking](docs/matchmaking.md)
* [Storage Architecture](docs/arachnode.md)
* [Block Repository](docs/repository.md)

## Packages

* **Database Core** - packages/db-core - Database core functionality, not specific to any particular storage topology
* **Database P2P** - packages/db-p2p - Database integration with libp2p
* **Test Peer** - packages/test-peer - CLI for testing peer-to-peer functionality
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

## Contributing

If you would like to help out, the following skills will be most useful:

* TypeScript
* Node.js
* React Native
* libp2p

We can always use help with documentation, testing, translation, and other tasks.

Submit pull requests to the [Optimystic repository](https://github.com/gotchoices/optimystic)
