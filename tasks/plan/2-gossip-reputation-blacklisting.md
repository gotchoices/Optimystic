----
description: Gossip-based reputation and blacklisting system
dependencies: libp2p gossip, peer reputation
----

Implement signed misbehavior reports and local reputation scoring (expiring, thresholded). Gossip summaries/evidence (e.g., invalid validations, equivocation) to neighbors; use as inputs, not hard authority. Coordinator selection and cluster expansion should down-rank blacklisted peers; expose config/persistence. Provide APIs to report bad peers and to query current reputation state.
