description: A peer that accepts a connection but then never answers can make a block-copy request wait forever, which during node churn can stall the whole re-replication pass; add a response deadline so a silent peer is given up on, plus a fast automated test that proves block copying works over a real stream.
prereq:
files: packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/test/protocol-client-dial-timeout.spec.ts, packages/db-p2p/test/spread-on-churn.spec.ts, packages/db-p2p/test/block-transfer-push-persist.spec.ts, packages/db-p2p/src/it-utility.ts
difficulty: medium
----

# Implement: block-transfer push needs a response deadline + a default-suite round-trip regression test

## Reproduction (confirmed in fix stage)

A scratch test built a `ProtocolClient` whose `peerNetwork.connect` resolves to a stream that
**dials OK but whose source never yields and never closes**:

```ts
function silentStream() {
  return {
    send: () => {}, close: async () => {}, abort: () => {},
    async *[Symbol.asyncIterator]() { await new Promise<void>(() => {}); }, // blocks forever
  };
}
// ...
await client.dial({ ping: true }, '/test/1.0.0', { dialTimeoutMs: 200 }); // never resolves
```

Result: the call **never resolves** and mocha's 2s timeout fires — *despite* `dialTimeoutMs: 200`.
The dial succeeded; only the **response-read** phase hangs, and that phase honors no deadline. This
is exactly Gap 1: a peer that connects but never replies stalls the caller indefinitely.

## Root cause

`ProtocolClient.processMessage` (`protocol-client.ts`) bounds only the **dial** phase via
`options.dialTimeoutMs` → an `AbortController` passed to `peerNetwork.connect`. The **response-read**
phase reads the reply with:

```ts
const result = await first(() => source, () => { throw new Error('No response received') });
```

(`protocol-client.ts:121`). This call:
- passes **no** `timeoutMs` (the third arg of `first`), and
- ignores the `signal` that `first` threads into its `createIterable` callback (the arrow `() => source`
  drops it), and
- never honors `options.signal` during the read.

So `for await (… of source)` (inside `first`) blocks forever when the peer never writes a frame and
never closes the stream. **Important subtlety:** even passing `first`'s own `timeoutMs` is *not*
sufficient by itself — `first` only `controller.abort()`s a signal that nothing here is wired to, so
the underlying `for await` over the libp2p stream keeps awaiting. The read only unblocks if the
**stream itself is aborted** (real libp2p streams reject the async iterator on `stream.abort()`), or
if the stream iteration is made to honor an abort signal. The fix must therefore actively
`stream.abort()` on deadline/parent-abort, not merely set a timer.

Because `SpreadOnChurnMonitor.performSpread` (`spread-on-churn.ts:222`) awaits each `client.pushBlocks`
**sequentially**, one silent target stalls the entire spread pass — all later blocks/targets and the
`trackedBlocks` self-prune never progress. Churn (slow/dying peers) is exactly when spread fires, so
this is a real production hazard.

## Fix design — Gap 1 (preferred: signal/deadline-aware `processMessage`)

Implement the **preferred** option from the fix ticket (general; benefits every `ProtocolClient`
subclass — repo, cluster, dispute, block-transfer), not the contained `Promise.race`-in-`performSpread`
alternative. The contained alternative leaves a raced-out `processMessage` running in the background
holding the stream open; the preferred approach actually tears the stream down.

Mirror the existing `DialTimeoutError` machinery:

- Add a `ResponseTimeoutError` (code `RESPONSE_TIMEOUT`, e.g. `RESPONSE_TIMEOUT_ERROR_CODE`) next to
  `DialTimeoutError`, so callers/diagnostics can distinguish "peer dialed but went silent" from a dial
  failure and from a parent cancellation.
- Extend the `processMessage` options bag with `responseTimeoutMs?: number`.
- In the response-read `try` block (after `dial:ok`), set up a **response deadline** that, on expiry,
  calls `stream.abort(new ResponseTimeoutError(...))`:
  - a `setTimeout(responseTimeoutMs)` when `responseTimeoutMs > 0`, and
  - wire `options.signal` so a parent abort *also* aborts the stream (forward the parent reason).
  Aborting the stream unblocks the `first(...)` `for await`; catch the resulting iterator error and:
  - if our own response timer fired → throw `ResponseTimeoutError`;
  - if the parent signal fired → surface the parent `signal.reason`;
  - otherwise rethrow the original error.
