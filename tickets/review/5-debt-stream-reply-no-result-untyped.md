description: When a peer answers a request with "I have nothing for you", callers now receive a distinct value the compiler forces them to handle instead of look-alike empty bytes, and a reactivity subscriber whose first chosen peer declines now asks the next peer instead of giving up on recovery.
files: packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/reactivity/recover-transport.ts, packages/db-p2p/src/cohort-topic/membership-source.ts, packages/db-p2p/src/cohort-topic/topic-router.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/matchmaking/query-transport.ts, packages/db-p2p/test/cohort-topic/stream-util-framing.spec.ts, packages/db-p2p/test/cohort-topic/membership-source.spec.ts, packages/db-p2p/test/cohort-topic/topic-router.spec.ts, packages/db-p2p/test/reactivity/recover-transport.spec.ts, packages/db-p2p/test/matchmaking/query-transport-client.spec.ts, packages/db-p2p/test/open-protocol-stream.spec.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, docs/cohort-topic.md, docs/reactivity.md, docs/matchmaking.md
----

# Review: "no result" is a distinct reply value in the request/response helper

## Background

Every single-frame request/response protocol in `db-p2p` goes through `requestResponse` / `handleRequestResponse` in `packages/db-p2p/src/cohort-topic/stream-util.ts`. A serving handler that has nothing to say returns `undefined`, and the helper sends a zero-length frame, because the reader treats end-of-stream as an error. Before this change the dialer got that frame back as an empty `Uint8Array`, the same type as a real reply, so every caller had to remember a `length` check.

The reactivity recover transport forgot to check. When a cohort member declined a backfill/resume request (no served state, a failed signature or replay check, an undecodable request), `Libp2pReactivityRecoverTransport.exchange` decoded the empty bytes, got "frame too short", and that throw ended the whole recover walk. The first member that declined stopped recovery, even when other members could have served.

## What changed

**The helper.** `requestResponse` now resolves `Promise<Uint8Array | undefined>`:
- a zero-length reply frame resolves as `undefined`;
- a returned `Uint8Array` is never empty;
- genuine failures still reject with the same error types: a dial failure, `FrameTruncationError` when the serving handler threw, and `PayloadTooLargeError` for an over-ceiling reply.

Only the reply direction changed. A handler still receives an empty request as zero-length bytes, and the `handleRequestResponse` handler signature is unchanged. Its JSDoc now says that returning `new Uint8Array(0)` is the same wire signal as returning `undefined`, which is how host.ts's membership responder says "no certificate". That responder was left as it is.

**New helpers** in `stream-util.ts`, also exported publicly through `cohort-topic/index.ts`'s `export *`:
- `NoResultReplyError`: its `name` is `"NoResultReplyError"` and its message includes a context string.
- `requireReply(reply, context)`: returns the bytes, or throws `NoResultReplyError` when the reply is `undefined`.

**Each call site now states what "no result" means:**

| Call site | On `undefined` | Behaviour vs before |
|---|---|---|
| `reactivity/recover-transport.ts` `Libp2pReactivityRecoverTransport.exchange` | Sets `lastErr = new NoResultReplyError(...)`, logs, and tries the next candidate | **Fixed.** Previously a terminal decode error |
| `cohort-topic/membership-source.ts` `fetch` | Tries the next member (`reply !== undefined`) | Unchanged |
| `matchmaking/query-transport.ts` `dialQuery` | Returns the benign empty advisory reply (`frame === undefined`) | Unchanged |
| `matchmaking/query-transport.ts` `dialRegister` | `requireReply(frame, "matchmaking register")` throws | Still a rejection, now a named one |
| `cohort-topic/topic-router.ts` `dialMember` | `requireReply(reply, "cohort-topic register dial")` throws | Still a rejection, now a named one |
| `cohort-topic/host.ts` `dialSign` | `requireReply(reply, "cohort sign")` throws; `threshold-crypto.ts#collectFrom` catches it and counts no signature | Unchanged |

`RecoverDialer.exchange` was widened to `Promise<Uint8Array | undefined>`, and `createLibp2pRecoverDialer` passes the result straight through. db-core's `ITopicRouter.dialMember` port deliberately stays `Promise<Uint8Array>`; the reason is recorded in the JSDoc on `FretTopicRouter.dialMember`.

After the change, the recover `exchange` loop classifies each outcome as follows:
- **dial rejection:** fall through (unchanged);
- **declined (`undefined`):** fall through (new);
- **non-empty reply that fails to decode:** terminal;
- **`kind: "rotated"`:** terminal `RotationRedirectError`;
- **kind mismatch:** terminal;
- **all candidates exhausted:** throw the last outcome. That is `NoResultReplyError` if the last candidate declined, or its dial error if it failed to dial.

**Comments and docs corrected:**
- `recover-transport.ts`: the module docblock (it wrongly said a decline "aborts the stream"), the class doc, the `exchange` JSDoc, the `RecoverDialer` JSDoc, the serve-handler comments, and removal of the stale `NOTE:` on `createRecoverRequestHandler` that cited this ticket.
- `host.ts#makeRequestHandler` doc.
- `docs/cohort-topic.md` §Stream framing.
- `docs/reactivity.md`: both "no served state → no reply → re-walks" sentences, which now say decline → next member → reject only when all decline.
- `docs/matchmaking.md`: the 0-byte-frame mention on the line near 922.

## Validation done

