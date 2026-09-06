----
description: The code that decides whether a node's copy of a record is up to date is spread through a very large file and keeps its notes in loose variables, so it is easy for a future change to read a record without checking everything that is known about how fresh it is — a mistake that has already happened once.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/coordinator-repo-unavailable.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair-trust.spec.ts
difficulty: medium
tradeoffs: The file's long comments carry most of the design rationale for read-repair, and moving them risks scattering that context for no behavioural gain — a maintainer may prefer to leave a working, well-annotated file alone until the next feature actually needs the seam.
----

# The freshness knowledge a read needs lives in too many places

## What is going on

`CoordinatorRepo` is the piece that answers "give me this record" for a node. Before it
answers, it may consult the other nodes that hold the same record to check whether its own
copy is current. Everything about that consult — when to run it, what the other nodes said,
what is still unresolved, and how each of those facts should change the answer handed back —
lives directly on the same class as the unrelated write-coordination work (pend, commit,
cancel) and is remembered in two separate maps plus a handful of return values.

Measured today (`wc -l packages/db-p2p/src/repo/coordinator-repo.ts`): **1122 lines**, of
which the freshness/read-repair concern is a contiguous **~450-line** span (lines 453–903:
the two answer-flagging helpers, the claim memo, the repair-window policy, the cohort
consult, the convergence attempt, the peer-reputation penalty). The rest is routing checks,
construction, and the write path.

Re-measured after ticket `absence-verdict-names-the-evidence` landed (same command):
**1194 lines**. That ticket added a fourth thing the read path must consult before it
answers — an `AbsenceVerdict` naming *why* an absence could not be confirmed, threaded from
the cohort consult through `get` and mapped to a caller-visible reason at the flag site. It
is further evidence for this ticket, not a separate one: the new state lives in exactly the
span described above and is remembered the same loose way.

## Why it is worth attention

This is not only a size complaint. The read path has to consult **every** piece of that
knowledge before it answers, and nothing makes it do so:

- how recently the record was checked (drives whether a consult runs at all),
- whether a still-unresolved claim from a *previous* consult applies,
- what this consult concluded about existence, and separately about currency.

The review of `coordinator-serves-stale-data-as-if-confirmed` found exactly the failure that
shape invites: the "we could not confirm this is current" verdict was carried only in the
consult's return value, so on every read where the consult was skipped as recent, the answer
went back marked as confirmed. Fixed at the instance; the invitation remains.

## What good would look like

One collaborator that owns the freshness question and all of its state, with a single entry
point along the lines of "here is a record I am about to serve and the view it was asked for
— tell me everything you know about how fresh it is". `CoordinatorRepo.get` then asks that
one question instead of assembling the answer from several sources, and a future edit cannot
forget a source it never sees. The seam is already almost clean: the span touches only the
key network, the storage repo, the reputation service, the two acquisition callbacks, and
the read-repair config.

Not a behaviour change; the existing coordinator specs should pass untouched, which is the
cheapest available proof the extraction was faithful.

## Second instance (added by the fix pass on `isolated-read-cannot-confirm-a-never-written-block`)

The same shape invited a second failure, in the other half of the answer. The consult reported
what it concluded about **existence** as a single boolean (`inconclusive`), so three genuinely
different outcomes — "part of the cohort could not be asked", "none of it could be asked", and
"a peer told us the block exists and we could not get it" — arrived at the flagging decision as
one bit and left it as one flag value. The third case was worse than vague: because it set the
bit to `false`, the answer went back as an *authoritative* absent while a peer had just said the
block exists. Measured and reproduced; being fixed at the instance in
`implement/absence-verdict-names-the-evidence`, which replaces the boolean with a named verdict
and adds two `BlockUnavailableReason` values.

Two things this changes for the extraction:

- It is more evidence for the same conclusion, from the existence half rather than the currency
  half — both failures are "a fact the consult knew, flattened on the way to the answer".
- Sequence it **after** that fix, not before. The fix lands new types (`AbsenceVerdict`) and a new
  parameter on `flagUnconfirmedAbsence` inside the same ~450-line span; extracting first would mean
  doing the same work twice.

