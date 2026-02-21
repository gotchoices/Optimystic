----
description: NetworkTransactor should use cluster intersections rather than arbitrary coordinators
dependencies: NetworkTransactor, cluster topology
----

Have the NetworkTransactor look for intersections between clusters, rather than selecting arbitrary coordinators. This improves transaction efficiency when operations span multiple clusters.
