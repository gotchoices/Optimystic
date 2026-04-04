# ClusterRepo setInterval Cleanup

description: ClusterRepo uses setInterval for queueExpiredTransactions and processCleanupQueue without a cleanup/dispose method, creating a potential resource leak
dependencies: none
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts
----

`ClusterRepo` sets up two intervals on construction (lines 77-80): `queueExpiredTransactions()` every 60s and `processCleanupQueue()` every 1s. There is no `dispose()` or `destroy()` method to clear these intervals. If a `ClusterRepo` instance is abandoned without cleanup, the intervals continue to fire, holding the instance and its resources in memory.

The fix is to store interval handles and expose a `dispose()` method that calls `clearInterval()` for both.
