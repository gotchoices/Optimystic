description: The two pieces of code that run a write's agreement treat their record-keeping store as something that might be missing, and carry about ten "if there is no store" branches because of it — but every real machine now always has one, so those branches are unreachable in production and have twice led people to believe the recovery code never runs at all.
architecture: packages/db-p2p/docs/cluster.md
files: packages/db-p2p/src/cluster/cluster-repo.ts (`ClusterMemberComponents.stateStore`, `clusterMember`, and every `this.stateStore` guard), packages/db-p2p/src/repo/cluster-coordinator.ts (the `stateStore` constructor parameter and its guards), packages/db-p2p/src/repo/coordinator-repo.ts (`coordinatorRepo`'s `stateStore` parameter), packages/db-p2p/src/cluster/memory-transaction-state-store.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/cluster-repo.spec.ts, packages/db-p2p/test/cluster-coordinator.spec.ts
difficulty: easy
tradeoffs: It buys no behaviour — every guard it deletes is already a no-op on every machine — so a maintainer may call it churn on the consensus path; and giving a directly-constructed member a default store makes it do the record-keeping it skips today, which is bookkeeping a spec that only wanted a bare member did not ask for.
----

# A cluster member can still be built without the store it always has

## Background, for a reader with no context

Two pieces of code run a write's agreement: the **member**, which approves and applies a write, and the **coordinator**, which collects the approvals. Both keep a record of what is in flight, so that a machine which restarts can pick up where it left off. That record-keeping store has always been declared as optional — the code asks "do I have one?" before every save, every delete, and before the whole recovery pass.

It is no longer optional in practice: `a-node-keeps-its-transaction-state-where-it-keeps-the-rest` made every serving machine build one over the key-value store it already has. The only callers that still pass none are tests and the in-repo mesh harness, which construct a member or coordinator directly.

## Why it is worth closing

The optionality has twice produced wrong beliefs that cost real work:

- A comment on the node factory's key-value resolver asserted that wiring the store "belongs to another ticket", which is how the state went unkept on every machine in the repository for as long as it did.
- `backlog/debt-a-recovered-commit-retry-restarts-its-budget` was filed with the premise "neither arm is reachable; nothing supplies a store", and had to be corrected afterwards.

Both mistakes have the same cause: the type says a store may be absent, so a reader cannot tell from the code whether the recovery path runs on a real machine or never. Deleting the absent case makes that question unaskable.

## The shape that costs nothing

The field can stay optional where callers pass it — that is the test ergonomic worth keeping — while being non-optional *inside* the two classes: `clusterMember` and the coordinator default it to a `MemoryTransactionStateStore` when none is given, and every `if (!this.stateStore)` guard goes. No spec changes, and the harness's restart keeps the semantics its comment describes, because a fresh in-memory store per instance recovers nothing — exactly what it does today.

Count the guards before starting; at the time of filing there were about ten across the member, the coordinator and the recovery passes.

## Expected behaviour afterwards

- A member or coordinator built with no store behaves as one built with an in-memory store: it keeps its in-flight state for the life of the process and recovers nothing on construction.
- No branch anywhere reads "there is no store".
- The mesh harness's `restart` still loses in-flight state and still recovers nothing, and `packages/db-p2p/test/member-leaves-and-returns.spec.ts` still pins the same healing behaviour it pins today.
