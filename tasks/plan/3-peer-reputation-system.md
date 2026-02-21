----
description: Implement peer reputation system to handle malicious nodes
dependencies: libp2p networking layer, cluster protocol
----

Implement a peer reputation system to handle malicious nodes. Peers that misbehave (invalid validations, equivocation, protocol violations) should be down-ranked in coordinator selection and cluster operations.
