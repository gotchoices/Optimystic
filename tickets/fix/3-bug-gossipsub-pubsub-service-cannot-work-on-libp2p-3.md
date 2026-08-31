description: Every node we build registers a message-broadcast service that cannot function — it was written for an older version of the networking library and throws on every outbound message. Nothing in this project uses it, so the breakage is invisible here, but we ship it in the default service set and any consumer who reaches for it gets silent failure plus continuous error logging.
prereq:
files:
  - packages/db-p2p/src/libp2p-node-base.ts:8 (the import), :580 (`pubsub: gossipsub({...})` in the default service set)
  - packages/db-p2p/package.json:73 (`@chainsafe/libp2p-gossipsub: ^14.1.2`), :98 (`libp2p: ^3.1.3`)
  - packages/quereus-plugin-optimystic/package.json:53 (same dependency, second copy)
  - packages/db-p2p/test/node-service-set.spec.ts:39,56 (the spec that pins `pubsub` into the expected service set)
difficulty: medium
repro: verified by dependency resolution at HEAD; runtime failure reported upstream with a stack trace
severity: wrong-result
likelihood: certain-for-any-consumer-that-uses-pubsub
tradeoffs: Nothing in this repo publishes or subscribes, so we have no failing test and never will until something uses pubsub — a maintainer could reasonably leave a broken service registered rather than change the default service set on the eve of a release. Against that: it logs an error on every outbound stream, and a consumer cannot tell from the outside that the service is dead.
----

# The `pubsub` service in our default service set cannot work on libp2p 3

## Reported

GitHub issue #9 (`aarashrestha`), against `@optimystic/db-p2p@0.17.0`. Open, unanswered, filed a
month ago. **Verified still live at HEAD** — see below.

## What is wrong

`@chainsafe/libp2p-gossipsub@14` was built against libp2p 2.x, where `Stream` was an it-duplex with
`.source` / `.sink`. In libp2p 3.x `Stream` extends `MessageStream` and has neither. gossipsub's
`OutboundStream` constructor still hands the raw stream to `it-pipe`, which detects duplexes
*structurally* — so the detection silently fails, the stream stays in the pipeline as a plain object,
and `it-pipe` then tries to call it:

```
libp2p:gossipsub:error createOutboundStream error TypeError: fns.shift(...) is not a function
    at rawPipe (.../it-pipe/dist/src/index.js:37:26)
    at new OutboundStream (.../@chainsafe/libp2p-gossipsub/dist/src/stream.js:20:9)
```

This fires on **every** outbound gossipsub stream, and gossipsub's own error handler swallows it —
so the service reports as running while delivering nothing.

Semver does not catch it: gossipsub declares `@libp2p/interface: ^2.0.0` as a regular dependency
rather than a peer dependency, so the package manager installs a nested v2 copy beside the host's v3
and reports no conflict.

## Verified at HEAD (2026-08-31)

`yarn why @libp2p/interface` — the split is exactly as reported, and ours is the only v2 in the tree:

```
@chainsafe/libp2p-gossipsub@npm:14.1.2
  @libp2p/interface@npm:2.11.0 (via npm:^2.0.0)      <- the odd one out
@chainsafe/libp2p-noise@npm:17.0.0
  @libp2p/interface@npm:3.1.0
@libp2p/circuit-relay-v2@npm:4.1.3
  @libp2p/interface@npm:3.1.0
```

`@chainsafe/libp2p-gossipsub` is still at `^14.1.2` in two workspaces, and `libp2p` is at `^3.1.3`.
**There is no fix upstream to upgrade to**: `npm view @chainsafe/libp2p-gossipsub versions` ends at
`14.1.2`. No 15.x exists.

## Why it has been invisible

`grep -rn "pubsub" packages/*/src` returns exactly one production hit — the registration itself at
`libp2p-node-base.ts:580`. **Nothing in this repository publishes or subscribes.** Cohort-topic
gossip, push-state gossip and every other broadcast path use their own protocols registered through
`node.handle`, not pubsub. The only other mention is `node-service-set.spec.ts`, which asserts
`pubsub` is *present* in the service set — a test that passes precisely because it checks
registration rather than function.

So this cannot fail our suite, today or ever, until something here uses pubsub. That is why it has
sat open for a month.

## Why it still matters for the release

We publish `db-p2p`, and its default node builder registers this service. A consumer who reaches for
`services.pubsub` gets silence, not an error they can act on, plus an error line per outbound stream
in their logs. We are shipping a component that is guaranteed not to work.

## Options — pick one, they are not equivalent

1. **Remove `pubsub` from the default service set.** Nothing here uses it and it cannot work, so this
   removes a guaranteed-broken component rather than a working one. It is an API change for any
   consumer expecting the key, but the alternative is that they keep a service that silently drops
   every message. `node-service-set.spec.ts` would need updating — do that by *changing the
   expectation deliberately*, not by deleting the assertion.
2. **Keep it and make the failure loud.** If it is registered, a consumer should learn at startup
   that it is non-functional on this stack rather than by absence of delivery.
3. **Make it optional** — off by default, opt-in for anyone who has verified their own stack.

Recommended default: **option 1**, with the removal called out in the release notes so a consumer
relying on it is not surprised silently. Option 3 is a reasonable second if you want to preserve the
key.

Whichever is chosen, say so on issue #9 — it deserves an answer either way, and the reporter did the
work of proving the mechanism.

## Out of scope

Fixing gossipsub itself is upstream (ChainSafe). If you want that path, it is a separate ticket
against a different repository and needs an upstream release before it helps anyone.

## TODO

- [ ] Decide among the options above (default: remove from the service set)
- [ ] Update `node-service-set.spec.ts` to match the decision, deliberately
- [ ] Drop the dependency from both `package.json`s if removed
- [ ] Release-note the change
- [ ] Reply to GitHub issue #9 with the decision and the verification
