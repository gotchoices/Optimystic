----
description: Replace clusterLogic stub in libp2p-node with actual cluster implementation
dependencies: ClusterCoordinator, ClusterMember, CoordinatorRepo, StorageRepo
----

The `clusterLogic` stub in `libp2p-node` needs to be replaced with the real cluster implementation.

- Coordinator-side: use `ClusterCoordinator` to run 2PC across responsibility peers
- Member-side: implement an `ICluster` member that validates/pends/commits against local `StorageRepo`
- Ensure `CoordinatorRepo` is used for distributed ops and `StorageRepo` only for local execution
