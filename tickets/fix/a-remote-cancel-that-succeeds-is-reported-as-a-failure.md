description: When one machine asks another to cancel a reservation, the cancel works but the asking machine always reads the reply as an error, so the write retries after a multi-second back-off. Make a successful remote cancel resolve as success.
files: packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/protocol-client.ts, packages/db-p2p/src/repo/client.ts, packages/db-core/src/transactor/network-transactor.ts (`cancel`, `processBatches`)
----
# A remote cancel that succeeds is reported as a failure

GitHub [#46](https://github.com/gotchoices/Optimystic/issues/46) (kjeib). Read the issue in full (`gh issue view 46`); it carries a plain-Node repro.

`IRepo.cancel` resolves `void`. `RepoService` answers with `JSON.stringify(response)`, which for `undefined` is an empty frame; `ProtocolClient.processMessage` runs `JSON.parse('')` and throws `Unexpected end of JSON input`. `NetworkTransactor.cancel` goes through `processBatches`, so the "failed" batch is retried on another coordinator after the back-off (3.5 s under Sereus's declared link round trip). A write whose pend came back stale or held and is then cancelled waits the full back-off even on loopback (Taleus: 4.5–6.6 s vs 0.4–0.6 s).

## Expected

- A remote `cancel` that the remote ran resolves at the caller.
- Fix it at the protocol layer so any other `void` operation is covered too: either the service never sends an empty frame for a resolved operation, or the client reads an empty frame for a `void` operation as `undefined`. Pick one rule and apply it in one place.
- A real cancel failure still surfaces as a failure.

## Test

A spec that runs a repo-protocol `cancel` against a `RepoService` whose repo's `cancel` resolves `void`, asserting it resolves (the issue's repro is the shape). Check whether an existing test double masked this (for example a fake client that never round-trips JSON).