- Clean up in `finally`: `clearTimeout`, remove the parent-abort listener. Keep the existing
  `await stream.close()` in the outer `finally` (closing an already-aborted stream must be safe — guard
  with try/catch if needed).
- Leave behavior unchanged when `responseTimeoutMs` is omitted **and** no `signal` is supplied (no
  response cap — preserves every current caller, mirroring how `dialTimeoutMs` omission imposes no dial
  cap).

`it-utility.ts`'s `first` already accepts a `(signal) => AsyncIterable` factory and an optional
`timeoutMs`; you may either thread the response-deadline signal through it or keep the abort logic in
`processMessage`. Whichever you choose, the decisive action is `stream.abort()` — confirm the chosen
mechanism actually interrupts a never-yielding stream (the reproduction harness above is the litmus
test).

### Plumb the deadline through the block-transfer client + spread caller

- `BlockTransferClient.pushBlocks` / `pullBlocks` (`block-transfer-service.ts:253,268`) currently call
  `processMessage(request, this.protocol)` with **no** options. Add an optional options argument
  (`{ signal?, dialTimeoutMs?, responseTimeoutMs? }`) and forward it to `processMessage`. Keep it
  optional/backward-compatible (existing callers and tests pass nothing).
- `SpreadOnChurnConfig` (`spread-on-churn.ts:15`): add two config knobs with defaults in
  `DEFAULT_CONFIG`, e.g. `pushDialTimeoutMs` (default `3000`, matching the codebase's other dial caps —
  `reference-peer/src/cli.ts:422`, `collection-factory.ts:191`) and `pushResponseTimeoutMs`
  (default `10000`). Document them in the interface doc comments.
