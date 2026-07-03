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
| `coordinator-repo`         | CoordinatorRepo operations                             |
| `storage:restoration`      | Block restoration coordination                         |
| `libp2p-key-network`       | Key network operations                                 |

### quereus-plugin sub-namespaces

| Sub-namespace         | What it covers                                                       |
|-----------------------|---------------------------------------------------------------------|
| `plugin`              | Plugin registration (config dump when `debug` option set)           |
| `module`              | Virtual table change-subscription lifecycle: subscribe/notify/teardown |
| `collection-factory`  | Collection watch no-op notices and libp2p node shutdown             |

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

# All cohort-topic substrate logging (walk, promote, willingness, handoff, anti-flood, anti-DoS)
DEBUG='optimystic:db-core:cohort-topic:*' node app.js

# Trace a registration walk plus the anti-DoS rejections it triggers
DEBUG='optimystic:db-core:cohort-topic:walk,optimystic:db-core:cohort-topic:antidos' node app.js

# Full transaction lifecycle
DEBUG='optimystic:db-core:network-transactor,optimystic:db-p2p:storage-repo,optimystic:db-p2p:block-storage,optimystic:db-p2p:cluster,optimystic:db-p2p:cluster-member' node app.js
```

## Adding new loggers

Each package has a `createLogger(subNamespace)` helper:

```typescript
// In db-core
import { createLogger } from "../logger.js";
const log = createLogger('my-module');
log('operation key=%s count=%d', key, count);

// In db-p2p
import { createLogger } from '../logger.js';
const log = createLogger('my-module');
log('operation key=%s count=%d', key, count);

// In quereus-plugin-optimystic
import { createLogger } from './logger.js';
const log = createLogger('my-module');
log('operation key=%s count=%d', key, count);
```

Use `printf`-style format strings (`%s`, `%d`, `%o`) for structured output.
