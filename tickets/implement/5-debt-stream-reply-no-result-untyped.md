description: When a peer answers a request with "I have nothing for you", callers currently receive the same value as a real (empty) answer and must remember to check for it by hand; make "no result" a distinct value the compiler forces every caller to handle, and fix the one caller that forgot, so a subscriber asks the next peer instead of giving up on recovery.
files: packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/reactivity/recover-transport.ts, packages/db-p2p/src/cohort-topic/membership-source.ts, packages/db-p2p/src/cohort-topic/topic-router.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/matchmaking/query-transport.ts, packages/db-p2p/test/cohort-topic/stream-util-framing.spec.ts, packages/db-p2p/test/reactivity/recover-transport.spec.ts, packages/db-p2p/test/matchmaking/query-transport-client.spec.ts, packages/db-p2p/test/open-protocol-stream.spec.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts, docs/cohort-topic.md, docs/reactivity.md
difficulty: medium
----

# Make "peer had no result" a distinct value in the request/response helper

## Background

`packages/db-p2p/src/cohort-topic/stream-util.ts` provides the request/response pair that every single-frame protocol in `db-p2p` uses. Each side sends one length-prefixed frame:

```ts
requestResponse(node, peer, protocol, frame, maxBytes?): Promise<Uint8Array>
handleRequestResponse(node, protocol, handle: (frame, from) => Promise<Uint8Array | undefined>, maxBytes?): void
```

A serving handler signals "no result" by returning `undefined`. The helper puts a **zero-length frame** on the wire, because the reader treats end-of-stream as an error, so "nothing" has to be sent explicitly. Today the dialer receives that frame as an empty `Uint8Array`, which has the same type as a real reply. Every caller has to remember `reply.length === 0`, and nothing breaks at compile time when one forgets.

Host.ts's own register/membership/sign responders (`host.ts#makeRequestHandler`, around line 3184) use the same wire convention. The membership responder returns `new Uint8Array(0)` when it has no certificate.

**The defect.** `reactivity/recover-transport.ts` forgets. Its serve handler returns `undefined` on:
- a failed signature check;
- a replayed or stale request;
- a request it cannot decode;
- a collection it does not serve.

Its own comment says the subscriber should then fall back. The dialing loop in `Libp2pReactivityRecoverTransport.exchange` instead passes the empty frame to `decodeRecoverReplyV1`. That throws "frame too short", and the throw is outside the loop's dial-failure `catch`, so it propagates. **The first cohort member that declines ends the whole recover walk.**

## Design

### The helper's return type

`requestResponse` resolves `Promise<Uint8Array | undefined>`:

- `undefined` means the peer replied with a zero-length frame, i.e. it had no result.
- A returned `Uint8Array` is always non-empty. Callers never see empty bytes.
- Genuine failures still reject, with the error types unchanged: dial failure, stream aborted by a throwing handler (`FrameTruncationError`), over-ceiling reply (`PayloadTooLargeError`).

Mapping every zero-length frame to `undefined` is safe. No protocol in the package has a meaningful empty reply:
- cohort messages carry an internal length prefix;
- query and recover replies are encoded objects;
- an empty membership reply already means "no certificate".

Only the **reply** direction changes. The request frame a handler receives stays `Uint8Array`, and an empty request is still delivered as empty bytes. The `handleRequestResponse` handler signature is unchanged. Document on it that returning `new Uint8Array(0)` is the same wire signal as `undefined`. That is how host.ts's `makeRequestHandler` membership responder expresses "no result"; leave that responder as it is.

### A small shared helper for callers that expect a reply

Add to `stream-util.ts`:

```ts
/** Thrown when a request/response peer replied with a zero-length frame where the protocol requires a reply. */
export class NoResultReplyError extends Error {
  // name = "NoResultReplyError"; message includes the context string
}

/** Unwrap a reply the protocol always carries; throw NoResultReplyError(context) when the peer had no result. */
export function requireReply(reply: Uint8Array | undefined, context: string): Uint8Array;
```

Callers whose protocol guarantees a frame use it, so the explicit decision is one readable call.

### Per-call-site decisions

Each site must now say what "no result" means. The change is behaviour-preserving everywhere except recover, which is the bug.

| Call site | On `undefined` | Why |
|---|---|---|
| `reactivity/recover-transport.ts` `Libp2pReactivityRecoverTransport.exchange` | **Fall through to the next candidate.** Set `lastErr = new NoResultReplyError(...)`, log, `continue`. | This is the fix. It matches the serve handler's stated intent. |
| `cohort-topic/membership-source.ts` `fetch` | Try the next member. The check `reply.length > 0` becomes `reply !== undefined`. | Unchanged behaviour. |
| `matchmaking/query-transport.ts` `dialQuery` | Return `emptyReply()`. The check `frame.length === 0` becomes `frame === undefined`. | Unchanged. A topic the peer does not serve gets no reply. |
| `matchmaking/query-transport.ts` `dialRegister` | `requireReply(frame, "matchmaking register")`, which throws. | The `/register` responder always writes a frame, so only a non-conforming peer lands here. Today this path throws inside decode; keep it a rejection, now named. |
| `cohort-topic/topic-router.ts` `dialMember` | `requireReply(reply, "cohort-topic register dial")`, which throws. | Same `/register` responder. db-core's `walk.ts` and the `service.ts` renewal `send` already treat a rejection as a failed dial. |
| `cohort-topic/host.ts` `dialSign` (around line 701) | `requireReply(reply, "cohort sign")`, which throws. | The `/sign` responder always writes a frame. `threshold-crypto.ts#collectFrom` catches the rejection and counts no signature for that member, as it does today. |

