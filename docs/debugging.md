# Debug Logging

Optimystic uses the [debug](https://www.npmjs.com/package/debug) library for instrumentation.
Logging is controlled via the `DEBUG` environment variable.

## Namespaces

| Package                      | Base namespace                 |
|------------------------------|--------------------------------|
| `db-core`                    | `optimystic:db-core`           |
| `db-p2p`                     | `optimystic:db-p2p`            |
| `quereus-plugin-optimystic`  | `optimystic:quereus-plugin`    |

### db-core sub-namespaces

| Sub-namespace         | What it covers                                    |
|-----------------------|---------------------------------------------------|
| `network-transactor`  | Batch creation sizes, retries, stale/missing, cancel triggers |
| `batch-coordinator`   | Batch creation, retry paths, excluded peers       |
| `cache`               | Block cache hit/miss                              |
| `collection`          | `collection:invented` — `createOrOpen` found no committed header and staged a fresh empty collection |

### cohort-topic sub-namespaces

The cohort-topic substrate logs under `optimystic:cohort-topic:*`. Each phase of the
walk → willingness → promotion → handoff lifecycle, plus the anti-flood / anti-DoS defenses, has
its own sub-namespace so a single concern can be traced in isolation:

| Sub-namespace                     | What it covers                                                        |
|-----------------------------------|-----------------------------------------------------------------------|
| `cohort-topic:walk`               | Walk-toward-root probes: per-hop tier, `no_state`/`promoted` redirects, retries |
| `cohort-topic:promote`            | Promotion / demotion lifecycle: cap/slope triggers, sticky window, notices |
| `cohort-topic:willingness`        | Per-member willingness decisions: quorum, load shed, budget gate, back-off |
| `cohort-topic:handoff`            | Membership rotation primary handoff: inventory → pull → dual-serve → ack |
| `cohort-topic:antiflood`          | Re-registration jitter: wave staggering and the `cap_promote / T_rejoin_jitter` bound |
| `cohort-topic:antidos`            | Rate-limit / topic-budget / replay-guard / bootstrap-evidence rejections |
| `cohort-topic:coldstart`          | Cold-start admission gate: parent-registration forwarder failures     |

### db-p2p sub-namespaces

| Sub-namespace              | What it covers                                         |
|----------------------------|--------------------------------------------------------|
| `protocol-client`          | Dial start/ok/fail, first-byte timing, response timing |
| `storage-repo`             | Pend/commit/cancel entry with ids and revs             |
| `block-storage`            | Block-level pend/commit/cancel                         |
| `repo-service`             | Redirect decisions (inCluster vs redirect)             |
| `cluster`                  | ClusterCoordinator phase transitions, majority calc    |
| `cluster-member`           | ClusterMember promise/commit counts, phase transitions |
| `coordinator-repo`         | CoordinatorRepo operations (peer-id suffixed)          |
| `storage:restoration`      | Block restoration coordination                         |
| `libp2p-key-network`       | Key network operations (peer-id suffixed)              |
| `peer-address-book`        | Peer multiaddrs learned or rejected: `merge`, `capped`, `record-capped` (peer-id suffixed) |

Address learning is reported from two places: the inbound path (a cluster record arriving from a
coordinator) logs under `peer-address-book`, while the outbound path
(`Libp2pKeyPeerNetwork.recordPeerAddresses`, reached from the cluster/repo clients) logs the same
`peer-address-book:merge` tag under `libp2p-key-network`. Enable `optimystic:db-p2p:*`, or both
sub-namespaces, to see the whole picture.

### Telling nodes apart in one process

Integration tests run several nodes in a single process, so their log lines interleave. The
sub-namespaces marked *peer-id suffixed* above append the owning node's peer id (first 12
characters) to their namespace:

```
optimystic:db-p2p:coordinator-repo:12D3KooWAbCd
```

Because `debug` namespaces are hierarchical, a wildcard filter you already use
(`optimystic:db-p2p:*`) keeps matching. To isolate one node:

