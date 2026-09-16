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

# A detail they may not have accounted for

There are **four** renderers, not three, and the fourth cuts against the discriminator: `dischargeCancel`
(line 1142) also renders `[block:`. So an aggregate originating in the cancel path classifies as
get/pend under their rule. Whether that can reach an application depends on whether a cancel's own
failure surfaces as the aggregate or rides along as `cancelError` (see `TransactorSource.transact`,
which deliberately attaches rather than replaces) — worth establishing, and worth telling them either
way, because it is the kind of thing a regex over prose cannot see.

# What to do

Two levels, and the cheap one does not depend on the other:

1. **Mark the sites.** A short comment at each of the four renderers saying the token shape is parsed
   by a downstream consumer (sereus's `control-write-retry.ts`) and must not be reformatted casually.
   That is a comment-only change, cheap enough to fold into any ticket that touches this file. It
   does not *prevent* the breakage, but it puts the fact in front of the person doing it.
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