**Recover's reply contract.** `RecoverDialer.exchange` (in `recover-transport.ts`) widens to `Promise<Uint8Array | undefined>`, so the injected seam matches the production helper. `createLibp2pRecoverDialer` passes `requestResponse`'s result through unchanged.

After the change, the recover `exchange` loop classifies each outcome as:
- **dial rejection:** fall through (unchanged);
- **`undefined` (declined):** fall through (new);
- **non-empty reply that fails to decode:** terminal (unchanged);
- **`kind: "rotated"`:** terminal `RotationRedirectError` (unchanged);
- **kind mismatch:** terminal (unchanged);
- **all candidates exhausted:** throw `lastErr`. That is a `NoResultReplyError` when the last candidate declined, or the dial error when it failed to dial.

**Out of scope: db-core's `ITopicRouter.dialMember` port stays `Promise<Uint8Array>`.** Widening it would ripple through db-core's walk and renewal code for a state that only a non-conforming peer can produce. The adapter's explicit `requireReply` records the decision at the boundary. Mention this in the `dialMember` JSDoc.

### Comments and docs to correct

- `recover-transport.ts`:
  - Module docblock line 22 says any failure produces "no reply (the stream aborts)". That is wrong: the peer sends a zero-length frame and the dialer falls through.
  - `Libp2pReactivityRecoverTransport` class doc (around lines 162-167) and `exchange` JSDoc (around lines 208-213): add the declined-falls-through rule.
  - Remove the `NOTE:` on `createRecoverRequestHandler` (around lines 374-377), which cites this ticket.
- `stream-util.ts`: update the `requestResponse` and `handleRequestResponse` JSDoc.
- `host.ts#makeRequestHandler` doc (around lines 3173-3183): the dialer resolves an empty frame as `undefined`.
- `docs/cohort-topic.md` §Stream framing (around lines 1238-1241): "which the dialer resolves as empty bytes" becomes "which the dialer's `requestResponse` resolves as `undefined`".
- `docs/reactivity.md` lines 345 and 475 say "no served state → no reply → the subscriber re-walks / chain-reads". Make it accurate: a member with no served state declines, the transport tries the next cohort member, and only when every candidate declines does recovery reject and the subscriber re-walk or chain-read.

## Edge cases & interactions

- **Empty request vs. empty reply.** A handler still receives an empty request frame as a zero-length `Uint8Array`. Only the reply direction maps to `undefined`. A handler that deliberately returns `new Uint8Array(0)` produces `undefined` at the dialer.
- **Genuine failures stay distinguishable.** A throwing handler still aborts the stream, and the dialer still rejects with `FrameTruncationError`, never `undefined`. An over-ceiling reply still rejects with `PayloadTooLargeError`.
- **Recover: first member declines, second serves.** Success, with exactly 2 dials. Cover each decline reason reachable from `createRecoverRequestHandler`:
  - no served `PushState`;
  - a signature from the wrong key;
  - a replayed frame;
  - an undecodable request.
- **Recover: sticky primary declines, cohort-walk member serves.** Success. The primary is dialled first, then the walk member.
- **Recover: mixed failures.** Primary declines, walk member A fails to dial, walk member B serves: success, 3 dials.
- **Recover: every candidate declines.** Rejects with `NoResultReplyError` after dialling every candidate once. When the last candidate failed to dial instead, the rejection is that dial error.
- **Recover: first member declines, second returns `kind: "rotated"`.** `RotationRedirectError`, 2 dials. The redirect stays terminal after a fallthrough.
- **Recover: a non-empty but undecodable reply** (e.g. bytes `[0,0,0,2,0x7b,0x7b]`) stays terminal. It rejects after 1 dial and does not fall through.
- **Recover: kind mismatch** (backfill request answered with a resume reply) stays terminal after 1 dial.
- **Replay guard interaction.** Fallthrough resends the same signed frame to the next member. That works because each node's `CorrelationReplayGuard` is node-local (`RecoverServeDeps.replayGuard`, "Node-level freshness + anti-replay gate"). Add a `NOTE:` tripwire at the fallthrough site: if the replay guard is ever shared across a cohort, the retried frame would be rejected everywhere as a replay, and each fallthrough would need a freshly signed request.
- **Fallthrough latency.** Each decline costs one full round trip, so the worst case is one round trip per candidate. `selectTargets` bounds that to sticky primary + cohort size. No new timeout is needed. The existing `requestResponse` `NOTE:` about the missing `AbortSignal` already covers slow peers.
- **Membership fetch.** An empty-certificate responder (host membership handler with no published cert) gives `undefined`, and fetch tries the next member. When all return nothing, fetch resolves `undefined` and caches nothing.
- **Matchmaking query.** An unserved topic gives `undefined`, which maps to the benign empty advisory reply. `SeekerWalkClient` keeps walking.
- **Matchmaking register / topic-router `dialMember` / `dialSign`.** `undefined` rejects with `NoResultReplyError`:
  - `dialSign`: `collectFrom` swallows it, and the signer is not counted;
  - `dialMember`: the walk or renewal sees a failed dial;
  - `dialRegister`: `SeekerWalkClient.run` rejects, as it would on today's decode throw.
