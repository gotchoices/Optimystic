description: On React Native there is no way to turn our debug logging on at all, and nothing says so — a capture comes back empty whether the code ran or not. Two app teams debugging a real problem on phones drew wrong conclusions from empty logs before finding out. A second, smaller gap compounds it: one of our log lines already carries the field that tells a reader which of two very different situations they are looking at, and nothing documents it, so a reporter measured the wrong thing and had to retract a defect claim.
prereq:
files:
  - packages/db-p2p/src/logger.ts (imports the `debug` module; registers `%p`/`%e`/… formatters on that instance; its NOTEs already describe the multi-registry hazard)
  - docs/debugging.md (documents `DEBUG=` and nothing else — line 42 onward, and the worked examples at 151, 154, 178, 405)
  - packages/db-p2p/src/repo/coordinator-repo.ts:812 (emits `ageMs` on `cluster-tx:read-repair-triggered`)
  - packages/db-p2p/src/repo/coordinator-repo.ts:1077 (`ageMs()` returns `undefined` when `lastSeen` is null — the property then vanishes from the JSON)
difficulty: medium
tradeoffs: A programmatic enable is a new public surface on a logging system we otherwise expose only through an environment variable, and it has to work without us being able to test React Native in this repo's CI. The alternative — document the limitation and let consumers reach for `debug` themselves — is cheaper but does not actually work, because the consumer's copy of `debug` is not necessarily ours.
----

# React Native consumers cannot turn logging on, and an empty capture looks identical to a capture of nothing happening

## Reported

Found and reported by `risavian` on GitHub issue #8 (2026-09-10), as an aside inside a device-profiling comment, after it cost them real time:

> One wrinkle for anyone reproducing on React Native: nothing enables `debug` on RN at all. The browser build reads `localStorage`, which RN lacks — the read throws inside debug's own try/catch and is swallowed — and its only fallback is `process.env.DEBUG`, which Metro never sets. So these namespaces are silently off, and a capture greps *clean* whether or not the path ran. **Two of our earlier device captures read as "this never happened" for exactly that reason.**

Verified against our own source rather than taken on trust: `packages/db-p2p/src/logger.ts` imports the `debug` package directly, and `docs/debugging.md` documents exactly one way to turn anything on — the `DEBUG=` environment variable — across every worked example it gives. There is no programmatic enable exported from any package in this repo (`grep -rn "debug.enable\|enableLogging\|enableDebug" packages/*/src docs` returns nothing).

## Why this is worse than simply having no logs

A missing feature is an inconvenience. This is a **silent** missing feature on a platform we actively support and ship a storage adapter for (`@optimystic/db-p2p-storage-rn`), and its failure mode produces confident wrong answers: the reporter's capture contained no `optimystic:` lines, which reads exactly like "that code path did not run". They went on to reason from that. The same trap is waiting for every React Native consumer who follows our own debugging guide, and the guide currently walks them into it.

It also degrades the quality of the bug reports we receive, which is the practical cost to us: on the very issue where this surfaced, three app teams were producing device captures to diagnose a problem in our library, and some of those captures were empty for a reason none of them owned.

## The second half: a log field that already answers the question nobody knew to ask

`cluster-tx:read-repair-triggered` carries `ageMs`, and `CoordinatorRepo.ageMs()` returns `undefined` when `lastSeen` is null — which `JSON.stringify` then omits entirely. So **every one of those events already self-classifies**, with no timing reconstruction:

| `ageMs` on the event | what it means |
|---|---|
| **absent** | `lastSeen == null` — the read-repair window was **never armed** for this block |
| **greater than `readRepairWindowMs`** | the window lapsed — a healthy, intended re-trigger |
| **less than or equal to `readRepairWindowMs`** | re-entered while still armed — a genuine residual defect |

`readRepairSampleRate` defaults to 0 (`coordinator-repo.ts:658`), so nothing randomly re-triggers to confound the third row.

This is not documented anywhere. The cost of that is measurable rather than hypothetical: two separate parties, ourselves included, reasoned instead from *gap timing between consecutive log lines* — and the first and third rows above are **indistinguishable by gap timing alone**. `kjeib` reported a sub-second re-entry loop on a specific block on 0.29.0 and had to publicly retract it once `risavian` pointed at `ageMs`; the "loop" was many distinct reads of a hot block. We came close to opening a ticket to chase that non-existent defect.