```bash
# One node's cluster-repair decisions
DEBUG='optimystic:db-p2p:coordinator-repo:12D3KooWAbCd' node app.js

# Every node's, as before
DEBUG='optimystic:db-p2p:coordinator-repo*' node app.js
```

An exact-match filter without a trailing `*` no longer matches these sub-namespaces — add the
`*` (this is why `test/support/capture-log.ts` enables both the bare and the suffixed form).

Only these three sub-namespaces carry a peer id today; the rest are flat. If a diagnosis needs
per-node attribution from another subsystem, pass its peer id as `createLogger`'s second argument
— the mechanism is already in place.

### quereus-plugin sub-namespaces

| Sub-namespace         | What it covers                                                       |
|-----------------------|---------------------------------------------------------------------|
| `plugin`              | Plugin registration (config dump when `debug` option set)           |
| `module`              | Virtual table change-subscription lifecycle: subscribe/notify/teardown; `index:tree-open` and `index:seek` (below) |
| `collection-factory`  | Collection watch no-op notices and libp2p node shutdown             |
| `txn-bridge`          | `commit:collections` (below) — which collections each commit carries |

#### Which collections did a write carry?

A table with a secondary index is stored as **two or more separate collections**: the main table
tree at the table's `collectionUri`, and one index tree at `<collectionUri>/index/<indexName>` per
maintained index. A single `insert` must stage into all of them and commit all of them. Two lines
make that answerable from a log; enable both (`DEBUG='optimystic:quereus-plugin:*'`, or
`DEBUG='optimystic:quereus-plugin:txn-bridge,optimystic:quereus-plugin:module'` if that is noisy):

```
optimystic:quereus-plugin:txn-bridge commit:collections mode=legacy count=2 default/Usage=staged default/Usage/index/by_token=staged revs=default/Usage:7,default/Usage/index/by_token:3
optimystic:quereus-plugin:module index:tree-open table=Usage index=by_token uri=tree://default/Usage/index/by_token collection=default/Usage/index/by_token
```

Reading `commit:collections` — one line per commit, emitted **before** the flush:

- `mode=legacy` is the direct per-tree sync sweep (no coordinator wired). Its set is the **dirty
  set**: a tree lands there only once DML staged into it, so an index collection *absent from the
  line* means the index was never staged into.
- `mode=session` is the distributed-consensus path. Its set is the **whole live collection
  registry**, because the coordinator commits by iterating its own collection map — so an index
  collection being *listed* does not by itself mean this write touched it; `=staged` is what says
  that.
- Each id carries `=staged` (unflushed changes pending at commit time) / `=clean` / `=unknown`.
- A trailing `revs=<id>:<revision>,...` field names the committed revision each collection is
  reading and writing at, in the same sorted order as the ids. `:none` means the collection is
  **invented**: nothing was ever committed under that id and this process staged a fresh empty one,
  so it has no committed revision at all. `:unknown` appears only for a test double that does not
  implement the accessor. The revision is the discriminator the id cannot be — see the note below
  on ids being block ids.
- The revisions are a **separate trailing field on purpose**, not folded into the id tokens: the
  `<id>=staged|clean|unknown` tokens are unchanged from before revisions existed, so an existing
  grep or parser keyed on a collection id keeps matching. Each `revs=` pair splits on its LAST `:`
  (ids may contain colons; revisions never do).
- `count=` is emitted **before** the id list, so a truncated line still reports how many
  collections there were; if `count=` and the number of ids disagree, the line was truncated.
- Ids are sorted, so two nodes' lines compare directly by eye. `count=0` is normal — a commit whose
  bridge had no dirty trees.

Reading `index:tree-open` — one line per index tree opened (bring-up, not per write). It prints
both the derived URI and the collection id it resolved to, because they differ (the `tree://`
scheme is stripped to form the id) and `commit:collections` prints ids. Two nodes resolving
**different** `collection=` values for one logical index would produce a symmetric "each node's
index holds only its own rows" symptom while leaving the main table fine — a failure shape the pair
of lines separates from "the index collection was absent from the commit".

