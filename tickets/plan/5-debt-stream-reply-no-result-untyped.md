description: When a peer answers a request with "I have nothing for you", the answer looks identical to a real but empty answer, so callers have to remember to check for it by hand — and one caller forgot, which makes a subscriber give up recovering instead of asking the next peer.
files: packages/db-p2p/src/cohort-topic/stream-util.ts, packages/db-p2p/src/reactivity/recover-transport.ts, packages/db-p2p/src/matchmaking/query-transport.ts, packages/db-p2p/src/cohort-topic/membership-source.ts
difficulty: medium
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The wrong behaviour needs a peer to decline a request (a signature/replay/foreign-collection rejection), which healthy cohorts do not do often, and the type change touches every caller of the shared request helper — a maintainer might prefer to add the one missing length check and move on.
----

# "No result" is not representable in the request/response helper's return type

## The shared seam

`packages/db-p2p/src/cohort-topic/stream-util.ts` provides the pair every single-frame protocol in
this package rides on:

```ts
requestResponse(node, peer, protocol, frame, maxBytes?): Promise<Uint8Array>

handleRequestResponse(node, protocol,
  handle: (frame, from) => Promise<Uint8Array | undefined>, maxBytes?): void
```

A serving handler says "I have no result for you" by returning `undefined` — a declined request, a
gate rejection, a topic this node does not serve, a decode failure it chose to swallow. The helper
turns that into an **empty reply** on the wire, and `requestResponse` resolves with a zero-length
`Uint8Array`.

The two outcomes therefore arrive at the caller as the *same value shape*. Nothing in the type
distinguishes "the peer declined" from "the peer answered, and the answer happened to be empty" —
each caller has to remember a `reply.length === 0` check, and nothing fails to compile when one
does not.

## The instance that motivated this

`packages/db-p2p/src/reactivity/recover-transport.ts` is the caller that does not check.

Its serve handler returns `undefined` on a verify / replay / decode failure, and its own comment
states the intent: *"log + no reply … the subscriber falls back"*. The dialing side
(`Libp2pReactivityRecoverTransport.exchange`) instead does:

```ts
replyFrame = await this.dialer.exchange(target, frame);   // resolves with 0 bytes
const reply = decodeRecoverReplyV1(replyFrame, this.maxBytes);  // throws on 0 bytes
```

`decodeCohortMessage` rejects a zero-length frame outright ("frame too short for length prefix"),
and that throw is **outside** the loop's dial-failure `catch`, so it propagates. The result: the
first cohort member that declines a recover request ends the whole recover walk, instead of the
subscriber trying the next member. A subscriber that could have been brought current from a healthy
sibling gives up.

This behaviour predates the move onto FRET's stream framing — the old read-to-end-of-stream path
produced the same empty buffer — so it is not a regression, but the framing work is what made the
"no result" contract explicit enough to notice.

## Why fix the representation rather than the one caller

Adding a length check to `recover-transport.ts` fixes today's instance and leaves the class open.
Two more callers are one edit away from the same defect:

- `matchmaking/query-transport.ts#dialRegister` decodes the reply with no empty check. Safe only
  because the `/register` serve handler happens to always return a frame.
- `cohort-topic/topic-router.ts#register` — same shape, same reason it is safe today.

`membership-source.fetch` and the matchmaking query dialer *do* check, so the codebase already
carries both habits side by side.

Making the outcome explicit — for example `requestResponse` resolving `Uint8Array | undefined`,
with `undefined` meaning "the peer sent a zero-length frame" — turns every one of those sites into a
compile error until it states what it wants to happen. The bad state stops being representable.

## Expected behaviour after the change

- A caller cannot consume a reply without acknowledging the "peer had no result" outcome.
- A recover request declined by one cohort member falls through to the next candidate, matching the
  serve handler's stated intent; only a genuine protocol error (a non-empty reply that fails to
  decode, or a `kind: "rotated"` redirect) stays terminal.
- The matchmaking and membership callers keep their current behaviour — they already treat an empty
  reply as "no result".

## Out of scope

Whether a peer that declines *should* be able to say more than "nothing" (an explicit reason code on
the wire) is a separate protocol question; this ticket only asks that the existing two-outcome
contract be visible in the types.
