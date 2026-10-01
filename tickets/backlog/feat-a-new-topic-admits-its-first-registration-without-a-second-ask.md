description: The first machine to subscribe to a collection's change announcements is always told "not yet, ask again", and the second ask comes about half a minute later, so announcements for a newly watched collection (and after every new log block) only start flowing after that delay; the group could accept the first ask, or say accurately when to come back.
architecture: docs/cohort-topic.md#cold-start-instantiation
files: packages/db-core/src/cohort-topic/willingness.ts, packages/db-core/src/cohort-topic/walk.ts, packages/db-core/src/cohort-topic/member-engine.ts, packages/db-core/src/cohort-topic/antidos/rate-limiter.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/reactivity/collection-watch.ts, docs/cohort-topic.md, docs/reactivity.md
tradeoffs: Nothing is lost while the subscriber waits, because the watch service's periodic check of the collection still wakes it within one interval; this only shortens how long a newly watched collection (or a new log block) relies on that slower check, and any fix touches the admission and anti-abuse rules of the shared subscription layer.
----

# A new topic's first registration should not need a second ask

## What happens today

A machine subscribes to a collection's announcements by registering with the group of machines responsible for the topic of the collection's current log tail block. When nobody has registered under that topic before, the group holds no state for it. `docs/cohort-topic.md` § Cold-start instantiation says such a group starts serving the topic only if a quorum of its members is already known to be willing, and a group that has never talked about the topic has exchanged no willingness yet. So the first registration is declined with "retry later" (`CohortBackoffError`, `retry after 1000ms`), and the members only then begin exchanging willingness on their gossip rounds (every 5 s by default).

The collection watch service (`ReactivityCollectionWatch` in `packages/db-p2p/src/reactivity/collection-watch.ts`) retries a failed registration on its next tick, which is the renewal interval: 30 s on a Core node, 20 s on an Edge node.

Measured on a three-node real-libp2p mesh (`collection watch over real libp2p` in `packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts`, default gossip interval, Core profile): the first registration was declined in every run, and the watch attached 30.1 to 30.3 s after it was opened in the runs timed (one outlier run took about a minute and was not diagnosed).

Until the attach lands the watcher is not asleep: the same tick reads the collection's tail and wakes it on a newer revision. It is just on the slow path.

## Why it matters more than once

The topic is derived from the log's tail block, and the log starts a new tail block every 32 entries. Each new block is a new topic nobody has registered under, so every move to a new block meets the same decline. That part is read from the code, not measured: the move goes through the same registration call. Together with the delay before a subscriber learns the tail moved (backlog `feat-reactivity-rotation-reaches-current-subscribers`), a collection that commits steadily spends a large share of each block on the fallback check rather than on announcements.

## What was tried and why it did not help

Retrying on the delay the group names (1 s, then doubling) was implemented and measured in `network-collection-watch-service`, then removed. Attach got slower, about 60 s instead of 30 s. A registration attempt on a topic with no state sends two frames to the root group (a plain one, answered "no state", then the cold-start one), and the group's anti-abuse limiter allows one peer four register frames per topic per minute (`DEFAULT_REGISTER_RATE_PER_PEER` and `DEFAULT_RATE_WINDOW_MS` in `packages/db-core/src/cohort-topic/antidos/rate-limiter.ts`). Retries at 1 s, 3 s and 7 s were all declined with the same 1 s delay; the attempts at 30 s and after were declined with a climbing delay (2 s, 4 s, 8 s), and the registration landed at 60 s. The climbing delay is what the limiter answers once the allowance is spent; that it was the limiter rather than the willingness check answering was read from the code, not logged.

So the participant cannot fix this by asking sooner. The "retry after" value it is given does not say when the group will be ready, and asking early is penalized.

## What is wanted

A subscriber's first registration under a new topic attaches without waiting a full renewal interval. Either of these would do it, and choosing between them is part of the work:

- the group accepts the cold-start registration that triggered its own start-up, once its members have answered, instead of declining it and relying on a second ask; or
- the decline names a delay that reflects when the group expects to be ready, the ask that follows it is not charged against the limiter as abuse, and the watch service retries at that delay.

Whichever is chosen, the anti-abuse properties of cold start (`docs/cohort-topic.md` § Anti-DoS) must still hold: a peer must not be able to make many groups start up cheaply.

## How to tell it worked

The db-p2p integration case named above attaches in a few seconds rather than about 30, with no change to its assertions.
