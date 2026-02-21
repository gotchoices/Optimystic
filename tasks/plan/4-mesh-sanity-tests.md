----
description: Integration test plans for multi-node mesh scenarios
dependencies: libp2p node, cluster logic, responsibilityK
----

Test plans for mesh sanity:
- 3-node mesh, responsibilityK=1: create-diary, add-entry, read-diary; verify redirects then cache
- Scale to responsibilityK=3 (after Member impl): quorum commit, partial failures, and recovery
- DHT offline/slow path: verify fallback to connected-peer routing works and logs are informative
