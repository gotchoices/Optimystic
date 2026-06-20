description: Let a node bootstrap a new cold-start topic when it can prove the topic is anchored to a parent topic that already exists in the network's committed state — the no-proof-of-work path reserved for essential (T0/T1) work.
prereq: cohort-topic-bootstrap-evidence-verifiers
files:
  - packages/db-p2p/src/cohort-topic/bootstrap-parent-reference.ts (NEW — verifyParentReference + the committed-state existence view)
  - packages/db-p2p/src/cohort-topic/host.ts (createBootstrapEvidencePolicy — wire the real parent-ref verifier; CoordEngineContext / antiDos plumbing for the existence view)
  - packages/db-p2p/src/cohort-topic/membership-source.ts (FretMembershipSource — add a synchronous local-existence read)
  - packages/db-p2p/src/libp2p-node-base.ts (pass the committed/membership existence view into the host)
  - packages/db-p2p/test/cohort-topic/bootstrap-parent-reference.spec.ts (NEW)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts (extend: real parent-ref cases)
  - docs/cohort-topic.md (§Anti-DoS bullet 4 / §Membership source)
difficulty: hard
----

# Cohort-topic: real parent-reference bootstrap-evidence verifier (db-p2p)

The committed-work proxy for the T0/T1 path (and the third T2/T3 option): a `bootstrap: true` register
carries a **signed reference to a parent topic that actually exists**, and the cohort admits it only
after confirming that parent topic exists in locally-available committed/membership state. This replaces
the interim reputation stand-in for `verifyParentReference` left in place by
`cohort-topic-bootstrap-evidence-verifiers`.

## Context

- `verifyParentReference(reg: RegisterV1) => boolean` is the all-tiers verifier in the db-core tier
  policy; it is the *only* accepted evidence for T0/T1 and one of three for T2/T3.
- **It must be synchronous** (runs in `member-engine.ts` `runGuards` on every register) → the existence
  check consults a **synchronous local view**, never a network fetch (a network round-trip inside an
  admission gate is itself a DoS amplifier).
- The envelope's `parentRef = { parentTopicId, sig }` comes from
  `cohort-topic-bootstrap-evidence-envelope`; `bootstrapBoundImage`, `parseBootstrapEvidenceEnvelope`,
  `verifyPeerSig` are available.
- The host already composes a `FretMembershipSource` and a tier-routed `IMembershipSourceRouter`
  (`createMembershipSourceRouter({ committed, fret })`) and, at node-base, a `CommitCertStore` of locally
  captured commit certificates. `docs/cohort-topic.md` §Membership source: T0/T1 committed membership is
  anchored in the transaction-log commit certificate; T2/T3 in FRET-published `MembershipCertV1`.

## verifyParentReference(reg)

```
env = parseBootstrapEvidenceEnvelope(reg); if (!env?.parentRef) return false
// 1. Signed reference: the participant binds the parent topic to THIS bootstrap (anti-replay).
if (!verifyPeerSig(b64urlToBytes(reg.participantCoord),
                   parentRefSigningImage(reg, env.parentRef.parentTopicId),
                   b64urlToBytes(env.parentRef.sig))) return false
// 2. Existence: the parent topic must exist in locally-available committed/membership state.
return parentTopicView.exists(b64urlToBytes(env.parentRef.parentTopicId), reg.tier)
```

- **Signed reference (anti-replay, use-case 3).** The participant signs the bound image *extended with
  `parentTopicId`* — define `parentRefSigningImage(reg, parentTopicId)` in db-core (sibling of
  `bootstrapBoundImage`, e.g. the bound array with `parentTopicId` appended) so a parent reference minted
  for one (topic, tier, peer, time, parent) cannot be lifted onto another register. Self-contained:
  verified inside the verifier against the participant's peer key, independent of the outer register
  signature (which is absent in key-less mode). Add `parentRefSigningImage` to the prereq's db-core
  module if not already present — coordinate via that ticket if it lands first; otherwise add it here in
  db-core and note the cross-package touch.
- **Existence** is a synchronous local check via a new injectable port.

## Committed-state existence view (the design decision)

Resolved: the verifier consults a synchronous, injectable **local existence view**, defaulted in the
host to the committed/membership state the node already holds. Do **not** fabricate a network lookup in
the gate.

```ts
export interface BootstrapParentTopicView {
  /** True iff the node locally knows parent topic `parentTopicId` exists (committed / has a serving cohort). */
  exists(parentTopicId: Uint8Array, tier: number): boolean;
}
```

Default host backing (`createDefaultParentTopicView`), tier-routed like the membership source:
- **T0/T1:** consult the **committed** source — the locally-cached committed membership / commit-cert
  state for `coord_0(parentTopicId)`. The cohort host has the `FretMembershipSource` cache and node-base
  has the `CommitCertStore`. Add a **synchronous** `has(coord): boolean` to `FretMembershipSource`
  (reads its in-memory `byCoord` map — `current()` is already a sync-resolvable `Promise`; expose the
  underlying sync read). For T0/T1, "exists" = a cached committed `MembershipCertV1` is present for
  `coord_0(parentTopicId)` (and/or a commit cert is known at node-base). Compute `coord_0` via the
  host's `addressing.coord0`.
- **T2/T3:** "exists" = the FRET membership source has a cached `MembershipCertV1` for
  `coord_0(parentTopicId)` (a cohort is genuinely serving the parent topic).

This is "backed by the committed-state / membership lookup rather than a reputation stand-in" using the
data the node already has. A **richer** check — verifying the parent's commit certificate names *this*
child topic — is a documented follow-on (`cohort-topic-parent-ref-tx-log-content`), not this ticket; the
existence-of-a-serving/committed-cohort check is the real, available backing.