The extraction's own acceptance test should be strengthened accordingly: the collaborator's single
entry point has to return existence and currency as *separate, named* results, not a pair of
booleans, or the same class of flattening can reappear behind the new seam.


## Third instance (added by the review pass on `repair-deadlock-is-never-named`)

Re-measured after that ticket landed (`wc -l packages/db-p2p/src/repo/coordinator-repo.ts`):
**1341 lines**, up from 1194. Two things about *how* it grew belong here rather than in a ticket of
their own:

- The new per-block fact — "we have already said this block's repair cannot converge" — had nowhere
  natural to live, so it was hung off the existing unresolved-claim entry by widening that entry's
  value from a plain number to a small record (`AheadClaimState`). That is a reasonable local call
  and it is commented, but it is the third fact sharing one map for no reason other than "there was
  already a map", and it needed two explicit lifetime carve-outs at the call sites to behave: one
  for a claim being cleared, one for a block that is missing locally and never reaches the recording
  path at all.
- The consult now also has to answer a *classification* question ("is this decline permanent, or is
  some peer merely behind?") whose inputs — how many peers the cohort has, how many answered, what
  the quorum would demand in the best case — are exactly the loose values this ticket is about.
  Getting that classification wrong the first time is what the review pass caught.

Neither is a new defect, and neither changes the shape of the extraction. They are the strongest
argument yet for the acceptance criterion already stated above: the collaborator that owns freshness
should own the *record* of what an earlier pass concluded too, with each fact named and its lifetime
stated in one place, rather than lifetimes reconstructed at three call sites.

## Fourth measurement (review pass on `mesh-partition-admission-quereus-validation`)

Re-measured (`wc -l packages/db-p2p/src/repo/coordinator-repo.ts`): **1451 lines**, up from 1341.
Evidence only — this ticket's shape is unchanged. The growth since the third measurement is not
freshness state; it is the solo-cohort short-circuit gaining a third copy (`cancel` joined `pend`
and `commit`, each deciding `peerCount <= 1` for itself with its own explanatory comment). Worth
noting for whoever does the extraction: "how does this operation decide whether the cluster path
applies at all" is a second small concern living inline in this file three times over, and it is
adjacent to, but distinct from, the freshness state this ticket is about.

## Eighth measurement — the predicted mistake happened again, and this time a user hit it

Added 2026-09-05. This ticket's `description:` says it is "easy for a future change to read a record
without checking everything that is known about how fresh it is — a mistake that has already
happened once." It has now happened twice, and the second one blocked an outside consumer for
47 minutes per attempt (GitHub issue #8; tracked as `fix/1-solo-node-read-repair-never-settles`).

The instance: `fetchBlockFromCluster` has three exits. Two stamp `lastSeenCommitMs` via
`markBlocksSeen`, which is the only thing that arms the read-repair window. The solo short-circuit
(`cluster-fetch:solo-self-skip`) does not — so on a cohort of one, `shouldReadRepair` reads
`lastSeen == null` forever and every read re-runs a consult that can never do anything. Measured:
9 reads inside the window produce 9 consults at HEAD and 1 with the exit stamped.

**Why this is the strongest evidence yet for the collaborator, and not just another arm.** The
earlier measurements argued from size and reviewability — a ~450-line span, four `LruMap`s, rationale
spread through long comments. This one is different in kind: the bug is not that someone misread the
code, it is that *"consult finished"* and *"window armed"* are two separate facts a caller has to
remember to keep in sync, and one exit forgot. A collaborator owning the window would make the
forgetting unrepresentable — arming would be a consequence of the consult returning, not a call the
author has to remember at each of three (soon four, see below) exit points.

Note the fourth exit already visible at the same site: `peerIds.length === 0` also returns
`{ absence: 'confirmed' }` without arming. Whether that one *should* arm is a real question (an
empty cohort is routing failure, not a settled answer) — but the fact that answering it requires
reasoning about each exit independently is the shape this ticket exists to retire.

## Fifth measurement (review pass on `certified-claims-read-repair`)

Re-measured (`wc -l packages/db-p2p/src/repo/coordinator-repo.ts`): **1570 lines**, up from 1451.
Evidence only — this ticket's shape is unchanged. The growth is the cohort-consult gaining a
verification pass: every peer answer that carries a cohort commit proof is now verified inside
`queryClusterForLatest` before selection reads the answers, and the two reputation penalties it can
raise sit as two sibling helpers beside it. That is more of exactly the concern this ticket names —
the consult now decides existence, currency, permanence-of-decline, *and* per-answer trust, from
loose values, in one method.

A second, adjacent concern for whoever does the extraction (distinct from freshness state, noted
here rather than as its own ticket because it is a property of the same class): the constructor now
takes **twelve positional parameters, eight of them optional**, and 44 test call sites thread
`undefined` placeholders through the middle to reach the ones they care about. Every ticket that
adds a collaborator adds a placeholder to all of them. `coordinatorRepo(components)` — the
options-object factory in the same file — is already the production entry point and the shape the
constructor should have; the positional signature survives only because the tests use it. Whatever
seam the extraction creates, give the class one options object rather than a thirteenth slot.

## Sixth measurement (review pass on `mint-solo-cohort-commit-proof`)

Re-measured (`wc -l packages/db-p2p/src/repo/coordinator-repo.ts`): **1937 lines**, up from 1570.
Evidence only — this ticket's shape is unchanged. The growth is `commit` taking on proof production:
the solo-cohort short-circuit now builds a message, mints a one-peer proof through the local cluster
member and threads it into storage, and the post-consensus fallback threads the consensus record's
projected proof, each under a long block comment explaining why the two must differ. `commit` is now
roughly 190 lines. That is a third concern living on this class alongside freshness and write
coordination, and it argues for the extraction naming a commit seam as well as a freshness one.

## Seventh measurement (review pass on `name-a-block-that-is-stuck-behind-a-stale-reservation`)

Re-measured (`wc -l packages/db-p2p/src/repo/coordinator-repo.ts`): **2199 lines**, up from 1937.
Evidence only — this ticket's shape is unchanged, and the growth is mostly the long operator-facing
prose the new diagnostic needs, which is exactly the kind of context the tradeoff note above says a
maintainer may not want moved.

One structural fact does belong here, because it is the counter-example to the third measurement's
complaint. That measurement objected that a new per-block fact was crammed into an existing map
"because there was already a map". This ticket did the opposite and added a **fourth** per-block
`LruMap(1000)` on the class (`stuckReservations`, joining `responsibilityCache`, `lastSeenCommitMs`
and `unsettledAheadClaims`), with a doc comment arguing — correctly, for a single change in
isolation — that the new fact has a different lifetime from the freshness entry's and should not
widen it. Both calls are locally right and they point opposite ways, which is the clearest evidence
yet that the missing thing is not a rule about where to put the next fact but a collaborator that
owns per-block state and states each fact's lifetime in one place. The extraction should absorb all
four maps, not only the freshness ones; whoever does it should expect four different clearing
conditions (a TTL, a timestamp, convergence on a revision, and a block accepting a write).

A second, smaller observation for the same pass: all four maps are keyed `string` though every one of
them is keyed by a block id, so the compiler cannot tell a block key from any other string the class
handles. Cheap to fix inside the extraction, not worth a ticket on its own.


## Ninth measurement (review pass on `solo-node-read-repair-never-settles`)

Re-measured (`wc -l packages/db-p2p/src/repo/coordinator-repo.ts`): **2224 lines**, up from 2199.
Two things this pass settled, recorded here so they are not re-opened.

**The eighth measurement's open question is answered.** It asked whether the `peerIds.length === 0`
exit "should arm" the read-repair window like the solo exit now does. It should not, and the reason
turned out not to be the interesting part: `Libp2pKeyPeerNetwork.findCluster` always includes this
node in the cohort it returns, so an empty result is not something the production key network can
produce at all — only the mesh harness's injected lookup failure reaches that branch. Both exits
now carry a `NOTE:` stating their side of the asymmetry.

**A third instance of the predicted mistake, in the currency half.** The eighth measurement argued
that "consult finished" and "window armed" being two facts a caller must keep in sync is what let
one exit forget. The same shape produced a second, independent defect at the same site, now filed as
`fix/a-consult-that-asked-nobody-erases-recorded-doubt`: `fetchBlockFromCluster` returns
`claimedAheadRev: undefined` for *both* "peers answered and claim nothing ahead" and "no peer was
asked, or none answered", so `get` clears the remembered ahead-claim on a consult that reached
nobody — and `recordAheadClaim`'s own doc comment states the invariant this violates ("Only a
consult that actually RAN may call this"). Verified by probe on both the solo-self and
total-silence paths.

This is the strongest evidence yet for the acceptance criterion this ticket already carries —
existence and currency returned as separate, *named* results. Note that `AbsenceVerdict` fixed
exactly this flattening for existence and the currency half was left as a bare optional number, so
the extraction should treat "what did this consult actually establish?" as one named answer covering
both halves rather than a verdict plus a loose field.

## Tenth measurement (review of `a-reader-cannot-tell-its-view-stopped-advancing`)

Re-measured (`wc -l packages/db-p2p/src/repo/coordinator-repo.ts`): **2270 lines**, up from 2224.

That ticket added an eleventh thing the freshness question depends on: a rule deciding whether a
*write* this node just performed counts as evidence its copy is current
(`commitQuorumRulesOutRivals`). The rule itself is a single named predicate — deliberately, so the
eventual extraction can lift it whole — but its inputs come from the write path (how many peers
approved, how many the router saw) while its only consumer is the read path's window. So the
"how fresh is this copy?" answer now has to be assembled from the read side *and* the write side of
the same class, which is a wider seam than the eight-measurement version of this ticket described.

**Concrete consequence, and why the extraction should own it:** whether a node re-asks the cohort
is now decided at five separate sites (three read-path exits, two write-path ones), each arguing
its case in a prose comment, and no two of them share a helper that states the underlying rule —
"arm only when re-asking sooner could not learn anything". A gap between two of those sites is
exactly what `bug-a-cohort-that-cannot-corroborate-re-asks-on-every-read` reports.

## Eleventh measurement (implement of `a-consult-that-asked-nobody-erases-recorded-doubt`)

Re-measured (`wc -l packages/db-p2p/src/repo/coordinator-repo.ts`): **2341 lines**, up from 2270.

The currency half is now a named verdict too. The ninth measurement predicted the extraction should
treat "what did this consult actually establish?" as one named answer covering both halves rather
than "a verdict plus a loose optional number"; that fix has landed, so the extraction now inherits
**both** halves named: `fetchBlockFromCluster` returns `{ absence: AbsenceVerdict; currency:
CurrencyVerdict }`, with `currency` required so a new exit cannot mean "peers refuted the claim" by
leaving a field off. `CurrencyVerdict` distinguishes three things the old `number | undefined`
could not: `refuted` (a cohort member answered and nothing is ahead — the only verdict that may
clear the remembered claim), `no-evidence` (nobody was asked or nobody answered — the memo stands),
and `unsettled-claim` (a peer claims a revision ahead that this pass did not converge onto).

What this does and does not change for the extraction:

- **Does:** the acceptance criterion "existence and currency returned as separate, named results"
  is now satisfied at the current seam, so the extraction can lift the pair wholesale instead of
  re-designing the currency return on the way out. Two shared verdict values are computed once
  beside each other — `silenceVerdict` for existence, `nothingAheadVerdict` for currency — and both
  key off the same `answered` count; a collaborator owning freshness should own that count and
  derive both, rather than each exit re-deriving them.
- **Does not:** the wider seam the tenth measurement describes is untouched. Whether a node re-asks
  the cohort is still decided at five sites, and this ticket's fix deliberately left the read-repair
  window arming exactly as it was — the solo exit still arms the window *and* now also keeps the
  memo, because "was this checked recently?" and "is there recorded doubt?" are different questions.
  Those two facts being independently maintained at the same exits is the same coupling this ticket
  is about; the extraction should make the pair one decision, not two calls an author must remember.
