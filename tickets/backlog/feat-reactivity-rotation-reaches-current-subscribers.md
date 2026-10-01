description: When a collection's log starts a new block, machines watching it over the network keep listening to the old block's announcement channel and only notice the move on their next periodic check, up to about half a minute later; the machine that observes the move could tell them directly.
files: packages/db-p2p/src/reactivity/forwarder-host.ts, packages/db-p2p/src/reactivity/origination-manager.ts, packages/db-p2p/src/libp2p-node-base.ts, docs/reactivity.md
tradeoffs: The watch service's periodic tail check already moves every subscriber within one renewal interval (about 30 s) and its first wake on the new block carries no lost correctness, so this only shortens the delay on one notification per 32 commits, at the cost of sending each new-block announcement to two subscriber sets during the drain window.
----

# Tell old-topic subscribers about a tail rotation directly

A subscriber's topic is derived from the collection's log tail block. When the tail fills, the next commit's announcement goes to the new topic's subscribers only, so subscribers still registered under the old topic hear nothing until the watch service's periodic tail check (`network-collection-watch-service`) notices the new tail and moves them — up to one renewal interval (about 30 s) of delay, once per 32 commits.

The node that originates the first new-tail announcement already knows the rotation happened: `ReactivityOriginationManager.detectTailRotation` calls `markRotated(oldTopicId, …)` on it, which opens the old topic's drain window (`ReactivityForwarderHost.markRotated`). For the length of that window (`T_drain`, 60 s), that node could also fan each new-tail announcement out — unmodified, without buffering it into the old topic's replay ring — to the old topic's direct subscribers. A subscriber receiving a notification whose `tailId` differs from the one it attached under already detects the rotation (`detectRotation` → `RotationNotice`) and is moved by the rotation scheduler through the watch service's `reRegister` path, with no gap, because revisions are continuous across the rotation. This is the behavior `docs/reactivity.md` § Tail rotation used to claim live nodes had.

Reach is exactly that of the existing drain redirect: it needs a node that originated for both the old and the new tail, i.e. sits in both topics' announcing groups.
