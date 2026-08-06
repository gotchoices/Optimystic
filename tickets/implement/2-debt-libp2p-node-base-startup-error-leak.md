description: When starting a peer-to-peer node fails partway through setup, the partly-built node keeps running with its network port still open instead of shutting down, so the failed startup leaks resources and can block the port for the next attempt.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/libp2p-node.ts, packages/db-p2p/test/
difficulty: medium
repro: verified
----

## Reproduced

Confirmed by running a throwaway spec against `createLibp2pNode` (from
`packages/db-p2p/src/libp2p-node.ts`, which delegates to `createLibp2pNodeBase`):

```ts
const port = await freePort();          // bind :0, read port, close
let rejected: unknown;
try {
    await createLibp2pNode({
        bootstrapNodes: [],
        networkName: 'test-startup-rollback',
        port,
        // Libp2pKeyPeerNetwork.initFromPersistedState() awaits persistence.load()
        // AFTER node.start() — libp2p-node-base.ts:697.
        persistence: {
            load: async () => { throw new Error('corrupt persisted state'); },
            save: async () => { },
        },
    });
} catch (err) { rejected = err; }

expect(rejected).to.be.instanceOf(Error);
expect(await portIsFree(port), 'listener port released (node was stopped)').to.equal(true);
```

Result at HEAD: `createLibp2pNode` rejects with `corrupt persisted state`, and the port
assertion fails — `actual false, expected true`. The TCP listener is still bound. The mocha
process then never exits (the leaked node's handles keep the event loop alive); the run had
to be killed.

Applying the minimal candidate fix at the single failing site —

```ts
try { await keyNetwork.initFromPersistedState(); } catch (err) { await node.stop(); throw err; }
```

— makes the same spec pass (port free, 88ms). So `node.stop()` at that point in startup does
release the transports; the missing piece is only that almost nothing in the post-start body
calls it.

## Root cause

`createLibp2pNodeBase` (`packages/db-p2p/src/libp2p-node-base.ts`) calls `await node.start()`
at line 683 and returns at line 1612. Those ~928 lines of async setup run against an already
started node — open transports and listeners — but only three sites stop the node before
rethrowing:

- `wired.networkManager.setReputation(reputation)` — line 704-709
- cohort-topic FRET-unavailable hard-fail — line 1325
- `createCohortTopicHost` failure — line 1354

Every other throw in that span (starting with `keyNetwork.initFromPersistedState()` at line
697) escapes as a rejection while the started node keeps running. The caller gets an error and
no handle, so it cannot stop the node either.

## Second arm: teardown wrappers are installed after the resources they release

`node.stop()` is progressively decorated by stop wrappers, each capturing the previous
`node.stop` (`previousStop`). A rollback `node.stop()` therefore only unwinds resources whose
wrapper was **already installed** at the moment of the throw. Several resources are created
well before their wrapper, so a plain try/catch alone would still leak them:

| resource | created | its stop wrapper | throwable code in the gap |
| --- | --- | --- | --- |
| `clusterImpl` (ClusterMember intervals) | 776 | 1277 | ~500 lines |
| cohort-topic `host` (gossip timer, protocol handlers) | 1334 | 1596 | reactivity + matchmaking wiring, 1357-1591 |
| `offInboundNotify`, `unsubscribe`, `pushStateGossip`, reactivity/matchmaking `unhandle` | 1369-1591 | 1596 (same wrapper) | same span |

Two that are already correct and should stay that way — they are the pattern to copy:

- owned-block feed: wrapper installed up front at 916, *before* `ensureOwnedBlockFeed()` can
  run (944 / 1131). Deliberate; the comment at 912-914 says so.
- spread / rebalance monitors: started inside their own `try`/`catch` that swallows and
  continues (933-950, 1150-1154), so a start failure never reaches the rollback path anyway.

So the fix is: wrap the post-start body, **and** move the two lagging wrappers up so the
rollback actually unwinds what exists at the throw point.

## Expected behavior

A throw anywhere between `await node.start()` and the successful `return` leaves nothing
running: transports closed, cluster-member intervals cleared, cohort-topic host stopped,
reactivity/matchmaking handlers unregistered. The error the caller sees is the original error,
never a rollback error.

## Shape of the fix

```ts
await node.start();

try {
    // …entire post-start body, ending in…
    return node as unknown as OptimysticNode;
} catch (err) {
    // Rollback: the node is started, so a rejection must not hand the caller an error and no
    // handle while transports stay open. node.stop() runs whatever teardown wrappers were
    // installed before the throw. A rollback failure must not mask the real error.
    try { await node.stop(); }
    catch (stopErr) { wiringLog('rollback stop failed after startup error: %o', stopErr); }
    throw err;
}
```

Notes for the implementer:

- `node.stop()` is safe to call twice here — the existing wrappers are all written to be
  idempotent (see the comments at 958-960 and 1139-1141), and the three ad-hoc stop-and-rethrow
  blocks already rely on it.
- The three ad-hoc blocks (704-709, 1318-1327, 1332-1356) become redundant once the outer
  `try` exists. Delete the `try`/`catch`/`await node.stop()` scaffolding at each, keep the
  `throw new Error('cohortTopic enabled but the FRET service is unavailable on the node')` and
  keep `host = await createCohortTopicHost(...)` as a plain `const`. Update the comments that
  explain why they stop the node — that reason now lives in one place.
- `wiringLog` already exists in this file (used at line 636).
- This is a ~928-line re-indent by one tab. There is no `indent` rule in the repo's
  `eslint.config.js`, but re-indent properly anyway and tell the reviewer to read the diff with
  `git diff -w`.
- Watch the two `let` declarations that are assigned inside the span but declared before it
  (`clusterImpl` at ~776 is assigned, not declared, there) — a full-span `try` keeps everything
  in one scope, so nothing needs re-declaring, but confirm with `yarn build`.

## Regression test

Land the repro above as a real spec (suggested `packages/db-p2p/test/startup-rollback.spec.ts`).
It is a genuine class test, not a one-off: it pins "a post-start failure releases the port" for
any future setup step added to this factory.

Add a `NOTE:` in the spec recording the operational hazard: when this assertion *fails*, the
leaked node keeps the mocha process alive, so `yarn test` hangs at exit rather than returning.
Debug such a run with `--exit`. Do not add `--exit` to the package's `test` script — that would
mask unrelated handle leaks across the whole suite.

Helper shape used in the verified repro (`node:net`):

```ts
async function freePort(): Promise<number>       // listen(0, '127.0.0.1'), read addr.port, close
async function portIsFree(port: number): Promise<boolean>  // listen(port, '0.0.0.0'); 'error' ⇒ false
```

Worth a second case in the same spec covering the cohort arm: `cohortTopic` enabled on a node
whose FRET service is unavailable hits the 1325 hard-fail, which already stops the node today —
so it should stay green before and after, guarding the deletion of that ad-hoc block.

## TODO

Phase 1 — rollback wrapper

- Wrap the post-start body of `createLibp2pNodeBase` (lines 684-1612) in `try` / `catch`, with
  the catch calling `node.stop()` (guarded, non-masking) and rethrowing the original error.
- Delete the three now-redundant ad-hoc stop-and-rethrow blocks; keep the errors they raise and
  fold their "why we stop first" comments into the single rollback comment.

Phase 2 — wrapper/resource ordering

- Move the `clusterImpl` dispose wrapper (1275-1282) to immediately after `clusterImpl` is
  assigned (~797), so a throw in the ~500 lines between them still clears its intervals.
- Move the cohort-topic teardown wrapper (1593-1609) up to immediately after
  `createCohortTopicHost` returns (~1356), then extend it incrementally as each later resource
  is created (or install one small wrapper per resource, matching the file's existing
  `previousStop` idiom) — so a throw during reactivity/matchmaking wiring still stops the host
  and unregisters the handlers. Preserve the ordering the current wrapper documents at
  1593-1595: reactivity timers/handlers released before `host.stop()`, before `previousStop()`.
- If a resource's teardown must read a binding declared later, guard it the way
  `offOwnedBlockFeed?.()` does (undefined-check) rather than deferring the wrapper.

Phase 3 — verify

- Add `packages/db-p2p/test/startup-rollback.spec.ts` per above.
- `yarn build` from `packages/db-p2p` (type-check the re-indented span).
- `yarn test` from `packages/db-p2p`. Note: the full db-p2p suite did not finish inside a
  5-minute budget during this fix pass; run it with streamed output (`2>&1 | tee`) and allow
  time, or narrow with `--grep` first and run the full suite once at the end.