The reporter derived this from reading our source. It is our field, in our log line, and the person who needed it had to work it out for us.

## What a design pass has to settle

**1. Which package exports the enable helper, and whether one call can cover all of them.** Each package has its own `createLogger` factory importing the `debug` module. The NOTE at the top of `logger.ts` already states the hazard precisely — `debug.formatters` is process-wide "and the other six packages' `createLogger` factories import the same `debug` module" — but that observation describes *this repo's* dependency layout, where the copies dedupe. A consumer's bundler may not dedupe them, and Metro's resolution is its own thing. The design must not assume one `debug.enable()` reaches every namespace we emit; either prove it for the shipped packages or export something that fans out explicitly.

**2. Whether a consumer calling `require('debug').enable(...)` themselves is a supported answer.** It is the obvious workaround and it is unreliable for the same reason: it enables *their* resolved copy. If we are going to tell people anything in the docs, it has to be a thing that works rather than a thing that usually works. This is the argument for exporting a helper rather than documenting a recipe.

**3. Whether enabling should confirm itself.** The whole defect is that silence is ambiguous. A helper that emits one line naming the namespaces it actually turned on — unconditionally, not through `debug` — converts "my capture is empty" from a mystery into a fact, and costs one line per run. Recommended, but it is a public-behaviour decision rather than a mechanical one.

**4. Scope against libp2p's loggers.** `logger.ts` already records that libp2p's own loggers use `weald` via `@libp2p/logger` and "carry their own copy — the two registries are independent, and enabling one from test code does not enable the other." Whatever we ship and document must say plainly which namespaces it covers, because a consumer who turns ours on and still sees no `libp2p:` lines will otherwise file that as a second bug.

**5. How to keep the documentation honest without React Native in CI.** We cannot test this on the platform where it matters. Decide what the guard is — at minimum, `docs/debugging.md` should stop presenting `DEBUG=` as the only mechanism, and should state the React Native limitation as a fact rather than leaving it to be rediscovered.

## Edge cases and interactions

- **Enable called before versus after the loggers are constructed.** `debug` binds an enabled flag per namespace at creation time in some versions; a helper that only works if called before the first `createLogger` is a trap of the same family as the one being fixed. Establish which it is and cover both orders.
- **Multiple resolved copies of `debug` in one bundle.** The failure is silent and partial: some namespaces appear, others do not, which reads as "that subsystem did not run".
- **The `%p` / `%e` / `%b` formatters** are registered on the instance `logger.ts` imports (see its NOTE). If a fan-out mechanism ends up enabling namespaces on a *different* instance, those lines print literal `%p` rather than a peer id.
- **Namespaces on, output nowhere.** `debug`'s browser build writes through `console.log`; confirm that survives on Hermes in a release build, rather than assuming enabling is the only hop.
- **Leaving it on.** Both reporters measured that debug logging roughly doubles their run times on device. Whatever we document should say so, so nobody ships it enabled or benchmarks with it on — one of them did, and had to re-run.
- **A capture taken with sampling on.** If `readRepairSampleRate` is ever non-zero, the `ageMs` table's third row stops being unambiguous. The doc entry should say the table assumes the default of 0.

## TODO

- [ ] Settle questions 1–5 above; emit implement ticket(s).
- [ ] Export a programmatic enable from the package(s) that own the loggers, covering every namespace this repo emits, and prove the coverage rather than inferring it from this repo's `node_modules` layout.
- [ ] Rewrite the enabling section of `docs/debugging.md`: `DEBUG=` for Node, the programmatic path for React Native and any other runtime without `process.env`, an explicit statement that React Native cannot use `DEBUG=`, and the note that libp2p's own namespaces are a separate registry.
- [ ] Document the `ageMs` triage table in `docs/debugging.md`, next to the read-repair material, crediting `risavian` (GitHub issue #8) — and say that gap timing cannot substitute for it, with the retracted claim as the worked example of why.
- [ ] Check whether any other log line in this repo carries a field with the same self-classifying property and is similarly undocumented. `ageMs` was found by an outsider reading our source; there may be more.
