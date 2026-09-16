description: Another application decides which of our failures are safe to retry by pattern-matching the text of our error messages. If anyone reformats those messages the match stops working, and that application silently stops retrying — no error, no warning, just writes that fail where they used to succeed.
files:
  - packages/db-core/src/transactor/network-transactor.ts (the four per-batch detail renderers: `get` line 290, `pend` line 577, `commitBlocks` line 928, `dischargeCancel` line 1142 — line numbers as of `c56c2bd4`)
  - packages/db-core/src/network/struct.ts (where a structured field on the aggregate would live)
difficulty: medium
tradeoffs: Nothing here is broken and no optimystic test can see the coupling, so a maintainer could reasonably decline and leave the burden downstream, where the fix (not parsing prose) properly belongs. The argument for acting anyway is that the failure is silent and lands on the consumer, not on us — we would never learn we had broken it.
----

# The coupling

Reported 2026-09-15 by the session tending **sereus**, which found it while grepping its own code for
something unrelated.

Sereus's `control-write-retry.ts` decides which transactor failures are safe to re-present. It has to
separate a failure in the **commit** phase from one in **get** or **pend**, because the retry safety
differs, and the only thing distinguishing them in what reaches the application is **our formatting
of the per-batch detail inside the aggregate error message**:

- `<peer>[block:<id>](<status>)` — rendered by `get` and `pend`
- `<peer>[blocks:<count>](<status>)` — rendered by `commitBlocks`

`[block:` cannot occur inside `[blocks:`, so the two tokens discriminate. Verified still true at
`c56c2bd4`.

# Why it is worth a ticket rather than a shrug

**The coupling fails closed, and it fails on their side.** Reformat those details and the match stops
firing; sereus's control writes then silently stop being retried. No exception, no log line saying the
classifier changed its mind — just lost retry absorption, and writes that fail where they used to
converge. Nothing in this repository would go red, because nothing here knows the format is load
bearing. That asymmetry is the whole argument: we would break it and never find out.

**Their own guard against it is currently red.** The scenario asserting the `[block:` token against a
live failure object (not a fixture — the right design) is
`control-write-degraded-cohort-member.integration.ts`, which is failing for unrelated timing reasons.
While it is red, nobody is checking the coupling at all.

# What is actually load-bearing — narrower than "our error text"

A first version of this ticket said the fourth renderer (`dischargeCancel`, line 1142, which also
emits `[block:`) cut against their discriminator. **It does not, and the reason matters**, because it
identifies the specific change to guard. Established by the reporting session and verified here
against `c56c2bd4`:

Their test is a **conjunction inside one message**, not a token search:
`/Some peers did not complete:/.test(message) && message.includes('[block:')`, applied per message
in the cause chain rather than to a flattened string. Only three sites raise that sentence — `get`
(line 293), `pend` (583) and `commitBlocks` (931). `dischargeCancel` raises a different sentence
entirely: `Cancel of action <id> did not discharge <n> block(s): …; peers: …` (line 1145), so it
fails the first half of the conjunction no matter what its per-batch detail renders. A second
mechanism excludes commit-phase failures before any matcher runs.

So what sereus depends on is precisely:

1. **`Some peers did not complete:` stays on the get / pend / commitBlocks aggregates, and does NOT
   appear on the cancel aggregate.**
2. **`[block:` and `[blocks:` stay disjoint** between the single-block paths and the commit-batch path.

Rewording the cancel aggregate is free. **Giving the cancel path the `Some peers did not complete:`
prefix — for consistency, say — would make a cancel fault classify as safe-to-retry.** That is the
change to guard, and it is exactly the kind of tidying that looks harmless in review. It is a better
thing to write at the sites than "don't touch the text".

# What to do

Two levels, and the cheap one does not depend on the other:

1. **Mark the sites** — with the specific rule, not a vague warning. At the three aggregates (293,
   583, 931): this sentence plus the `[block:` / `[blocks:` token is how a downstream consumer
   (sereus's `control-write-retry.ts`) tells a retry-safe get/pend failure from a commit failure. At
   the cancel aggregate (1145): **do not give this the `Some peers did not complete:` prefix** — that
   sentence is the consumer's discriminator, and adopting it here would make an undischarged cancel
   classify as safe to retry. Comment-only, cheap enough to fold into any ticket that touches this
   file. It does not *prevent* the breakage, but it puts the exact hazard in front of whoever is
   about to cause it.
2. **Remove the need to parse prose.** Put the phase on the aggregate as a **field** — `get` / `pend`
   / `commit` / `cancel` — so a consumer branches on a value instead of a regex over a message.
   Their session named this as the better answer and explicitly did not file it against us; it is
   ours to decide. Note that this is the same shape as two other decisions in flight: the durability
   class 6.41 gave writes, and the "report that a read's answer is local" option in
   `backlog/more-design/a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds`. In
   each case the fix is to say a thing in a field that the consumer currently has to infer.

# Standing rule this suggests

We now have two live examples of a dependent repository binding to something we do not consider an
interface: our **operation counts** (used as a latency lever in a bring-up scenario) and our **error
message text** (used as a phase discriminator). Both fail without failing anything here. The practical
response, short of machinery, is that a handoff touching either should say so — the same way a
breaking type change would be called out.

# Arm, 2026-09-16 — our own test now parses the promise-shortfall text too

`packages/db-p2p/test/transaction-node-count-sweep.spec.ts` (ticket `transaction-sweep-across-node-counts`) asserts what an application sees when a write is refused because one of two or three machines is away. There is no typed error or field for it: `Tree.replace` rejects with the transactor's plain `Error` (`Some peers did not complete: …`), whose `cause` is the coordinator's plain `Error('Failed to get super-majority: a/n approvals (needed k, r rejections)')`. It is not a `SyncRetryExhaustedError` and not a returned conflict, so `Collection.sync` does not retry it. The only way to get the numbers an application would branch on (how many approved, how many were needed) is a regex over that `cause` message, which is what the sweep does. If the phase field described above lands, give the shortfall's counts a field too and switch the sweep's assertion to it.

A side effect worth knowing when weighing this ticket's `tradeoffs:` line ("no optimystic test can see the coupling"): the sweep also asserts that the pend aggregate's message starts with `Some peers did not complete: `, so rewording the `pend` sentence now turns one test in this repository red. It does not cover `get` or `commitBlocks`, and it does not check the `[block:` token.