**The collection id in these lines IS the collection's header block id.** `CollectionId` is a
`BlockId` (`packages/db-core/src/collection/struct.ts`), and `Collection.probeHeader` reads the
header with `source.tryGet(id)` — the collection id used directly as a block id. So two nodes
naming the same id are addressing the same header block; identity cannot fork, and there is
nothing to gain by printing a block id separately (do not go looking for one — a collection id is
simply its URI with `tree://` stripped). What CAN differ between two nodes is the revision each is
reading that header at.

#### Which revision did a read descend?

`commit:collections` answers the write side. `index:seek`
(`optimystic:quereus-plugin:module`) answers the read side — one line per index-driven scan:

```
optimystic:quereus-plugin:module index:seek table=Usage index=by_token collection=default/Usage/index/by_token main=default/Usage arm=committed rev=3 main_rev=7 seek=%01tok-a%00 matched=0
```

- `arm=committed` — a pre-transaction snapshot read, which deliberately never refreshes from the
  network. `arm=live` — the scan ran `update()` on both trees immediately before descending.
- `rev=` — the index collection's committed revision; `none` if that collection is invented.
- `main_rev=` — the main table collection's revision at the same instant. A table's main tree and
  its index trees are separate collections refreshed through different call sites, and a
  collection's revision advances only when something calls `update()`/`sync()` on it — so the two
  trees can be sitting at different moments, which is the failure this line exists to expose.

  **Do not subtract `rev=` from `main_rev=`.** Every collection has its own independent revision
  counter, so the two numbers are not on one scale and are routinely unequal on a perfectly healthy
  run (`rev=4 main_rev=3` is normal). A revision is only comparable to another revision **of the
  same collection** — this node's `rev=` against the writer's `commit:collections` revision for
  that same collection id, or against the other node's `index:seek` `rev=`.
- `collection=` / `main=` — the index collection's id and the main table collection's id. One
  line therefore names both collections the scan read, and joins to `commit:collections` and
  `index:tree-open`, which print the same ids.
- `seek=` — the framed index key the descent bracketed on, percent-escaped (the framing carries
  control bytes, so a raw key would break whitespace-separated parsing). Two nodes seeking the same
  SQL value must print the same `seek=`; a difference means the key framing diverged rather than
  the tree. An empty `seek=` is the whole-index prefix (a plan that wants every entry);
  `seek=unset` means the scan returned before framing a key at all. **Compare it, do not decode
  it** — un-escaping yields the raw tuple framing (element tags, escaped NULs), not the SQL value
  that was sought.
- `matched=` — how many **index entries** the seek produced, counted before the row fetch. Rows
  dropped later (missing row, predicate re-applied by the engine) still count here. It is a
  **floor**: a scan the caller abandons early (a satisfied `LIMIT`, an error mid-scan) reports what
  it had produced when it stopped, so `matched=0` still means the descent found nothing.

**Only an index-driven plan emits this line.** A primary-key point lookup, a primary-key range
query, and a full table scan all read without descending an index tree, so they emit nothing here.
No `index:seek` line for a failing query therefore means *the planner did not route it through the
index* — check the plan before concluding anything about the index collection. (Confirming the same
query is index-routed on both nodes is itself worth doing: a query that seeks on one node and
full-scans on the other explains an asymmetric result on its own.)

When a row is written on node A and an index-driven lookup on node B cannot find it, read node B's
`index:seek` line against node A's `commit:collections` revision for the same collection id:

| Node B's index collection at the failing read | Reading |
| --- | --- |
| `rev=none` | Node B invented its own empty index collection and never adopted the committed one. |
| `rev` lower than node A's commit revision | A refresh gap — the collection is real but stale; nothing called `update()` on it before the read. |
| `rev` equal to node A's commit revision, `matched=0` | The write's index action did not survive commit despite being staged. Look at the sync/merge and conflict replay, not at refresh. |
| `rev` equal, `matched>0`, but the SQL still returned no row | The index held the entry and the main-table fetch dropped it — compare `main_rev=` against node A's revision for the **table** collection (same collection on both sides), never against `rev=`. |
| `seek=` differs between the two nodes for the same SQL value | Neither of the above: the two nodes framed different keys, so the seek never addressed the entry that was written. |