Note the inherent limitation (document it honestly in the doc + ticket): a node only admits a
parent-ref bootstrap for a parent topic it has *locally cached* a cert/commit for. That is acceptable
for an admission gate (fail-closed when unknown → the participant uses PoW for T2/T3, or retries; T0/T1
bootstrap of a genuinely-new committed topic is driven by nodes that already serve the parent's
committed work, which hold its cert). State this tradeoff in the ticket and the §Membership source doc.

## Host + node-base wiring

- `host.ts` `createBootstrapEvidencePolicy`: when a `parentTopicView` is available (supplied via
  `antiDos` or constructed by default from the membership source + addressing), wire
  `verifyParentReference` = the real verifier; else keep fail-closed-when-configured (drop the interim
  reputation stand-in for parent-ref). Explicit `antiDos.bootstrapEvidence.verifyParentReference`
  override still wins. The fully-unconfigured host stays permissive (preserve existing tests).
- Add the existence view to `CohortTopicAntiDosOptions` (a `parentTopicView?` seam for tests) and build
  the default in `createCohortTopicHost` from the existing `membershipSource` + `addressing`
  (+ optional commit-cert reader passed from node-base).
- `libp2p-node-base.ts`: pass a committed-state reader (the `CommitCertStore` /
  `makeClusterCommitCertExtractor` surface, or the membership cache) so the default T0/T1 existence view
  has a real committed backing, not only the FRET cache.

## Edge cases & interactions

- **Synchronous-only / no network.** `exists` reads in-memory caches only; never `await`/dial.
- **Anti-replay (use-case 3).** A parent reference signed for reg A fails on reg B (different topic /
  participant / timestamp / parentTopicId) — `parentRefSigningImage` differs. Test all axes.
- **Unknown parent topic → `false`** (fail closed): a parent-ref for a topic the node has never cached a
  cert/commit for is denied → `unwilling_cohort`. Test.
- **Tier routing:** a T0/T1 parent-ref consults the committed view; a T2/T3 one the FRET cache. A parent
  topic cached only as a FRET cert must NOT satisfy a *T0/T1* existence check (committed-tier integrity).
  Test the cross-tier case.
- **Self-referential / circular:** `parentTopicId == reg.topicId` — the parent of a topic cannot be
  itself; reject (a topic cannot vouch for its own existence). Add an explicit guard + test.
- **Bad signature / malformed envelope / absent parentRef → `false`, never throw** (total verifier).
- **Unconfigured host stays permissive** (tier-0 bootstrap with no evidence still admits) — preserve
  `service.spec.ts` / `live-tier.spec.ts` / scale suites.
- **Interaction with PoW/reputation (T2/T3 disjunction):** with no PoW and no reputation but a valid
  parent-ref to an existing parent, a T2/T3 bootstrap is admitted; with an invalid/unknown parent-ref it
  falls through to (absent) PoW/reputation → denied. Test the disjunction precedence.
- **Concurrent / per-coord:** the existence view is node-level (like the bootstrap-evidence policy), read
  by every coord engine; it holds no per-coord mutable state, so no cross-coord interference. The
  membership cache it reads is the shared node-wide source — confirm a cert cached by one served coord is
  visible to a parent-ref check on another (it is; the cache is keyed by coord, not engine).

## Key tests

`bootstrap-parent-reference.spec.ts` (unit, construct envelopes directly):
- valid signed parent-ref + existing parent (stub `parentTopicView.exists → true`) → `true`.
- existing parent but bad/absent signature → `false`; valid signature but unknown parent
  (`exists → false`) → `false`.
- parent-ref minted for a different reg (topic / participant / timestamp / parentTopicId) → `false`.
- `parentTopicId == topicId` → `false`.
- tier routing: a T0 check uses the committed view, a T2 check the FRET view (assert the right backend is
  consulted via two distinct stubs).

Default view (`createDefaultParentTopicView`): seed the `FretMembershipSource` cache with a cert for
`coord_0(parent)` → `exists(parent, 2) === true`; absent → `false`; a FRET-only cert does not satisfy a
T0 check.

Extend `host-antidos-coldstart.spec.ts`:
- A configured host admits a T0 bootstrap carrying a valid parent-ref to a cached existing parent and
  denies one to an unknown parent.
- The bare-host permissive tier-0 path still passes.

## TODO

- Add `parentRefSigningImage` (db-core `bootstrap-evidence-envelope.ts`) if the prereq did not; otherwise
  reuse it.
- Create `bootstrap-parent-reference.ts`: `createParentReferenceVerifier({ parentTopicView })` +
  `createDefaultParentTopicView({ membershipSource, addressing, committedReader? })` +
  `BootstrapParentTopicView`.
- Add synchronous `has(coord): boolean` to `FretMembershipSource`.
- Wire into `host.ts` (`createBootstrapEvidencePolicy`, `CohortTopicAntiDosOptions.parentTopicView`,
  default construction) and `libp2p-node-base.ts` (committed reader). Remove the interim reputation
  stand-in for `verifyParentReference`.
- Update `docs/cohort-topic.md` §Anti-DoS bullet 4 + §Membership source: parent-ref is now real,
  backed by the local committed/membership existence check; note the local-cache limitation and the
  richer tx-log-content follow-on.
- File `tickets/backlog/cohort-topic-parent-ref-tx-log-content.md` for the richer check (the parent's
  commit certificate must name this child topic) — out of scope here.
- Run `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/dbp2p.log` and `yarn workspace @optimystic/db-p2p build`. Pre-existing unrelated failures → follow the pre-existing-error protocol.
