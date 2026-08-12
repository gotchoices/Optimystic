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