`none` on its own is not proof of the invention race — a collection that has legitimately never
been committed yet also reports `none`, and a first insert normally shows the main table collection
at `:none` in the very `commit:collections` line that creates it. `none` is a finding only when
something has already been committed under that id, which is exactly the case the table above
scopes to (node A committed first).

For `arm=committed` over a tree that was staged into the in-flight transaction, the view is pinned
to the transaction's first-touch boundary, which can be older than the `rev=` printed here (the
collection's current revision); for a clean tree the two are the same moment.

All three lines — `commit:collections`, `index:tree-open`, `index:seek` — are pinned by tests
(`test/trace-helpers.ts` captures and parses them; the legacy commit case and the index seek live
in `test/two-node-secondary-index-convergence.spec.ts`, the session commit case in
`test/session-mode-commit.spec.ts`), so a change that stops emitting one of them fails the suite.

## Common DEBUG patterns

```bash
# Everything
DEBUG='optimystic:*' node app.js

# All db-core logging
DEBUG='optimystic:db-core:*' node app.js

# All db-p2p logging
DEBUG='optimystic:db-p2p:*' node app.js

# Network transactor + protocol client (trace a request end-to-end)
DEBUG='optimystic:db-core:network-transactor,optimystic:db-p2p:protocol-client' node app.js

# Cache diagnostics
DEBUG='optimystic:db-core:cache' node app.js

# Cluster consensus (coordinator + member)
DEBUG='optimystic:db-p2p:cluster,optimystic:db-p2p:cluster-member' node app.js

# Storage layer (repo + block storage)
DEBUG='optimystic:db-p2p:storage-repo,optimystic:db-p2p:block-storage' node app.js

# Batch coordinator retry paths
DEBUG='optimystic:db-core:batch-coordinator' node app.js

# Routing and redirect decisions
DEBUG='optimystic:db-p2p:repo-service' node app.js

# Which collections a SQL write actually carried (main table + index trees)
DEBUG='optimystic:quereus-plugin:txn-bridge,optimystic:quereus-plugin:module' node app.js

# All cohort-topic substrate logging (walk, promote, willingness, handoff, anti-flood, anti-DoS)
DEBUG='optimystic:db-core:cohort-topic:*' node app.js

# Trace a registration walk plus the anti-DoS rejections it triggers
DEBUG='optimystic:db-core:cohort-topic:walk,optimystic:db-core:cohort-topic:antidos' node app.js

# Full transaction lifecycle
DEBUG='optimystic:db-core:network-transactor,optimystic:db-p2p:storage-repo,optimystic:db-p2p:block-storage,optimystic:db-p2p:cluster,optimystic:db-p2p:cluster-member' node app.js
```

## Adding new loggers

Each package has a `createLogger(subNamespace)` helper (in `db-p2p` it takes an optional second
argument, the owning node's peer id — see *Telling nodes apart in one process* above):

```typescript
// In db-core
import { createLogger } from "../logger.js";
const log = createLogger('my-module');
log('operation key=%s count=%d', key, count);

// In db-p2p
import { createLogger } from '../logger.js';
const log = createLogger('my-module');
log('operation key=%s count=%d', key, count);

// In db-p2p, when the instance knows which node it belongs to, suffix the
// namespace with its peer id so a multi-node-in-one-process run is attributable
this.log = createLogger('my-module', peerId?.toString());

// In quereus-plugin-optimystic
import { createLogger } from './logger.js';
const log = createLogger('my-module');
log('operation key=%s count=%d', key, count);
```

Use `printf`-style format strings (`%s`, `%d`, `%o`) for structured output.
