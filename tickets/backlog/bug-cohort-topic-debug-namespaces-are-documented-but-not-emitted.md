description: The debug-logging guide tells operators to switch on seven diagnostic channels for the cohort-topic subsystem, and to reach them under a name that no code uses. Four of the seven channels do not exist anywhere in the codebase, so an operator following the guide sees nothing and has no way to tell whether the subsystem is silent or simply never ran.
files: docs/debugging.md, packages/db-core/src/logger.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/change-bridge.ts, packages/db-p2p/test/logger.spec.ts
repro: static
severity: cosmetic
likelihood: normal-use
tradeoffs: Nobody is currently debugging cohort-topic, and a maintainer might reasonably want to add the missing log lines rather than delete the table rows describing them — which turns a ten-minute docs edit into an instrumentation task, and is a fair reason to defer until someone actually needs to trace that subsystem.
----

# `docs/debugging.md` documents cohort-topic log channels that no code emits

## What is wrong

`docs/debugging.md` has a "cohort-topic sub-namespaces" section that opens:

> The cohort-topic substrate logs under `optimystic:cohort-topic:*`.

and then tables seven channels: `cohort-topic:walk`, `:promote`, `:willingness`, `:handoff`,
`:antiflood`, `:antidos`, `:coldstart`.

Two things are wrong with that:

**The base name does not exist.** Nothing anywhere emits under `optimystic:cohort-topic:`. Each
package roots its channels in its own base (`optimystic:db-core:`, `optimystic:db-p2p:`), and
cohort-topic code is split across both. A later code block in the *same file* uses
`optimystic:db-core:cohort-topic:*`, contradicting the section heading — so the document disagrees
with itself, and an operator who copies the sentence rather than the code block gets silence.

**Four of the seven channels are not emitted by anything.** Searching the whole tree, the only
cohort-topic channels that exist are:

| Documented | Actually emitted |
|---|---|
| `cohort-topic:antiflood` | `optimystic:db-core:cohort-topic:antiflood` |
| `cohort-topic:antidos` | `optimystic:db-core:cohort-topic:antidos` |
| `cohort-topic:coldstart` | `optimystic:db-core:cohort-topic:coldstart` |
| `cohort-topic:walk` | *nothing* |
| `cohort-topic:promote` | *nothing* |
| `cohort-topic:willingness` | *nothing* |
| `cohort-topic:handoff` | *nothing* |

Those four strings occur in `docs/debugging.md` and nowhere else in the repository — not in any
package's source, and not in the `p2p-fret` dependency that provides part of this substrate.

Separately, `packages/db-p2p/src/cohort-topic/host.ts` and `change-bridge.ts` do emit —
under `optimystic:db-p2p:cohort-topic` and `optimystic:db-p2p:cohort-change-bridge` — and neither
appears in this section at all. So the section is simultaneously over- and under-stated.

## Why it matters

This is the same failure the debug documentation has already produced once: an outside reporter
(gotchoices/Optimystic#12) enabled the filter the docs named, saw zero lines, and concluded a code
path had never executed. Documented-but-absent channels are worse than an incomplete table,
because absence of output reads as evidence about the *system* rather than about the *docs*.

The walk → willingness → promotion → handoff lifecycle the table describes is the part of
cohort-topic an operator would most want to trace, so these are exactly the rows someone reaches
for first.

## Expected behavior

`docs/debugging.md`'s cohort-topic section names a base namespace that code actually uses, and
every row in its table corresponds to a channel some file emits. Whoever picks this up chooses
between two shapes:

- **Correct the docs to match the code** — drop the four phantom rows, fix the base namespace, and
  add the two db-p2p channels that are missing. Smallest change; leaves the walk/promotion/handoff
  lifecycle untraceable, which is the status quo.
- **Add the missing instrumentation** — implement the four channels the table promises, in
  whichever package owns each phase. Larger, and only worth it if someone is actually going to
  trace that lifecycle.

Either is a defensible answer; the ticket is filed against the discrepancy, not against a
particular resolution.

## Repro

Static — read from the source tree, not observed in a running system.

```bash
grep -rn "cohort-topic:walk" --include='*.ts' --include='*.md' . | grep -v node_modules
# -> docs/debugging.md only
```

Confirming it would mean running a cohort-topic workload under
`DEBUG='optimystic:cohort-topic:*'` and then under `DEBUG='optimystic:db-core:cohort-topic:*'`, and
observing that the first produces nothing at all and the second produces only the anti-flood /
anti-DoS / cold-start lines.

## Relationship to other work

Found while planning `logger-factory-error-and-formatters` /
`migrate-services-off-libp2p-logger-factory` / `lock-and-document-db-p2p-log-namespaces`, which fix
the same *class* of defect (a documented `DEBUG` filter that does not match the channels it claims)
in `db-p2p`'s service loggers. Those three tickets deliberately leave this section alone — different
packages, different root cause. The guard test the third of them adds checks only the db-p2p table,
so it will not catch this one.

## Arm added during review of `lock-and-document-db-p2p-log-namespaces`

That ticket landed a guard test that now checks the db-p2p table **in both directions** — every
channel the code creates has a row, and every row names a channel the code creates (plus: no
duplicate rows). It lives in `packages/db-p2p/test/logger.spec.ts`, under
`describe('db-p2p log-namespace guards')`, and both directions were mutation-proven. It is a
copyable template for the other three tables in the same file.

Checking the other tables by hand while reviewing that work turned up one more discrepancy, in the
same file and of the same class:

- **`### db-core sub-namespaces` is incomplete.** `packages/db-core/src` creates nine channels;
  the table lists four. `digest` and `trx:coordinator` appear nowhere in the guide. (The other
  three are `cohort-topic:antidos` / `:antiflood` / `:coldstart`, which are the ones this ticket is
  already about — they are documented, but under a base namespace nothing emits.)
- **`### quereus-plugin sub-namespaces` is correct** — four rows, four channels, exact match.
  Nothing to do there beyond wiring it to a guard so it stays that way.

So whoever picks this up is fixing three things in one file: the cohort-topic base name and its
four phantom rows (above), the two missing db-core rows, and — the part that stops all of it
recurring — extending the bijection guard to cover the db-core, cohort-topic and quereus-plugin
tables, not just db-p2p. The guard for a table owned by more than one package needs to scan more
than one package's `src/`, which is why it was not simply generalized in place during that review.
