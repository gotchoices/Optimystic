description: Four tests that start real networked machines run as part of the ordinary fast test command, where every other networked test is opt-in. They take a long time and can fail for timing reasons that have nothing to do with the change being tested, which trains everyone to shrug at a red run.
files:
  - packages/db-p2p/test/fresh-node-ddl-libp2p.spec.ts (real `createLibp2pNode`, 30 s timeout, not `.integration.spec.ts`)
  - packages/quereus-plugin-optimystic/test/distributed-quereus.spec.ts (three real nodes, 120 s)
  - packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts (three real nodes, 120 s)
  - packages/reference-peer/test/distributed-diary.spec.ts (three real nodes on fixed ports; the entry in tickets/.pre-existing-known.md is about this spec)
  - AGENTS.md (§ Testing — the three-tier description: plain `yarn test`, `test:integration` gated on OPTIMYSTIC_INTEGRATION=1, and the self-gating long specs)
difficulty: easy
tradeoffs: These specs are the only real-socket transaction coverage that runs without an env var, so moving them behind the integration gate means the default lane loses its only end-to-end signal — a maintainer may prefer to keep them where a regression is seen immediately and accept the occasional timing failure.
----

# What is going on

This repository has three test tiers, described in AGENTS.md § Testing: the fast lane (`yarn test`), the real-socket lane (`test:integration`, gated on `OPTIMYSTIC_INTEGRATION=1`), and specs that gate themselves on their own env var because they are too slow for either.

Four specs that start real libp2p nodes and drive real transactions sit in the fast lane anyway. They are named `*.spec.ts` rather than `*.integration.spec.ts`, so nothing gates them, and they carry timeouts of 30 to 120 seconds.

One of them already has a standing entry in `tickets/.pre-existing-known.md`: the reference-peer three-node concurrent-writes case, which passes normally but can fail when timing makes every writer lose the first-append race. That entry is the shape of the problem — a timing-dependent real-socket failure in the lane people run constantly, which becomes noise to be recognised rather than a signal to be chased.

# Why it matters now

The maintainer's focus is transactions across node counts. Two of these four specs are among the very few places where three real machines run real transactions, so their result carries weight; that is exactly why it should not be ambiguous. A failure in the fast lane should mean "your change broke something", and today it can also mean "the sockets were unlucky".

# What a resolution looks like

Decide, per spec, which tier it belongs to, and make the name match the tier so the rule is visible rather than remembered:

- Keep it in the fast lane only if it is deterministic enough to be trusted there, and say what makes it so.
- Otherwise rename to `*.integration.spec.ts` and let `test:integration` own it — but then note what the fast lane loses, and whether anything should replace that signal (the in-process sweep in `implement/1-transaction-sweep-across-node-counts` covers some of it).
- If a spec is valuable but slow, the third tier exists: gate it on its own env var with the command in its header comment, as the relay and DCUtR specs do.

Whatever is decided, AGENTS.md § Testing should describe the resulting rule, and the `.pre-existing-known.md` entry should be revisited: an intermittent failure parked indefinitely in the fast lane is the cost this ticket is about.