- `performSpread` (`spread-on-churn.ts:230`): pass
  `{ dialTimeoutMs: this.config.pushDialTimeoutMs, responseTimeoutMs: this.config.pushResponseTimeoutMs }`
  into `client.pushBlocks(...)`. A timed-out push throws → the existing `catch` branch
  (`spread-on-churn.ts:242`) already records it in `failed` and continues to the next target/block. No
  new branch needed; just verify a thrown `ResponseTimeoutError` lands there (it does — it's a throw).

## Fix design — Gap 2 (default-suite round-trip regression test)

The block-transfer **receive handler** (`BlockTransferService.handleRequest`, `block-transfer-service.ts:116`)
is a single continuous duplex pipe (`pipe(stream, lp.decode, async function*…, lp.encode)`). Today the
**only** thing exercising that real-stream round trip is the env-gated churn integration test
(`OPTIMYSTIC_INTEGRATION=1`, `real-libp2p.integration.spec.ts`). The default `yarn test` run never
drives `registrar.handle` + a stream — `block-transfer-push-persist.spec.ts` calls `handlePush`/
`handlePull` **directly**. A regression in the handler's stream framing would pass the default suite
silently (it was a framing/handler-signature bug that this whole ticket chain traces back to).

Add a default-suite (no env gate) regression test that drives a real request→response round trip
**through the registered handler**. Suggested new file:
`packages/db-p2p/test/block-transfer-roundtrip.spec.ts`.

Harness — a lightweight in-memory **linked duplex pair** (no real libp2p):
- Use `it-pushable` (already a dependency, `package.json`) to back two byte queues.
- `makeLinkedPair()` → `{ clientStream, serverStream }` where:
  - `clientStream.send(chunk)` pushes into the **server's** input queue; `clientStream`'s async
    iterator yields from the **client's** input queue.
  - `serverStream.send(chunk)` pushes into the **client's** input queue; `serverStream`'s async
    iterator yields from the **server's** input queue.
  - `close()`/`abort()` end the respective pushable(s). Match the duck-typed stream shape the
    existing mocks use (`send`, `close`, `abort`, `[Symbol.asyncIterator]`; see the mock in
    `block-transfer.spec.ts:80` and `spread-on-churn.spec.ts:179`).
- Register the service via a mock `registrar` that captures the handler passed to `handle()`. A mock
  `peerNetwork.connect` creates a pair, invokes the captured handler with `serverStream` (do **not**
  await it — let it run concurrently), and returns `clientStream` to the `BlockTransferClient`.
- Back the service with the real `StorageRepo` + `MemoryRawStorage` + `BlockStorage` (as
  `block-transfer-push-persist.spec.ts:39-46` does) so `saveReplicatedBlock` actually persists.

Assertions:
- **pull** round trip: a block present in storage comes back in `response.blocks` through the real
  handler+stream (not a direct method call).
- **push** round trip: client `pushBlocks` returns success (block in `response.blocks`, not `missing`)
  **and** `repo.get` on the receiver shows the block durably persisted (proves `saveReplicatedBlock`
  ran via the stream path).
- **no-response peer** (covers Gap 1): a handler/stream that reads the request but **never yields a
  response** (e.g. server side awaits forever, or never feeds the client's input queue) → the client
  call rejects with `ResponseTimeoutError` within a bounded `responseTimeoutMs` (use a small value like
  50–100ms and a tight mocha `this.timeout` so a regression fails fast rather than hanging the suite).

Optionally also add a focused unit test in `protocol-client-dial-timeout.spec.ts` asserting
`processMessage` throws `ResponseTimeoutError` when the dialed stream never yields (the reproduction
harness above, parameterized with `responseTimeoutMs`). This is the cheapest direct guard for Gap 1
and mirrors the file's existing structure.

## Acceptance

- An expansion peer that dials OK but never responds cannot stall `performSpread` beyond a bounded
  deadline; the push is recorded as `failed` (never `succeeded`) and the loop continues to the next
  target/block.
- `yarn test` (no env gate) covers a block-transfer request→response round trip through the registered
  stream handler (both pull and push, push asserting persistence), and a no-response-peer case
  asserting the deadline fires.
- `yarn build` + `yarn test` pass in `packages/db-p2p`; the env-gated churn integration test
  (`yarn test:integration`) still passes (do not run it inside the ticket if wall-clock is prohibitive —
  it is env-gated and may exceed the idle budget; document the deferral if skipped).
- No behavior change for existing `processMessage` callers that pass neither `responseTimeoutMs` nor a
  `signal` (no response cap imposed), preserving the repo/cluster/dispute clients.

## TODO

### Phase 1 — response deadline in `ProtocolClient`
- [ ] Add `ResponseTimeoutError` + `RESPONSE_TIMEOUT_ERROR_CODE` in `protocol-client.ts`, mirroring
      `DialTimeoutError`.
- [ ] Add `responseTimeoutMs?: number` to the `processMessage` options type.
- [ ] In the response-read phase, install a deadline (timer + parent-signal forwarding) that calls
      `stream.abort(reason)` on expiry; translate the resulting read error into `ResponseTimeoutError`
      (own timer) or the parent reason (parent abort); clean up timer/listener in `finally`.
- [ ] Confirm the reproduction harness (silent never-yielding stream) now rejects with
      `ResponseTimeoutError` instead of hanging; confirm omitting `responseTimeoutMs` + `signal`
      preserves the no-cap behavior.

### Phase 2 — plumb through block-transfer + spread
- [ ] `BlockTransferClient.pushBlocks`/`pullBlocks`: accept + forward an optional
      `{ signal?, dialTimeoutMs?, responseTimeoutMs? }` options arg to `processMessage`.
- [ ] `SpreadOnChurnConfig` + `DEFAULT_CONFIG`: add `pushDialTimeoutMs` (default 3000) and
      `pushResponseTimeoutMs` (default 10000) with doc comments.
- [ ] `performSpread`: pass the two timeouts into `client.pushBlocks(...)`; verify a timed-out push
      lands in the existing `failed` branch.

### Phase 3 — regression tests
- [ ] New `test/block-transfer-roundtrip.spec.ts`: in-memory linked duplex pair + captured handler;
      pull round trip, push round trip (asserting persistence via real `StorageRepo`/`MemoryRawStorage`),
      and a no-response-peer case asserting `ResponseTimeoutError` fires within a bounded deadline.
- [ ] (Optional) add a `ResponseTimeoutError` unit test to `protocol-client-dial-timeout.spec.ts`.

### Phase 4 — validate
- [ ] `cd packages/db-p2p && yarn build` (stream output with `tee`).
- [ ] `cd packages/db-p2p && yarn test 2>&1 | tee /tmp/dbp2p-test.log` — all green, new tests included.
- [ ] If feasible, `yarn test:integration` for the churn e2e; otherwise document the deferral for CI.
