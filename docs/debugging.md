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
| `module`              | Virtual table change-subscription lifecycle: subscribe/notify/teardown; `index:tree-open` (below) |
| `collection-factory`  | Collection watch no-op notices and libp2p node shutdown             |
| `txn-bridge`          | `commit:collections` (below) — which collections each commit carries |

#### Which collections did a write carry?

A table with a secondary index is stored as **two or more separate collections**: the main table
tree at the table's `collectionUri`, and one index tree at `<collectionUri>/index/<indexName>` per
maintained index. A single `insert` must stage into all of them and commit all of them. Two lines
make that answerable from a log; enable both (`DEBUG='optimystic:quereus-plugin:*'`, or
`DEBUG='optimystic:quereus-plugin:txn-bridge,optimystic:quereus-plugin:module'` if that is noisy):

```
optimystic:quereus-plugin:txn-bridge commit:collections mode=legacy count=2 default/Usage=staged default/Usage/index/by_token=staged
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

Both lines are pinned by tests (`test/trace-helpers.ts` captures and parses them; the legacy case
lives in `test/two-node-secondary-index-convergence.spec.ts`, the session case in
`test/session-mode-commit.spec.ts`), so a change that stops emitting either one fails the suite.

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