- **Compile-time coverage.** `packages/db-p2p/tsconfig.json` includes `test/`, so `tsc --noEmit` also flags the specs:
  - the gated integration spec's three `requestResponse` sites (around lines 886, 910, 1000) must narrow before decoding;
  - the line 911 assertion becomes `expect(noReply).to.equal(undefined)`.

## Key tests (expected outputs)

- `stream-util-framing.spec.ts`:
  - "a handler returning undefined resolves the dialer with `undefined`": replaces the empty-bytes assertion.
  - The empty-request test still checks the handler saw `length === 0`, but the reply is now `undefined`. Rename it to say an empty reply means no result.
  - New unit tests for `requireReply`: it returns the bytes when defined, and throws `NoResultReplyError` whose message includes the context when `undefined`.
- `recover-transport.spec.ts`:
  - `handlerDialer` (around line 301) and the two inline dialers (around lines 370 and 396) must stop throwing on `undefined` and pass it through. Today they throw, which hides the bug.
  - Add the recover edge cases above. The decline-then-serve case must fail on HEAD, where it rejects with a decode error after 1 dial.
- `membership-source`: add a `MockNode`-pair spec, following `stream-util-framing.spec.ts#makePair` and using `cohort-topic-mesh-harness.ts`'s `MockNode`. A resolver stub lists [declining peer, serving peer].
  - Expect `fetch` to return the serving peer's cert and cache it.
  - With every peer declining, expect `undefined` and nothing cached.
- `topic-router`: a `MockNode` pair whose `/register` handler returns `undefined`. Expect `dialMember` to reject with `NoResultReplyError`. `fret` can be `{} as never`; build `member.id` with `peerIdToBytes`.
- `query-transport-client.spec.ts`: this spec currently passes `node: {}` and never dials. Add a `MockNode`-pair case: the server registers `handleRequestResponse` on the query and register protocols, returning `undefined`, and `fretStub([serverPeerId])` routes the primary to it.
  - Expect `queryCohort` / `walkTransport(topicId).query(0)` to give the empty advisory reply.
  - Expect `walkTransport(topicId).register(0)` to reject with `NoResultReplyError`.
  - If `MockNode` cannot satisfy the transport's node usage, fall back to asserting the mapping through a narrower seam, and say so in the review handoff.
- `open-protocol-stream.spec.ts`: no assertion change. Update the `makeStream` comment (lines 24-25): the lone `0x00` reply now resolves `undefined`.

## TODO

- Change `requestResponse` to resolve `Uint8Array | undefined` (zero-length reply → `undefined`). Add `NoResultReplyError` and `requireReply`, and update the JSDoc on `requestResponse` and `handleRequestResponse`.
- Widen `RecoverDialer.exchange` to `Promise<Uint8Array | undefined>`. In `Libp2pReactivityRecoverTransport.exchange`, make a declined reply fall through. Add the replay-guard `NOTE:` tripwire, fix the recover module/class/method docs, and remove the stale `NOTE:` on `createRecoverRequestHandler`.
- Update `membership-source.fetch` and `query-transport.dialQuery` to check for `undefined`.
- Route `query-transport.dialRegister`, `topic-router.dialMember`, and host.ts `dialSign` through `requireReply`. Note in the `dialMember` JSDoc why db-core's port is not widened.
- Update host.ts `makeRequestHandler` doc, `docs/cohort-topic.md` §Stream framing, and `docs/reactivity.md` (the two "no reply → re-walks" sentences).
- Fix the compile errors in the gated integration spec and update the `open-protocol-stream.spec.ts` comment.
- Update `stream-util-framing.spec.ts`. Fix the recover spec's mirror dialers and add the recover edge-case tests. Add the membership-source, topic-router, and matchmaking-transport no-result tests.
- Run `yarn typecheck` and `yarn test` in `packages/db-p2p`, in the foreground. The integration suite is gated on `OPTIMYSTIC_INTEGRATION=1` and not required, but it must type-check.
