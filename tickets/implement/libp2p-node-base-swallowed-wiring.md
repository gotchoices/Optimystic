----
description: The peer-to-peer node startup code silently ignores errors while connecting up its most critical internal services, so if that wiring fails the node keeps running in a half-broken state and the failure only surfaces later as confusing network and consensus misbehavior instead of a clear error.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/cluster/../ (Libp2pFretService in p2p-fret), packages/db-p2p/src/logger.ts
difficulty: medium
----

Origin: review finding eh-4 (docs/review.html, Section 9 "Cross-cutting engineering health"). Canonical home for the swallowed-wiring concern.

## Problem

`createLibp2pNodeBase` in `packages/db-p2p/src/libp2p-node-base.ts` injects the running
libp2p node into several services via `setLibp2p(...)` (and `setReputation(...)`), each wrapped
in an empty `catch { }`. If any injection throws, the error is discarded and the node keeps
running half-wired. The comments in the same file describe these injections as load-bearing —
e.g. the `repo` injection is "Done before start() so the protocol handler is live with a
resolvable node from its first request." A missed injection degrades silently: the service falls
back to the unreliable `components.libp2p` proxy (see `NetworkManagerService.getLibp2p()` at
`packages/db-p2p/src/network/network-manager-service.ts:133-135`, which falls back to
`this.components.libp2p`), and the symptom later surfaces as mysterious routing or consensus
failures with no trace to the real cause.

A second, related defect: `createLibp2p(libp2pOptions as any)` (currently `libp2pOptions` is typed
`unknown` and then cast to `any`) defeats libp2p's config typing at exactly the seam where a
misconfiguration is most costly.

### The swallowed sites (current line numbers, will drift)

Two classes, decided per-injection below:

