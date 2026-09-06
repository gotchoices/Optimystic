description: When a machine is told a newer version of a record exists and the machine holding it then goes offline, one reply from any other machine saying "I don't have it" is enough to make the record's owner forget the warning and serve its old copy as confirmed-current.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`nothingAheadVerdict` ~line 1049, `CurrencyVerdict` ~line 318, `recordAheadClaim` ~line 826, `queryClusterForLatest`'s `answered`/`silent` counts ~line 1370)
  - packages/db-p2p/test/coordinator-repo-unavailable.spec.ts (`the mark outlives the consult (read-repair window)` describe, ~line 577)
  - docs/internals.md (the `unconfirmedAheadRev` bullet, ~line 1064)
repro: verified
difficulty: medium
----

# A partial answer should not be able to erase recorded doubt

## Plain statement of the problem

Machines in this system hold copies of records. Before a machine serves a copy, it may ask the
other machines responsible for that record whether a newer version exists. If one of them says
"yes, version 3" and this machine cannot get hold of version 3, it writes that down and from then
on every read it serves is marked *"this may be out of date"*.

That written-down warning is supposed to survive until it is genuinely disproved. The ticket
`a-consult-that-asked-nobody-erases-recorded-doubt` fixed the case where the machine asked
*nobody* and threw the warning away anyway. The same hole is still open one step in: when the
machine asks and only **some** of the others answer, whatever the answerers say is treated as the
final word — even when the one machine that actually knew about version 3 is the one that did not
answer.

So: the only holder of the newer version goes offline, any other peer replies "I don't have that
record", and the warning is deleted. The next read is served as confirmed-current while a newer
version demonstrably exists elsewhere. This is the same silent-staleness failure the whole
`unconfirmedAheadRev` mechanism exists to end, arriving through the one door still open.

## Verified reproduction

Run against `packages/db-p2p` at commit `5a6d8bde` (the implement commit of
`a-consult-that-asked-nobody-erases-recorded-doubt`). Construct a `CoordinatorRepo` in
`readRepairMode: 'paranoid'` with a cohort of three (this node plus two peers) and a local copy at
revision 1, then:

1. **First read** — both peers report revision 3 and it cannot be acquired. The read is stamped
   `unconfirmedAheadRev === 3`; the claim is recorded in `unsettledAheadClaims`.
2. **Second read** — peer A's callback rejects (a dial failure), peer B answers `undefined`
   ("I responded; I hold nothing").
3. **Observed:** `unconfirmedAheadRev` is `undefined`. The warning is gone and the stale copy is
   served as confirmed-current.

Probe run and confirmed during the review of that ticket, then removed; it is not in the tree.
Re-creating it is a ~20-line spec using the helpers already in
`packages/db-p2p/test/coordinator-repo-unavailable.spec.ts`.

The more realistic field shape is the same thing with one fewer peer holding the data: only peer A
ever had revision 3 (peer B never did), the first read records the claim from A's uncorroborated
report, and A then goes offline. Every subsequent read clears the warning on the strength of B's
"I hold nothing".

## Where it comes from

`queryClusterForLatest` reports two separate counts — how many cohort peers *answered*, and which
ones were *silent*. The existence half of the verdict uses both and has three levels: no silence is
`confirmed`, some silence with some answers is `unconfirmed` ("ask a better-connected machine"),
and silence with no answers at all is `isolated`. The currency half uses only the answer count and
has two levels: zero answers means no evidence, any answers at all means *refuted*. Partial silence
therefore reads as a complete refutation on the currency side and as an explicitly incomplete
picture on the existence side, ten lines apart in the same function.

The deeper reason the two halves cannot be made symmetric by a one-line change is that the recorded
warning does not remember **who** made the claim. Without that, "has this claim been answered?"
cannot be asked at all, and the only two rules available are both wrong at the edges:

- *Any answer refutes* (today) — a peer that never knew about the claim can retire it.
- *Only a fully-answered cohort refutes* — one permanently unreachable cohort member would make
  the block flagged forever, and reads of it would fail with `BlockPossiblyStaleError`
  indefinitely.

## Expected behaviour

- A recorded claim is cleared only by evidence that actually bears on **that claim**. An answer
  from a peer that has no knowledge of the claimed revision is not such evidence when the peer that
  made the claim is unreachable.
- A cohort that answers in full and reports nothing ahead still clears the warning, as it does
  today — that path must not regress (it is pinned by
  `drops the mark when peers answer with a claim strictly BELOW what this node holds` and
  `drops the mark once a consult finds nothing ahead any more`).
- Losing one cohort member permanently must not leave a block flagged forever with no path back to
  a clean read. Whatever rule is chosen has to say how doubt eventually settles when a claimant
  never returns — that is the part this ticket most needs researched, not the detection.
- The relationship between the existence verdict and the currency verdict should be stated once,
  in one place, rather than left as two similar-looking expressions with different level counts.

## Second arm, same site: this node's own answer can count as a refutation

`CoordinatorRepo` accepts an optional `localPeerId`. When it is set (both production wirings pass
it) the machine excludes its own answer from the cohort's answers, and a cohort consisting only of
this machine is short-circuited before any query runs. When it is left unset — a construction the
class has always tolerated for single-node and test use — neither of those happens: the machine
asks itself, counts its own reply as a cohort answer, and concludes that nothing is ahead. The
recorded warning is deleted on the strength of the machine agreeing with itself.

Same code site and same underlying cause as the arm above: the count the refutation rule reads does
not actually mean "a cohort member other than me answered". Fix them together.

This is **dormant**, not live — `packages/db-p2p/src/libp2p-node-base.ts:987` and
`packages/db-p2p/src/testing/mesh-harness.ts:460` both pass `localPeerId`. The pre-existing note at
`queryClusterForLatest` already anticipated this ("Same fix if it ever matters — require
`localPeerId`"); it now matters, so requiring the field is a legitimate resolution for this arm.

## Scope notes

- **This is not a regression** from `a-consult-that-asked-nobody-erases-recorded-doubt`; the
  behaviour predates it. That ticket closed the "asked nobody" door and made this one visible.
- **Adjacent, and deliberately out of scope unless the chosen fix subsumes it:** a consult whose
  corroborated revision is *lower* than the recorded claim also clears the claim, because
  `recordAheadClaim` treats the newest consult as the authority regardless of what it saw. That is
  stated as intentional in a comment at the site. If claim provenance lands, revisit whether it
  should still hold.
- `tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md` is the standing
  refactor ticket for this area and lists this file's growth; this is a behaviour defect, not
  another measurement for it, but whoever works either should read the other.
