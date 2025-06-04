# Optimystic

See the following documentation:

* [Technical Architecture](docs/architecture.md)

## Packages

* ** Database Core ** - packages/db-core - Database core functionality, not specific to any particular storage topology
* ** Database P2P ** - packages/db-p2p - Database integration with libp2p
* ** Test Peer ** - packages/test-peer - CLI for testing peer-to-peer functionality
* ** Vinz ** - packages/vinz - Library for threshold cryptography

## How to use:

### Host a stand-alone node

Stand-alone nodes can be hosted on any platform supporting Node.js.  A node can be configured as either of the following:
  * **Transaction** - limited storage
    * Facilitates data storage and matchmaking operations, such as:
      * Registration
      * Voting
      * Validation
  * **Storage** - server or cloud service - long term storage capable
    * User: press, municipalities, etc.
    * Facilitates:
      * Stability and robustness of storage
      * Archival of election results

Whether transactional or storage, a stand-alone node can optionally serve as a:
  * Public IP/DNS address - incoming connections from mobile apps and NAT traversal
  * Bootstrap - stable entry points for the network

## Contributing

If you would like to help out, the following skills will be most useful:

* Typescript
* Node.js
* React Native
* libp2p

We can always use help with documentation, testing, translation, and other tasks.

Submit pull requests to the [Optimystic repository](https://github.com/gotchoices/optimystic)