**In-factory, best-effort (unreliable `components.libp2p` proxy):**
- `~481` networkManager factory: `try { (svc as any).setLibp2p?.(components.libp2p); } catch { }`
- `~494` fret factory: `try { svc.setLibp2p(components.libp2p); } catch { }`

  These run during `createLibp2p` internals, before the real node exists. `components.libp2p` may
  be undefined/unreliable here (that's *why* the post-construction re-injection below exists). They
  are effectively redundant with the post-construction injections, which overwrite `libp2pRef` with
  the real node before `node.start()`. **Recommendation: log-on-failure, non-fatal** — a proxy-time
  failure is not correctness-critical because the real node is injected moments later at `~507-513`.
  (Alternative considered: delete these two in-factory injections entirely as pure redundancy. Left
  as log-on-failure rather than deleted to preserve current behavior for any service that reads
  `libp2pRef` synchronously between construction and post-construction injection — nothing does
  today, but keeping them is the lower-risk change.)

**Post-construction, load-bearing (the REAL node, before `node.start()`):**
- `~507` fret: `try { ((node as any).services?.fret as any)?.setLibp2p?.(node); } catch { }`
- `~508` networkManager: `try { ((node as any).services?.networkManager as any)?.setLibp2p?.(node); } catch { }`
- `~513` repo: `try { ((node as any).services?.repo as any)?.setLibp2p?.(node); } catch { }`

  All three services are **unconditionally present** in the `services` config object, so the
  optional-chaining silent-skip (`?.`) can only hide a genuine wiring bug (renamed/removed service,
  a `setLibp2p` that throws). The node has NOT started yet at these lines (`node.start()` is at
  `~515`), so failing fast leaks nothing started. **Recommendation: fail fast** — typed,
  non-optional calls with no swallowing catch, so any throw rejects node creation. The node without
  a resolvable repo/networkManager/fret is not correct; better a clear rejection at startup than
  silent degradation surfacing later as routing/consensus failures.

**Post-start, load-bearing-ish:**
- `~533` networkManager: `try { ((node as any).services?.networkManager as any)?.setReputation?.(reputation); } catch { }`

  Same reasoning as the post-construction group — the service is always present; a silent skip only
  hides a real bug. **Recommendation: fail fast** (typed, non-optional). Note this one is AFTER
  `node.start()`, so on throw prefer `await node.stop()` before rethrowing so the rejection doesn't
  leak a started node + open transports (mirrors the cohortTopic hard-fail block at `~984`/`~1013`).

### The `as any` cast

- `~365` `const libp2pOptions: unknown = { ... }`
- `~504` `const node = await createLibp2p(libp2pOptions as any);`

The file already derives `type Libp2pInit = NonNullable<Parameters<typeof createLibp2p>[0]>` and
`export type Libp2pTransports = NonNullable<Libp2pInit['transports']>` at `~86-87`. Type
`libp2pOptions` as `Libp2pInit` directly and remove the `as any`. Expect the compiler to flag the
per-service factory functions (`cluster`, `repo`, `sync`, `blockTransfer`, `networkManager`, `fret`)
whose `components` params are currently `any` and whose return shapes libp2p types more strictly;
narrow/adjust the local construction to satisfy `Libp2pInit['services']` rather than re-casting the
whole object. If a fully-typed `services` map proves disproportionately invasive (the custom service
factories return heterogeneous shapes), it is acceptable to type `libp2pOptions` as `Libp2pInit` and
keep a *narrow, commented* cast only on the `services` field — but no blanket `as any` on the whole
object, and no `as any` on `createLibp2p(...)`.

## Design

Add two small structural interfaces near the top of `libp2p-node-base.ts` (or a local
`service-wiring.ts` sibling if preferred):

```ts
import type { Libp2p } from 'libp2p';
import type { IPeerReputation } from './reputation/...'; // the type NetworkManagerService.setReputation takes

/** A service that accepts post-construction injection of the running libp2p node. */
interface SetLibp2pCapable {
	setLibp2p(libp2p: Libp2p): void;
}

/** A service that accepts post-start injection of the peer-reputation view. */
interface SetReputationCapable {
	setReputation(reputation: IPeerReputation): void;
}
```

Both `NetworkManagerService` (`network-manager-service.ts:61,65`), `RepoService`
(`repo/service.ts:102`), and `Libp2pFretService` (p2p-fret) already satisfy `setLibp2p`
structurally; `NetworkManagerService` also satisfies `setReputation`. Confirm the exact
`IPeerReputation` type by reading `NetworkManagerService.setReputation`'s parameter type and its
import.

Replace the untyped `node.services` access with a typed services record so the compiler checks the
injection calls, e.g.:

```ts
type WiredServices = {
	fret: SetLibp2pCapable;
	networkManager: SetLibp2pCapable & SetReputationCapable;
	repo: SetLibp2pCapable;
};
const services = node.services as unknown as WiredServices;

// post-construction, load-bearing — fail fast (any throw rejects node creation; node not started)
services.fret.setLibp2p(node);
services.networkManager.setLibp2p(node);
services.repo.setLibp2p(node);   // comment: live before start() so the handler resolves the node from its first request
```

For each load-bearing injection that we now let throw, keep the existing explanatory comment (it is
the record of *why* the injection matters). For the in-factory best-effort pair, replace the empty
catch with a `debug`-logger call through this package's `createLogger(...)`
(`packages/db-p2p/src/logger.ts`) naming which service failed, e.g.:

```ts
const wiringLog = createLogger('node-wiring');
// ...
try { svc.setLibp2p(components.libp2p); }
catch (err) { wiringLog('fret in-factory setLibp2p failed (proxy); real node injected post-construction: %o', err); }
```

Precedent for the log-not-swallow pattern already exists at
`packages/db-p2p/src/network/get-network-manager.ts:13`
(`catch (err) { log('getNetworkManager setLibp2p failed - %o', err) }`).

### Failure-mode summary (the per-injection decision the ticket asks for)

| site | class | on failure |
|------|-------|-----------|
| `~481` networkManager (factory) | best-effort proxy | log via `createLogger`, continue |
| `~494` fret (factory)           | best-effort proxy | log via `createLogger`, continue |
| `~507` fret (post-construction) | load-bearing, pre-start | fail fast (throw propagates) |
| `~508` networkManager (post-construction) | load-bearing, pre-start | fail fast |
| `~513` repo (post-construction) | load-bearing, pre-start | fail fast |
| `~533` networkManager.setReputation | load-bearing, post-start | fail fast, but `await node.stop()` before rethrow |

## TODO

- [ ] Read `NetworkManagerService.setReputation` (`network-manager-service.ts:65`) to pin the exact
      `IPeerReputation` type + its import path; read `Libp2pFretService.setLibp2p` and
      `RepoService.setLibp2p` (`repo/service.ts:102`) to confirm all three satisfy `SetLibp2pCapable`.
- [ ] Add `SetLibp2pCapable` and `SetReputationCapable` interfaces + a `WiredServices` typed record
      to `libp2p-node-base.ts`.
- [ ] Convert the three post-construction injections (`~507-513`) to typed, non-optional calls with
      no swallowing catch (fail fast). Preserve the existing explanatory comments.
- [ ] Convert the `setReputation` injection (`~533`) to a typed, non-optional call; on throw
      `await node.stop()` then rethrow (post-start leak avoidance).
- [ ] Convert the two in-factory injections (`~481`, `~494`) to typed calls that log the failure via
      a `createLogger('node-wiring')` debug logger instead of swallowing. Type each `svc` as
      `SetLibp2pCapable`.
- [ ] Type `libp2pOptions` as `Libp2pInit` (`~365`) and remove the `libp2pOptions as any` cast on
      `createLibp2p(...)` (`~504`). Resolve resulting compiler errors by narrowing the local option
      construction (especially the custom service factories' `components` params and return shapes);
      no blanket `as any`. A narrow, commented cast on only the `services` field is the accepted
      fallback if a fully-typed services map is disproportionately invasive.
- [ ] Confirm no remaining empty `catch { }` blocks in the file (grep `catch {` / `catch { }`).
- [ ] Build: `cd packages/db-p2p && yarn build` (`tsc`). Must pass with no new errors.
- [ ] Test: `cd packages/db-p2p && yarn test 2>&1 | tee /tmp/db-p2p-test.log` (stream output; do not
      silently redirect). If a node-construction test exists it exercises this path; otherwise the
      build (tsc) is the primary gate since the change is type-driven.
- [ ] Handoff: write a `review/` ticket. Be honest about the in-factory-injection tradeoff (kept as
      log-not-delete) and about whether the `libp2pOptions` typing landed fully or fell back to a
      narrow `services`-field cast.
