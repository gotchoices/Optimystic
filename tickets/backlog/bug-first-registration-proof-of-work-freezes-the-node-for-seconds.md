description: A machine that starts watching a collection nobody was watching has to solve a small puzzle first, to show it is not flooding the network, and it does nothing else while it solves it — about four seconds on average and up to ten in measurements — which is now nearly the whole delay before the watch is live.
architecture: docs/cohort-topic.md#anti-dos
files: packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts, packages/db-core/src/cohort-topic/antidos/bootstrap-evidence-envelope.ts, packages/db-p2p/src/reactivity/subscription-manager.ts, docs/cohort-topic.md, docs/reactivity.md
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: The cost is deliberate — it is what stops a stranger from making many groups start serving topics for free — so any cheaper or interruptible form has to be weighed against that, and a maintainer may judge a few seconds once per newly watched log block acceptable.
----

# The proof of work for a first registration freezes the node for seconds

## What happens

The first registration under a topic nobody has registered under is a "cold start": the group of machines serving the topic has to begin holding state for it. To make that expensive for an abuser, a cold-start registration at the two highest operation tiers (T2 and T3) must carry a proof of work: a random number whose hash, together with the registration's own fields, starts with a required count of zero bits (20 by default, `DEFAULT_POW_DIFFICULTY_BITS` in `packages/db-core/src/cohort-topic/antidos/bootstrap-evidence-envelope.ts`). The registering machine finds that number by trying random ones until one works.

The search is the nonce loop in `createBootstrapEvidenceBuilder` (`packages/db-p2p/src/cohort-topic/bootstrap-evidence-builder.ts`). It is a plain `for` loop with no `await` inside it, so while it runs the machine's single JavaScript thread does nothing else: no network replies, no timers, no consensus votes, no user interface on a phone.

Reactivity registers at T3 (`ReactivitySubscriptionManager` in `packages/db-p2p/src/reactivity/subscription-manager.ts`), so every watch of a collection whose current log block nobody has registered under pays this, and pays it again each time the log starts a new block and the watch is the first to register at the new one.

## Measurements

Mint time, default difficulty. Twelve calls to the builder at tier 3, each timed with `Date.now()` around the call, on a Windows 11 development machine, Node 24.2.0:

```
445, 614, 624, 885, 893, 1233, 3028, 3293, 7267, 8410, 9329, 10379 ms — mean 3867 ms
```

The script built the builder with `createBootstrapEvidenceBuilder({ hash: new RingHash() })` and called it with a 32-byte topic id, `tier: 3`, a 38-byte participant id and the current time. The file's own header comment says the default is "sub-second"; on this machine it is not. The spread is inherent: the number of tries is geometrically distributed around `2^20`.

End-to-end. In `packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts`, "collection watch over real libp2p (every machine in every cohort)" (three machines in one process over real sockets, run with `OPTIMYSTIC_INTEGRATION=1` and `--grep "every machine in every cohort"`), the time from `watch()` to `isAttached` over 42 runs was 0.26 s to 16.7 s, 3.0 s at the median and 4.2 s on average. In every one of those runs the serving group answered the cold-start registration `accepted` within 22 to 111 ms of receiving it; the rest of the time fell between the reply to the plain registration and the arrival of the cold-start one, which is where the subscriber mints the proof.

Not measured: a phone. The loop is pure JavaScript hashing, so a slower engine would take proportionally longer; how much longer is unknown.

## Why it matters now

Until `feat-a-new-topic-admits-its-first-registration-without-a-second-ask` landed, the serving group declined a first registration and the watch attached on its next 30-second tick, which hid this cost. The group now admits on the same request, so the proof is the delay a user sees. Separately from the delay, a node that stops answering for several seconds can miss work others are waiting on: the register reply read on the other side allows 5 seconds, and the same thread serves cluster votes and block reads.

## Expected behaviour

Computing the proof must not stop the machine from doing its other work for seconds at a time, and the time it takes should be a chosen, documented number rather than an accident of the default: either the stated "sub-second" holds on ordinary hardware, or the documents say what it really costs. Whatever form it takes must keep the property the proof exists for — a cold start costs the asker real work that the serving group can check cheaply.

To confirm the report: time `createBootstrapEvidenceBuilder` at tier 3 with default options a dozen times, and, in the same process, observe that a `setInterval` callback does not fire while a mint is in progress.
