* Implement cross-collection transactions by concatenating transactors
* Have the NetworkTransactor look for intersections between clusters, rather than arbitrary coordinators.
* Resolve case for concurrent collection creation
* Potential enhancement: have the peers at or around the block's CID submit the block, to make the source more anonymous
* Allow local storage of configuration data to be located in backup storage
* Add Atomic() wrappers to btree to avoid corruption on errors
* Encode an expiration into a transaction ID to create an outer limit, or at least pass an expiration around
* Implement peer reputation system to handle malicious nodes
* Add support for collection-level access controls and permissions
* Optimize block materialization caching strategies
* Implement automatic cluster rebalancing based on network topology changes
* Add metrics and monitoring for transaction performance and network health
* Implement data compression for block storage to reduce network overhead
* Add support for custom collection types beyond trees and diaries
* Implement cross-network federation capabilities for multi-cluster deployments
* Fix for collection test: "should handle concurrent modifications"
