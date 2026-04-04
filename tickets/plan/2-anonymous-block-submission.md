----
description: Have peers at/around a block's CID submit the block for source anonymity
dependencies: block storage, DHT routing
----

Potential enhancement: have peers relay block submissions on behalf of the originator, so the coordinator and cluster can't identify who authored the write.

## Why proximal peers rather than random ones?

Proximal peers (those near the block's ID in the FRET keyspace) already interact with that block as cluster members. Their submitting it is indistinguishable from normal cluster activity, providing **plausible deniability**. A random peer submitting a block for a distant keyspace region has no legitimate reason to be involved — it's visibly acting as a relay, which only adds one hop of indirection without real anonymity. The anonymity set with proximal relays is "any peer that naturally handles this block," which is the strongest cover story the topology can offer.

Counterpoint: the proximal set is small and known (cluster size ~16), so the anonymity pool is bounded. A hybrid approach — relay through a random peer who then hands off to a proximal peer — would widen the pool at the cost of an extra hop and the issues below.

## Vulnerabilities and DoS potential

- **Relay amplification**: An attacker asks many peers to submit the same block, causing redundant cluster work. Needs dedup or relay-request authentication.
- **Spam via relay**: Without authentication of relay requests, any peer can ask another to relay arbitrary data, turning relay nodes into unwitting participants in spam. Relay requests likely need proof-of-work or a signature the relay can verify without learning the originator's identity.
- **Resource exhaustion on proximal peers**: These peers already carry storage and consensus duties. Adding relay load makes them a richer DoS target, especially if an attacker crafts block IDs that hash into a narrow keyspace region.
- **Sybil positioning**: An attacker places nodes near a target block's keyspace to intercept relay traffic — they can inspect, delay, drop, or modify submissions. Mitigated somewhat by FRET's existing Sybil resistance, but relay adds a new attack surface.
- **Timing correlation**: An observer watching network traffic can correlate when the originator sends to the relay and when the relay submits to the coordinator. This is the classic weakness of low-latency anonymity relays; batching or random delays help but add latency.
- **Relay accountability**: If the relay submits an invalid or malicious block, is the relay blamed? Could be used to damage a relay peer's reputation. Needs a scheme where the relay can prove it was acting on behalf of another party without revealing who.
