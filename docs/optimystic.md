# Building on Optimystic

This guide is for developers writing applications on top of Optimystic — choosing a front-end, running a node, opening collections, making mutations, handling conflicts, and picking a deployment target. For the architectural overview see [architecture.md](architecture.md); for the transaction protocol spec see [transactions.md](transactions.md).

## Two Paths In

You can access Optimystic through either a **native TypeScript API** or through **SQL via Quereus**. The same underlying collections back both — a Quereus table is a `Tree` with a schema-aware encoding layer.

| | Native API | SQL via Quereus |
|---|---|---|
| Packages | `@optimystic/db-core` + `@optimystic/db-p2p` | add `@optimystic/quereus-plugin-optimystic` |
| Schema | Application-defined per collection | Declared with `create table ... using optimystic(...)` |
| Mutations | `collection.act(...)`, `tree.replace(...)` | `insert` / `update` / `delete` |
| Reads | `tree.range(...)`, `diary.select()` | `select` with optimized primary-key lookup and range scan |
| Multi-collection atomic | `TransactionSession` + `ActionsEngine` | `begin` / `commit` / `rollback` |
| Good fit when | Custom data structures, per-collection conflict policies, mobile footprint | Table-shaped data, declarative constraints, SQL tooling |

## Running a Node

Every application needs at least one Optimystic peer. Roles are orthogonal — a single node may combine them:

* **Solo / offline.** No bootstrap peers, no listen addresses. Common for mobile first launch, unit tests, and local development.
* **Client-only.** Dials bootstrap peers but does not accept inbound connections.
* **Full peer.** Participates in transaction routing, consensus, and (if configured) storage.
* **Public gateway** or **bootstrap node.** Provides a stable public address for mobile and NAT'd clients.

Minimal setup:

```typescript
import { createLibp2pNode } from '@optimystic/db-p2p';

const node = await createLibp2pNode({
  networkName: 'myapp',
  bootstrapNodes: ['/dns4/relay.example.com/tcp/443/wss/p2p/12D3...'],
  clusterSize: 10,
  arachnode: { enableRingZulu: true },
});
```

A **solo** configuration — zero bootstrap, zero listen — is a valid first-launch shape; `CoordinatorRepo` short-circuits cluster consensus when `clusterSize ≤ 1`:

```typescript
import { webSockets } from '@libp2p/websockets';

const solo = await createLibp2pNode({
  networkName: 'myapp',
  bootstrapNodes: [],
  listenAddrs: [],
  transports: [webSockets()],
  clusterSize: 1,
});
```

The node transitions out of solo mode automatically once FRET discovers peers. For interactive development, the [`reference-peer`](../packages/reference-peer) CLI (`optimystic-peer`) offers REPL, service, and mesh-orchestrator modes.