- `yarn workspace @optimystic/db-p2p typecheck` is clean. The tsconfig includes `test/`, so the gated integration spec type-checks too.
- `yarn workspace @optimystic/db-p2p test` (full suite): **2755 passing, 62 pending, 0 failing.** The pending tests were already pending before this change; no test was skipped or loosened.
- **Proof that the new tests catch the bug.** I temporarily made the recover loop decode a declined reply as empty bytes again, which is what HEAD did, and ran `recover-transport.spec.ts`.
  - 12 of the new tests failed, all with `CohortWireError: frame too short for length prefix`, the HEAD failure the ticket describes.
  - The two tests that must stay terminal (undecodable reply, wrong kind) still passed.
  - The change was then removed.

## Tests to look at (use cases)

`test/cohort-topic/stream-util-framing.spec.ts`:
- a handler returning `undefined` resolves the dialer with `undefined`;
- an empty request reaches the handler as empty bytes, while a handler returning `new Uint8Array(0)` resolves the dialer with `undefined`;
- a throwing handler still gives `FrameTruncationError`, and an over-ceiling reply still gives `PayloadTooLargeError`;
- new `requireReply` unit tests: it returns the same bytes, or throws `NoResultReplyError` with the context in the message.

`test/reactivity/recover-transport.spec.ts`:
- The existing mirror dialers no longer throw on `undefined`. They pass it through, as the production helper does; the old throw is what hid the bug.
- New describe "a declining member falls through to the next candidate", using a per-target dialer that records `declined` / `replied` / `dial-failed`:
  - one test per decline reason reachable from `createRecoverRequestHandler`: no served `PushState`, a signature that doesn't verify against the dialing peer, a replayed frame, an undecodable request;
  - resume fallthrough;
  - sticky primary declines, then the walk member serves;
  - mixed: decline, then dial failure, then serve (3 dials);
  - every candidate declines, giving `NoResultReplyError` with each candidate dialled once;
  - the last candidate fails to dial, giving that dial error;
  - decline followed by `kind: "rotated"`: still terminal, and the walk stops before the third member;
  - a non-empty undecodable reply is terminal after 1 dial;
  - a kind mismatch is terminal after 1 dial.
- New describe "declines over the real request/response framing": in-process `MockNode`s wired with the **production** `createLibp2pRecoverDialer` + `registerRecoverHandler`.
  - A decliner then a server gives success, with a counter proving the decliner was really reached.
  - With every member declining, recovery rejects with `NoResultReplyError`.

`test/cohort-topic/membership-source.spec.ts` (new):
- [member with no certificate, holder]: fetch returns and caches the holder's cert.
- All members with no certificate: fetch returns `undefined` and caches nothing.
- The responders use both `undefined` and `new Uint8Array(0)`.

`test/cohort-topic/topic-router.spec.ts` (new):
- `dialMember` returns the `/register` reply bytes.
- A no-result reply rejects with `NoResultReplyError`, with a counter proving the handler ran, so it is not a dial failure.

`test/matchmaking/query-transport-client.spec.ts`: a new `MockNode`-pair case in which the remote primary returns no result on both protocols.
- `queryCohort` and `walkTransport(topicId).query(0)` both give the empty advisory reply.
- `walkTransport(topicId).register(0)` rejects with `NoResultReplyError`.
- A server-side call log proves every dial reached the handler. That separates the no-result branch from the dial-failure `catch`, which also returns an empty reply.
- `MockNode` satisfied the transport's node usage, so no narrower seam was needed.

## Known gaps and judgement calls (reviewer: start here)

- **The integration suite was not run.** `substrate-real-libp2p.integration.spec.ts` is gated on `OPTIMYSTIC_INTEGRATION=1`. Its three `requestResponse` sites were updated and type-check, but they have not been executed against real sockets:
  - the two served-reply sites now assert the frame is not `undefined` before decoding;
  - the unserved-topic site now asserts `undefined`.
- **Two recover decline reasons are simulated per member.** In production every member receives the identical signed frame, so a truly bad signature or an oversized request would be declined by *every* member. To make only the first member decline, the tests change what that member sees:
  - "signature doesn't verify": the handler is invoked with a different dialing peer id;
  - "undecodable request": the member has a smaller frame ceiling (`maxBytes: 8`).

  Both still drive the real, unmodified `createRecoverRequestHandler`. The no-state and replay reasons need no simulation, because the replay case relies on each node's own replay guard.
- **`dialSign` has no dedicated no-result test.** The change is one `requireReply` call, and `collectFrom` already swallows any rejection. The ticket did not ask for a test, but a reviewer may want one next to `threshold-assembly.spec.ts`.
- **Public API widening.** `requestResponse` is re-exported from the package through `cohort-topic/index.ts`. Its return type change is source-breaking for any *external* consumer that uses the bytes without narrowing. A grep of `packages/` found no consumers outside `db-p2p`.
- **Recover latency.** Each decline now costs one full round trip before the next candidate is tried. The worst case is one round trip per candidate, bounded by sticky primary + cohort size. No new timeout was added, per the ticket; the existing `NOTE:` on `requestResponse` about the missing `AbortSignal` covers slow peers.
- **Not changed (out of scope):** `dialQuery` still folds a decode error or dial failure into the same empty advisory reply as a genuine no-result. That behaviour is unchanged and documented.

## Tripwires parked (as `NOTE:` comments)

- `recover-transport.ts`, at the fallthrough in `exchange`: the resend of the same signed frame only works because each node's `CorrelationReplayGuard` is node-local. If the guard is ever shared across a cohort, every fallthrough would need a freshly signed request.
- `stream-util.ts`, at the zero-length → `undefined` mapping in `requestResponse`: every empty reply is treated as "no result". If a protocol ever needs to return "empty" as data, it must use a non-empty envelope.
