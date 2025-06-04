# Optimystic Technical Architecture

## Overview

Optimystic is a distributed database system built on peer-to-peer networks using Kademlia DHT (Distributed Hash Table). The system provides a robust foundation for distributed applications requiring consistent, scalable data storage and efficient peer coordination.

## Core Components

### Peer-to-Peer Networks

The foundation of Optimystic is a peer-to-peer network based on the Kademlia DHT. A Kademlia DHT is a distributed hash table that allows nodes to find each other and exchange information efficiently across the network.

Each network deployment varies in terms of what specific information is stored and exchanged, but the core protocols remain consistent. The fundamental capabilities of Optimystic networks include:

* **Distributed Database System** - the network cooperatively acts as a database, maintaining collections of data with strong consistency guarantees through distributed transaction logs
* **Peer-to-peer matchmaking** - efficiently find other peers who are interested in performing cooperative tasks, such as forming processing clusters or coordinating distributed operations

## Distributed Database System - Optimystic

The Optimystic system uses a logical transaction log combined with block-based storage to provide a distributed database system. This scheme can be used standalone or coupled with tree or other data structures, supporting both single-collection and cross-collection transactions through a multi-phase process for propagating updates, committing transactions, and checkpointing affected blocks.

For details, see [optimystic](optimystic.md).

## Matchmaking

Optimystic's peer-to-peer network employs a rendezvous-based matchmaking system to efficiently connect peers for various distributed tasks, regardless of network size or task popularity. The core concept involves nodes meeting at localized rendezvous points, with rendezvous keys derived from a combination of local node address information and task-specific hashes. Peers can adjust the specificity of these keys based on their local Kademlia bucket distribution and network conditions, allowing for adaptive control over the search and matchmaking process.

The matchmaking process differs for active matchers and waiting workers. Active matchers generate rendezvous keys, publish their intent, search for matches, and adjust key specificity as needed to find suitable peers quickly. Workers, on the other hand, register their availability with longer Time-To-Live (TTL) values and wait for work assignments, adjusting their specificity to balance the load at rendezvous points. This flexible system can handle various scenarios, from sparse networks with few interested peers to dense networks with many participants, by dynamically adjusting the rendezvous key specificity to optimize peer discovery and work distribution.

For details, see [matchmaking](matchmaking.md).

## Application Integration

Applications built on Optimystic can leverage the distributed database system to store and manage their data structures. Data is organized into collections that can be queried and modified through distributed transactions. The system ensures consistency across the network while providing scalability through its distributed architecture.

Common use cases include:
* **Distributed ledgers** - maintaining tamper-evident records across multiple parties
* **Content distribution** - storing and replicating data across geographic regions
* **Collaborative applications** - enabling multiple users to work on shared data structures
* **Audit trails** - creating immutable logs of system events and changes

## Storage Architecture

### Block Storage
Data is organized into versioned blocks that can be efficiently stored and retrieved across the network. Each block maintains its revision history and can be materialized at any point in time.

### Archival Storage
Long-term storage is managed through **Arachnode**, a scalable storage system that organizes nodes into concentric rings. Each ring represents progressively finer partitions of the keyspace, allowing nodes to adjust their storage responsibility based on capacity and demand.

For details, see [Arachnode](arachnode.md).

## Glossary of Terms

* **Authority** - an entity or organization that has control over specific data collections or operations within the system
* **Block** - a versioned unit of data storage that can contain multiple records with scrambled ordering for privacy
* **Cluster** - a group of peers responsible for maintaining and processing operations on specific blocks based on their proximity in the DHT keyspace
* **Collection** - a logical grouping of related data that can be queried and modified as a unit
* **DHT/Kademlia** - Distributed Hash Table - network protocol used to communicate and coordinate operations on a peer-to-peer basis without central servers
* **Matchmaking** - the process of finding and connecting peers for collaborative tasks
* **Pool** - a forming block that is not yet finalized or committed to the network
* **Rendezvous Point** - a location in the DHT keyspace where peers meet to coordinate activities
* **Transaction** - an atomic operation that can modify one or more collections while maintaining consistency
* **Transform** - a specific change operation applied to a block or collection

## Implementation Notes

* Standard JSON format for all major data structures
* Markdown support for content embeddings and documentation
* Extensible architecture supporting custom collection types and application-specific logic
