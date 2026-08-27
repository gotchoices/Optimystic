description: Before a machine co-signs a write, it checks that the group of peers claiming to handle that write really is the right group — but the write's own sender picks which piece of data that check is run against, and if the sender simply leaves that choice out, the machine quietly falls back to a weaker check instead of refusing.
files: packages/db-p2p/src/cluster/cluster-repo.ts (deriveExpectedClusterView, admitMembership), packages/db-p2p/src/repo/cluster-coordinator.ts (executeClusterTransaction), packages/db-p2p/test/cluster-membership-admission.spec.ts, docs/correctness.md (Theorem 2)
difficulty: medium
tradeoffs: The stronger check would refuse writes from any peer still running an older build that does not attach the field, so it needs a version gate or a grace period to be safe to deploy — and the weaker fallback it replaces is already documented as the accepted posture, so a maintainer could reasonably wait until the wider membership-certificate work lands and subsumes it.

# An absent coordinating block should be inadmissible, not merely unconfident

## Background, in plain terms

Every write in a cluster is driven by one peer (the *coordinator*) and voted on by the group of
peers responsible for the data (the *cohort*). Before a member votes yes, it checks for itself that
the group the coordinator declared really is the responsible group — it looks the group up
independently rather than trusting what the coordinator said.

To do that lookup the member needs to know *which piece of data* the group was chosen for. The
coordinator supplies that: one block id, carried on the message as the "coordinating block".

## The gap

The coordinator chooses whether to supply it at all. When the field is absent, the member cannot do
its own lookup, and instead of refusing it falls through to a weaker rule: judge the declared group
against a number the operator configured (`assumedClusterSize`) rather than against the group the
member actually measured.

That fallback exists for good reasons — nodes with no lookup capability wired in, and deployments
that never configured a size — but it means a dishonest coordinator can *choose* the weaker check
simply by omitting one field. If the configured number is smaller than the real cohort (the common
case, since its default is deliberately permissive), the coordinator gets to declare a smaller group
of peers than the member would otherwise have accepted.

The just-landed ticket `commit-and-cancel-records-omit-the-coordinating-block` is what makes this
worth closing: the coordinator now derives that field at a single choke point for *every* cluster
path (pend, commit, cancel), so its absence no longer means "an honest builder forgot" — it means
the record was not built by a current coordinator. That is a fact a member can now act on.

The same ticket already closed the *neighbouring* hole: a coordinating block that is present but
names a block the record's own operations never touch is rejected (it falls to the same weaker
rule and logs `cluster-member:coordinating-block-unbound`). Only the fully-absent case is left, and
it lands in the same place for the same reason.

## Expected behaviour

A member that **has** the independent-lookup capability wired in should treat a record with no
usable coordinating block as one it will not vote to admit, rather than as one to judge leniently.
A member with no such capability keeps today's behaviour — it has nothing to check against.

Note the shape of the desired change: it should be impossible for the *sender* to select which of
the two checks the receiver runs. Whether that is expressed as a hard refusal, or as "treat an
absent field as a derived view of zero peers", is a design choice for whoever picks this up.

## What has to be decided first

- **Rolling upgrades.** A peer still running a build that predates the choke point will send commit
  and cancel records with no coordinating block, and every upgraded member would refuse them. The
  cluster consensus code is described elsewhere in this repo as a single deployable unit that
  upgrades together (see the `membershipVersion` check in `validateRecord`), which may be enough of
  an answer — confirm that, or gate the new strictness on a version marker.
- **Which failure surface.** Today an inadmissible record produces a signed `reject` vote carrying a
  `membership-not-admitted:<variant>` reason, not a thrown error. A new variant name is needed
  (`:no-coordinating-block`), and it should follow the existing convention of naming the numbers
  that caused it.
- **Whether this is subsumed.** `feat-cluster-membership-threshold-cert-anchoring` would replace
  independent re-derivation with a cohort-signed membership certificate. If that lands, this check
  disappears along with the field it guards. That ticket is explicitly not ready to build, so this
  is worth doing in the meantime — but do not build both.

## Evidence

Read from the code, not observed in a running system: `deriveExpectedClusterView` returns
`undefined` when `record.message.coordinatingBlockIds?.[0]` is absent, and `admitMembership` maps an
absent derived view onto the `assumedClusterSize` branch (and, when no size is configured at all,
onto an unconditional admit). A test would confirm it in the shape of the existing
`cluster-membership-admission.spec.ts` cases: same shrunken declared set, once with the field and
once without, asserting the two are judged the same rather than differently.

## Related

- `commit-and-cancel-records-omit-the-coordinating-block` (landed) — put the field on every path and
  bound it to the record's own operations; the direct predecessor of this ticket.
- `feat-admission-floor-from-observed-cohort-high-water-mark` — attacks the same weakness from the
  other side, by making the fallback number itself trustworthy instead of operator-configured.
- `docs/correctness.md` Theorem 2, caveat (3) — records this as a known residual limit.
