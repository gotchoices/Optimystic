description: When a peer answers a request with "I have nothing for you", callers now receive a distinct value the compiler forces them to handle instead of look-alike empty bytes, and a reactivity subscriber whose first chosen peer declines now asks the next peer instead of giving up on recovery.
files: packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/reactivity/recover-transport.ts, packages/db-p2p/src/cohort-topic/membership-source.ts, packages/db-p2p/src/cohort-topic/topic-router.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/matchmaking/query-transport.ts, packages/db-p2p/src/reactivity/forwarder-host.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/cohort-topic/stream-util-framing.spec.ts, packages/db-p2p/test/cohort-topic/membership-source.spec.ts, packages/db-p2p/test/cohort-topic/topic-router.spec.ts, packages/db-p2p/test/reactivity/recover-transport.spec.ts, packages/db-p2p/test/matchmaking/query-transport-client.spec.ts, packages/db-p2p/test/open-protocol-stream.spec.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, docs/cohort-topic.md, docs/reactivity.md, docs/matchmaking.md
----

# Complete: "no result" is a distinct reply value in the request/response helper

## What landed

`requestResponse` in `packages/db-p2p/src/cohort-topic/stream-util.ts` sends one request frame and reads one reply frame. It now resolves `Promise<Uint8Array | undefined>`:
- A zero-length reply frame (a serving handler's "no result") resolves as `undefined`.
- A returned `Uint8Array` is never empty.
- Genuine failures still reject: a dial failure, `FrameTruncationError` when the serving handler threw, and `PayloadTooLargeError` for an over-ceiling reply.

Only the reply direction changed; an empty request still reaches a handler as zero-length bytes.

Two new exported helpers:
- `NoResultReplyError`, the error for a missing reply.
- `requireReply(reply, context)`, which unwraps a reply for protocols whose responder always answers.

Each caller now states what "no result" means:

| Caller | On no result |
|---|---|
| Reactivity recover transport (`Libp2pReactivityRecoverTransport.exchange`) | Tries the next cohort candidate. **This is the bug fix**: before, one declining member ended the whole recovery. |
| `FretMembershipSource.fetch` | Tries the next member (unchanged). |
| Matchmaking `dialQuery` | Benign empty advisory reply (unchanged). |
| Matchmaking `dialRegister`, `FretTopicRouter.dialMember`, host `dialSign` | `requireReply` rejects with `NoResultReplyError`. Before, decoding empty bytes threw an anonymous error. |

Outcomes in the recover loop:
- **Falls through:** a dial failure or a decline tries the next candidate.
- **Terminal:** a non-empty reply that fails to decode, a `kind: "rotated"` redirect, or a reply of the wrong kind.
- **All candidates exhausted:** it rejects with the last candidate's outcome.

## Review findings

### What was checked
- Read the full implement diff (`2b693f2c`) before the handoff summary.
- Grepped every `requestResponse`, `RecoverDialer`, `requireReply` and `NoResultReplyError` use across `packages/`. Every `requestResponse` caller is inside `db-p2p` and handles the new `undefined`; `createLibp2pRecoverDialer` is the only production `RecoverDialer`.
- Checked that the "responder always writes a frame" claims hold for `/register` and `/sign` in `host.ts#registerCohortTopicProtocols`, via `makeRequestHandler`. The membership responder returns `new Uint8Array(0)`, which gives the same wire signal as `undefined`, and the new membership-source test covers it.
- Checked that `threshold-crypto.ts#collectFrom` catches a `dialSign` rejection and counts no signature (a `try` around `withTimeout(dialSign)`).
- Checked the db-core callers of `dialMember`: renewal `trySend` counts a rejection as a failed ping; the walk does not catch it (see below).
- Read the new recover tests: per-reason declines, mixed decline/dial-failure/serve, all-decline, last-candidate dial error, decline-then-rotated, undecodable reply, wrong kind, plus the end-to-end `MockNode` wiring through the production dialer and handler. They cover happy, edge, error and interaction paths. The implementer's revert experiment (12 tests fail with `frame too short for length prefix` at the old behaviour) confirms they catch the bug.
- Grepped docs and `db-p2p/src` for stale "no reply / empty bytes / 0-byte / stream aborts" wording tied to the changed semantics.

### Validation run
- `yarn workspace @optimystic/db-p2p typecheck`: clean.
- `yarn workspace @optimystic/db-p2p test`: **2755 passing, 62 pending, 0 failing** (the same pending set as the implement handoff).
- **Integration gap closed:** `OPTIMYSTIC_INTEGRATION=1` run of `test/substrate-real-libp2p.integration.spec.ts` gave **11 passing, 2 pending**. Both pending tests are existing `unimplemented:` / `covered at …` markers. The three updated `requestResponse` sites, including the unserved-topic `undefined` assertion, pass over real sockets. The implementer had listed this as not run.
- `npx eslint` on every touched source and test file: clean. `yarn lint:docs`: all citations resolve.

### Found and fixed inline (minor)
- **Stale comments still described a decline as "no reply; the stream aborts; the subscriber re-walks".** Fixed in:
  - `libp2p-node-base.ts`, the recover handler wiring comment;
  - `forwarder-host.ts#rotationRedirectFor` JSDoc;
  - `recover-transport.ts#verifyAndAdmit` JSDoc, plus its three serve-side log strings, which now say `(declined)`.
- **`query-transport.ts` module docblock** said a no-engine query produces "no reply frame". It now says no result (a zero-length reply), and the stale "the seeker ticket owns that mapping" aside is dropped.
- **`topic-router.ts#dialMember` JSDoc** said the walk "already treats [the rejection] as a failed dial". The walk has no catch around its direct dial, so it now says the rejection reaches the caller exactly as a dial failure does (renewal counts a failed ping; the walk's direct dial propagates it).
- **`host.ts#makeRequestHandler` JSDoc:** a line the implementer lengthened was rewrapped to match the surrounding comment width.

### Major: filed as a ticket
- **`backlog/bug-walk-direct-dial-failure-aborts-register`.** In db-core `walk.ts`, the `unwilling_member` retry calls `router.dialMember` with no failure handling. An unreachable or no-result sibling therefore rejects out of `register`, `lookup` or `relookup`, instead of trying the next named candidate or backing off, even though `ports.ts` documents a fallback. This was already true before this change (empty bytes also threw, in `decodeRegisterReplyV1`), so behaviour is unchanged here. It is the remaining instance of the same class this ticket fixed for recovery ("one member failing ends a multi-candidate walk"). The site check found no open ticket touching `walk.ts` or `dialMember`. Considered the architecture ladder: no type or representation change makes this unrepresentable, since a dial can always fail, so this is a point ticket.

### Tripwires (parked by the implementer, confirmed appropriate)
- `recover-transport.ts#exchange`: resending the same signed frame on fallthrough relies on each node's replay guard being node-local. Parked as a `NOTE:` at the site.
- `stream-util.ts#requestResponse`: every zero-length reply means "no result", so a protocol needing an "empty" data reply must use a non-empty envelope. Parked as a `NOTE:` at the site.

### Considered, no action
- **`dialSign` has no dedicated no-result test.** The change is a single `requireReply` call. `requireReply` is unit-tested, and `collectFrom` swallows every rejection from the dial. `dialSign` is a closure inside `createCohortTopicHost`, so testing it means standing up a host, which is disproportionate to the risk.
- **Two recover decline reasons are simulated per member in tests.** The bad-signature case changes the dialing peer and the undecodable case uses a smaller ceiling. Both still drive the unmodified production handler. That is a sound way to exercise one member declining while others serve, since in production a bad signature or oversize request is declined by every member alike.
- **Public API widening of `requestResponse`.** It is source-breaking for external consumers that read the bytes without narrowing, but no in-repo consumer outside `db-p2p` exists. Accepted as the point of the change: the compiler now forces the decision.
- **Recover latency.** Each decline costs one round trip before the next candidate. This is bounded by the sticky primary plus the cohort size, and slow peers are covered by the existing `NOTE:` about `requestResponse` taking no `AbortSignal`. No action.
- **`dialQuery` still folds decode and dial failures into the empty advisory reply.** Unchanged by this ticket, documented at the site, and intentional (advisory walk).
- **db-core `ITopicRouter.dialMember` stays `Promise<Uint8Array>`.** The rationale is recorded in its JSDoc; it is reasonable because only a non-conforming peer produces a no-result there.
- **Type safety, resource cleanup, performance:**
  - Stream cleanup in `requestResponse` is unchanged (`finally` still closes/aborts).
  - No new allocations beyond one error object per decline.
  - `NoResultReplyError` sets `name` for cross-realm checks.
  - `topic-router.ts` imports it as `type` only for a JSDoc `{@link}`, which lint and typecheck accept.
