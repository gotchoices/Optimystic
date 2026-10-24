description: When one machine asks another to cancel a reservation, the cancel works but the asking machine always reads the reply as an error, so the write retries after a multi-second back-off. Make the shared reply reader treat an empty reply as "done, nothing to return", so a successful remote cancel resolves as success.
files: packages/db-p2p/src/protocol-client.ts (`ProtocolClient.exchange`, the JSON decode stage), packages/db-p2p/test/util/protocol-stream.ts, packages/db-p2p/test/repo-protocol-void-reply.spec.ts (new), packages/db-p2p/src/repo/service.ts (read only — the `JSON.stringify(response)` reply), packages/db-p2p/src/repo/client.ts (`RepoClient.cancel`), packages/db-core/src/transactor/network-transactor.ts (`cancel`, `dischargeCancel`, `cancelRound` — consumers, no change expected), packages/db-p2p/docs/repo.md or docs/internals.md (one sentence on the wire rule)
repro: verified
----
# A remote cancel that succeeds is reported as a failure

GitHub [#46](https://github.com/gotchoices/Optimystic/issues/46) (kjeib).

## Cause (reproduced)

`IRepo.cancel` resolves `void`. `RepoService.handleIncomingStream` answers every operation with `new TextEncoder().encode(JSON.stringify(response))`; `JSON.stringify(undefined)` is `undefined`, which `TextEncoder` encodes as zero bytes, so the reply is a length-prefixed frame of length 0. `ProtocolClient.exchange` runs `JSON.parse` on every frame, and `JSON.parse('')` throws `SyntaxError: Unexpected end of JSON input`. The remote cancel ran; the caller sees a failure.

Reproduced in-process (a `RepoClient` whose `connect` hands the service's `handleIncomingStream` one end of an in-memory stream pair, over a repo whose `cancel` resolves `void`):

```
SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at .../packages/db-p2p/src/protocol-client.ts (the decode stage in exchange)
    at async first (.../src/it-utility.ts)
    at async RepoClient.exchange
    at async RepoClient.processMessage
    at async RepoClient.processRepoMessage
```

## Consequences, beyond the issue's latency

- `NetworkTransactor.cancelRound` sends cancels through `processBatches`; every remote batch "fails", is re-sent to another coordinator after the retry back-off (3.5 s under Sereus's declared link round trip), and fails again. That is the 4.5–6.6 s vs 0.4–0.6 s Taleus measurement in the issue.
- Worse: `dischargeCancel` judges completeness by which blocks some peer answered for, so a cancel whose blocks are coordinated remotely can never be confirmed discharged over the wire. It throws after its bounded retries or leaves an owed cancel behind, and every caller that needs a *confirmed* cancel — `TornActionError.final` requires "the write's pending records were confirmed cancelled before the blocks were asked" (docs/internals.md, *A half-landed write that cannot be finished is refused by name*) — gets the unconfirmed answer whenever the coordinator is another machine. Only a self-coordinated cancel (in-process `IRepo`, no JSON) worked.

## Why tests never saw it

Every test of the cancel path above the wire uses an `IRepo` test double or the in-process mesh, which hands the repo's return value straight back with no JSON round trip — `RepoClient.cancel` was never driven against `RepoService`. The existing service specs (`test/repo-service-remote-get-consult.spec.ts`, via `test/util/protocol-stream.ts`'s `makeServiceStream` + `decodeJson`) drive the service alone and only for `get`; `decodeJson` would itself throw on an empty frame.

## The rule (decision)

**The client reads a zero-length reply frame as `undefined`.** Apply it once, in `ProtocolClient.exchange`'s decode stage, which every protocol client (repo, cluster, sync, block-transfer, dispute) shares:

```ts
async function* (source) {
	for await (const data of source) {
		// A service answers a `void` operation with `JSON.stringify(undefined)`, which encodes as a
		// zero-length frame. No other value serializes to an empty string, so an empty frame is
		// exactly a `void` reply.
		yield data.byteLength === 0 ? undefined : JSON.parse(new TextDecoder().decode(data.subarray()));
	}
}
```

Why the client side rather than the service sending `JSON.stringify(response ?? null)`:

- One site covers every protocol; the service-side rule would have to be applied in five services (`repo`, `cluster`, `sync`, `block-transfer`, `dispute` each encode their own reply).
- It fixes an upgraded caller talking to an already-deployed coordinator (1.16–1.18 send the empty frame today). A service-side fix only helps once every coordinator a writer reaches is upgraded.
- It is exact, not a heuristic: `JSON.stringify` returns `''`/`undefined` for no JSON value, so a non-empty reply is never misread, and a truncated reply cannot look like an empty frame (length-prefixing makes the zero length explicit).

Note `first(...)` in `it-utility.ts` returns the first yielded item even when it is `undefined`, so `'No response received'` stays reserved for a stream that ended with no frame at all.

A real cancel failure still surfaces: `RepoService` lets the repo's throw escape `processStream`, the handler aborts the stream, and the client's read rejects — unchanged by this rule.

## Test

One new spec, `packages/db-p2p/test/repo-protocol-void-reply.spec.ts`, at the lowest layer that reproduces it — a real `RepoClient` against a real `RepoService` over an in-memory stream pair (no libp2p, no mocks of repo-owned modules; the repo behind the service is a plain `IRepo` object, which is the boundary):

- a repo whose `cancel` resolves `void` → `client.cancel(...)` resolves, and the repo saw exactly one cancel (fails today with the JSON error);
- a repo whose `cancel` throws → `client.cancel(...)` rejects (pins that the fix does not swallow real failures).

Add a `makeStreamPair()` helper to `test/util/protocol-stream.ts` (client end and service end, each with `send`/`close`/`abort` and an async iterator over what the other end sent) so the spec does not carry its own. The repro used this shape:

```ts
function makeStreamPair() {
	const channel = () => {
		const items: Uint8Array[] = []; let ended = false; let wake: (() => void) | undefined;
		return {
			push: (c: Uint8Array) => { items.push(c); wake?.(); },
			end: () => { ended = true; wake?.(); },
			async *read() { while (true) { if (items.length) { yield items.shift()!; continue; } if (ended) return; await new Promise<void>(r => wake = r); wake = undefined; } }
		};
	};
	const toService = channel(); const toClient = channel();
	const end = (out: ReturnType<typeof channel>, inbound: ReturnType<typeof channel>) => ({
		send: (c: { subarray: () => Uint8Array }) => { out.push(c.subarray()); },
		close: async () => { out.end(); },
		abort: () => { out.end(); inbound.end(); },
		[Symbol.asyncIterator]: () => inbound.read(),
	});
	return { client: end(toService, toClient), service: end(toClient, toService) };
}
// network: { async connect() { const { client, service: s } = makeStreamPair(); (service as any).handleIncomingStream(s, undefined); return client; } }
```

The "throws" case needs the client to see the abort: make the service end's `abort` end the client's inbound channel (as above) so the client's read finishes; check what the client then raises (likely `No response received`, since the in-memory pair has no reset status) — the assertion is only that it rejects.

Do not add a `NetworkTransactor`-level test; the transactor's handling of a resolved cancel is already covered by its in-process specs, which is exactly the path that now matches the wire.

## TODO

- Change `ProtocolClient.exchange`'s JSON decode stage to yield `undefined` for a zero-length frame, with the comment above.
- Add `makeStreamPair` to `packages/db-p2p/test/util/protocol-stream.ts`.
- Add `packages/db-p2p/test/repo-protocol-void-reply.spec.ts` with the two cases; confirm the resolve case fails before the source change and passes after.
- Add one sentence where the repo wire is described (`packages/db-p2p/docs/repo.md`, or the JSON-transport paragraph in docs/internals.md under *Conflict replay re-makes the uniqueness decision*): a `void` operation's reply is a zero-length frame, which the client reads as `undefined`. Run `yarn lint:docs` if a citation is added.
- `yarn build` then `yarn test` in `packages/db-p2p` (and `packages/db-core` is untouched). Optionally `yarn test:integration` from root, since `real-libp2p.integration.spec.ts` exercises the real wire.
- Add a CHANGELOG entry if the project keeps an unreleased section (fix: a remote `cancel` that succeeded was reported as a failure and retried after the back-off; #46).