Browsers and React Native clients cannot dial raw TCP, so a public bootstrap intended for them must listen on a WebSocket. Pass `wsPort` to `createLibp2pNode` (or `--ws-port` on the CLI) to add a `/ws` listen alongside (or instead of, with `disableTcp` / `--no-tcp`) the TCP listener; in production this is typically fronted by a TLS-terminating proxy and reached by clients as `/dns4/<host>/tcp/443/wss/p2p/<id>`. See the reference-peer [Browser Bootstrap recipe](../packages/reference-peer/README.md#browser-bootstrap-websocket--wss) for a full Caddy snippet.

## Native API

### Wire up a transactor

A `NetworkTransactor` is the bridge between collections and the network:

```typescript
import { NetworkTransactor } from '@optimystic/db-core';

const transactor = new NetworkTransactor({
  keyNetwork,    // Peer discovery (e.g. Libp2pKeyPeerNetwork from db-p2p)
  peerNetwork,   // libp2p node
  getRepo,       // Factory returning a local IRepo (StorageRepo for persistence)
});
```

For tests, `TestTransactor` from `@optimystic/db-core/test-transactor.js` runs everything in-process with no network.

### Open a collection

`Tree` gives indexed key/value access with range scans; `Diary` is append-only. Both use `createOrOpen` (or `create`) — the header block is content-addressed from the collection name, so every peer in the network resolves to the same collection.

```typescript
import { Tree, Diary } from '@optimystic/db-core';

const users = await Tree.createOrOpen<string, User>(
  transactor,
  'users',
  user => user.id,
  (a, b) => a.localeCompare(b)
);

const events = await Diary.create<Event>(transactor, 'events');
```

### Apply actions locally

Actions are the unit of intent. Collection methods (`replace`, `append`, `act`) execute them immediately against a local `Tracker` — subsequent reads see the change before anything has been sent over the network.

```typescript
await users.replace([
  ['u1', { id: 'u1', name: 'Alice' }],
  ['u2', { id: 'u2', name: 'Bob' }],
]);

await events.append({ type: 'user_created', userId: 'u1' });
```

### Read

Data-structure APIs work against the combined view (cached blocks + local pending actions):

```typescript
for await (const path of users.range({ from: 'u1', to: 'u9' })) {
  const entry = users.at(path);
  render(entry);
}

for await (const event of events.select()) {
  process(event);
}
```

Reads are captured as `ReadDependency` records (`blockId`, `revision`) and verified at commit — this is what makes concurrent modifications safe without locks.

### Sync

Local changes are not visible to other peers until they sync. `updateAndSync()` drives the PEND → COMMIT loop, reconciles with any transactions that landed in the meantime, and replays local actions on top if needed.

```typescript
await users.updateAndSync();
```

The full sync lifecycle — block mirroring, when to sync, replay on rejection — is documented in [transactions.md](transactions.md#client-synchronization).

### Handle conflicts

When PEND or COMMIT is rejected (stale read, concurrent write), the client re-syncs and replays. By default, conflicting local actions are dropped. To customize, provide `filterConflict` on a custom collection:

```typescript
import { Collection } from '@optimystic/db-core';

const counter = await Collection.createOrOpen(transactor, 'counter', {
  modules: {
    increment: async (action, store) => {
      /* mutate the counter block */
    },
  },
  filterConflict: (local, remote) => {
    // Sum concurrent increments instead of dropping them
    const remoteSum = remote.reduce((n, r) => n + r.data.value, 0);
    return { ...local, data: { ...local.data, value: local.data.value + remoteSum } };
  },
});
```

See [`collections.md`](../packages/db-core/docs/collections.md) for the full `CollectionInitOptions` shape.

## Transactions Across Collections

Single-collection mutations commit via `collection.updateAndSync()`. Atomic changes spanning multiple collections — a row in a main table plus two secondary indexes, or an event log update plus a counter — go through a `TransactionSession`.

The session opens against a `TransactionCoordinator` with a chosen execution engine:

```typescript
import {
  TransactionCoordinator,
  TransactionSession,
  ActionsEngine,
} from '@optimystic/db-core';

const coordinator = new TransactionCoordinator(transactor, collectionsById);
const engine = new ActionsEngine(coordinator);
const session = await TransactionSession.create(coordinator, engine);

// Apply actions through the engine — each batch updates its collection's local snapshot
await session.execute('', actionsForTable);
await session.execute('', actionsForIndex1);
await session.execute('', actionsForIndex2);

// Single atomic commit — GATHER + PEND + COMMIT across all affected collections
await session.commit();
```

Two engines ship today:

- **`ActionsEngine`** — takes JSON actions directly. Used by native callers and tests.
- **`QuereusEngine`** — accepts SQL statements; used by the Quereus plugin.

On commit, the coordinator identifies the log-tail cluster for every collection touched and drives one consensus round across them all. Either every collection advances or none do. Full protocol: [transactions.md](transactions.md).

## SQL via Quereus

Register the plugin against a Quereus database, then declare tables backed by Optimystic:

```typescript
import { Database } from '@quereus/quereus';
import { register } from '@optimystic/quereus-plugin-optimystic';

const db = new Database();
register(db);

await db.exec(`
  create table users (
    id text primary key,
    name text not null,
    email text null
  ) using optimystic('tree://myapp/users', transactor='network', keyNetwork='libp2p');
`);

await db.exec("insert into users values ('u1', 'Alice', 'alice@example.com')");
const rows = await db.all("select * from users where id = 'u1'");
```

Transaction semantics map directly:

```sql
begin;
update users set email = 'alice@work.com' where id = 'u1';
select StampId();  -- stable identifier for this transaction
commit;            -- syncs all touched collections atomically
```

Quereus is a distinct SQL engine — columns default to `not null`, tables are always virtual, temporal and JSON are native types, and there are no triggers. See the [plugin README](../packages/quereus-plugin-optimystic/README.md) and Quereus's [SQL Reference §11](https://github.com/nicktobey/quereus/blob/main/docs/sql.md) for the full contrast with SQLite.

For cryptographic UDFs (`digest`, `sign`, `verify`, `hash_mod`, `random_bytes`), register [`@optimystic/quereus-plugin-crypto`](../packages/quereus-plugin-crypto) alongside.

## Custom Collections

Build on `Collection` when `Tree` and `Diary` don't fit the access pattern. A custom collection defines:

- **Action types** specific to the domain
- **Action handlers** in `modules` that mutate blocks through the provided `BlockStore`
- A **`filterConflict`** policy for concurrent updates
- Optionally, composed data structures (chains, B-trees) via `BlockStore`

Counters, append-only queues with metadata, specialized indexes, and CRDT-style mergers all fit here. See [`collections.md`](../packages/db-core/docs/collections.md) for the API, [`btree.md`](../packages/db-core/docs/btree.md) and [`chains.md`](../packages/db-core/docs/chains.md) for the primitives.

## Deployment Targets

**Server / desktop (Node.js):** use `@optimystic/db-p2p-storage-fs` for disk persistence. A public-reachable node serves as a bootstrap or gateway by listening on a TCP or WebSocket port.

**Mobile (React Native):** use `@optimystic/db-p2p/rn` and `@optimystic/db-p2p-storage-rn`. Hermes needs polyfills (`crypto`, `structuredClone`, `Promise.withResolvers`, `EventTarget`, …) and Metro aliases for Node built-ins (`os`, `crypto`, `stream`, `buffer`); the [db-p2p README](../packages/db-p2p/readme.md#react-native) has the full checklist. First-launch mobile apps typically start in solo mode and attach on first connectivity.

**Browser:** use WebSockets and circuit-relay transports; browsers cannot accept inbound connections and usually reach the network through a public gateway.

**Test harness:** `TestTransactor` runs everything in-process with no network. For multi-node integration tests, the `MeshHarness` under `packages/db-p2p/src/testing` spins up a configurable in-memory mesh.

## Operational Basics

**Debug logging** is controlled via the `DEBUG` environment variable ([debugging.md](debugging.md) has the full namespace list):

```bash
DEBUG='optimystic:*'                            node app.js  # everything
DEBUG='optimystic:db-core:network-transactor'   node app.js  # client-side transactions
DEBUG='optimystic:db-p2p:cluster*'              node app.js  # consensus
```

`OPTIMYSTIC_VERBOSE=1` enables batch and peer tracing. Correlation IDs (`trxId`, `actionId`, `messageHash`) tie log entries to specific transactions.

**Development flow.** Start with a solo node + `TestTransactor`, validate the data-structure choices and action handlers, then swap in `NetworkTransactor` and bootstrap peers. The `reference-peer` CLI and `MeshHarness` help exercise multi-node scenarios before real deployment.

## See Also

* [architecture.md](architecture.md) — subsystem map and mental model
* [transactions.md](transactions.md) — transaction protocol and multi-collection spec
* [repository.md](repository.md) — block repository operations
* [right-is-right.md](right-is-right.md) — dispute escalation and reputation
* [arachnode.md](arachnode.md) — storage ring architecture
* [correctness.md](correctness.md) — formal safety and liveness properties
* [internals.md](internals.md) — invariants, mutation contracts, pitfalls
* [debugging.md](debugging.md) — logging namespaces
* [db-core README](../packages/db-core/README.md) · [db-p2p README](../packages/db-p2p/readme.md) · [quereus-plugin-optimystic README](../packages/quereus-plugin-optimystic/README.md)
