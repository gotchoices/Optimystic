description: A machine far from a collection's log tail used to trust whatever list it first saw of the group that signs that collection's change announcements; it now checks that list against the signed commit record of the tail block, which the same group produced.
prereq: reactivity-notifications-need-the-tail-cohort-to-be-the-topic-cohort
architecture: docs/reactivity.md#authentication-and-integrity
files: packages/db-p2p/src/cohort-topic/commit-log-trust-anchor.ts, packages/db-p2p/src/cohort-topic/signer-verdict.ts, packages/db-p2p/src/cohort-topic/fret-trust-anchor.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-core/src/cohort-topic/membership/verifier.ts, packages/db-core/src/cohort-topic/ports.ts, packages/db-core/src/cohort-topic/sig/threshold.ts, packages/db-core/src/reactivity/verify.ts, packages/db-p2p/test/cohort-topic/commit-log-trust-anchor.spec.ts, packages/db-p2p/test/cohort-topic/fret-trust-anchor.spec.ts, packages/db-core/test/cohort-topic/membership.spec.ts, packages/db-core/test/reactivity/verify.spec.ts, docs/reactivity.md, docs/cohort-topic.md, docs/internals.md, docs/debugging.md
----

# Reactivity root membership anchored by the tail block's commit proof

## What was built

A subscriber verifies a change notification against the root group's membership certificate (`MembershipCertV1`). The root group is the tail block's storage group, and that group persists a commit proof for the tail (`BlockCommitProof`) that any machine can verify offline.

- **`CommitLogTrustAnchor`** (`packages/db-p2p/src/cohort-topic/commit-log-trust-anchor.ts`). For a root-placed certificate whose placement names a `rootKey` hashing to the certificate's coordinate, it asks every member of the tail's storage group for the tail's latest claim and proof, certifies each proof against the claim its peer made, and takes the peer list of the highest certified revision as the committing cohort. The certificate's signers are judged against it: all inside and numbering at least `ceil(|cohort| × quorumRatio)` → `"anchored"`; none inside → `"rejected"`; anything else → `"unknown"`. Two certified actions at the top revision anchor nothing. One result per tail is held for 30 s, with one in-flight fetch per tail.
- **Port changes (db-core).** `IMembershipTrustAnchor.directAnchor` may return a promise. `RootPlacement` gained `rootKey?`; `createNotificationVerifier` passes the notification's tail bytes on every call.
- **Trust gate in two steps** (`packages/db-core/src/cohort-topic/membership/verifier.ts`). `directVerdict` is awaited; `certIsTrusted` is synchronous and runs in the same turn as the cache write, so two loads of one coordinate cannot interleave between the gate's reads and the write.
- **Composition.** `composeTrustAnchors` in `packages/db-p2p/src/cohort-topic/host.ts` asks the FRET anchor first and the injected anchor only on `"unknown"`. `createLibp2pNodeBase` builds the commit-log anchor when `cohortTopic.enabled`.

## Review findings

**Checked.** The implement diff (commits `ticket(implement): feat-reactivity-root-membership-anchored-by-the-commit-log`, both the salvaged partial and the final one) read in full before the handoff: the anchor, the verifier's gate split, the port and placement changes, host composition, node wiring, all three specs and the four docs. Ran `yarn lint`, `yarn lint:docs`, db-p2p `yarn build`, db-p2p `yarn test` (3198 passing, 65 pending) and db-p2p `yarn test:integration` (46 passing, 2 pending) on the final tree. db-core was not re-run: this pass changed nothing in it.

**Found and fixed in this pass.**

- **One group member could have a certificate of itself alone vouched for.** A root-placed certificate's own threshold is a ratio of the members the certificate lists. A single real member of the tail's group could publish a certificate listing only itself, sign it alone (a full quorum of a one-member list), and the anchor answered `"anchored"`, because its only test was "every signer is in the committing cohort". `FretTrustAnchor` had the same hole for a root group a node is itself in, where an anchored verdict also overrides that node's own self-published certificate. Both anchors now also require the signers to number at least `ceil(|expected set| × quorumRatio)`, counted against the set the anchor holds, and answer `"unknown"` below it. Tests added: one case in `commit-log-trust-anchor.spec.ts` (one of four, two of four), one assertion in the FRET anchor's existing root-placement test.
- **The signer-subset rule was written twice.** The loop in `FretTrustAnchor.directAnchor` and `judgeSigners` in the commit-log anchor were the same rule. Both now call `judgeSigners` in the new `packages/db-p2p/src/cohort-topic/signer-verdict.ts`, which is also where the quorum fix lives.
- **Docs.** `docs/reactivity.md` and `docs/cohort-topic.md` described the rule as "every signer in the set anchors"; both now state the quorum count. The anchor's module header says the same, and notes that uniting two proofs' peer lists can only raise the quorum (turn an anchored verdict into an undecided one).

**Weighed and left as built.**

- **Union of peer lists for two proofs at one revision and action id.** With the quorum now counted against the united set, the union only ever makes the anchor more conservative, so it stays.
- **The gate split.** Read for interleavings: tofu-then-anchored, anchored-then-tofu, and two anchored loads all end with the anchored certificate cached and the lock visible to the later load. The implementer's reproduction test covers the one that failed.
- **The wiring test in `verify.spec.ts`.** Kept: dropping the key has no other symptom, and it pins a stated contract of the verifier.
- **Error handling and cleanup.** The anchor is total (every path through `directAnchor` and `fetchAnchoringSet` catches and logs), holds no timers, and both maps are bounded (`LruMap`, and `inFlight` is cleared in `finally`).

**Tripwires and known limits (no ticket).**

- A held set can be one commit behind for up to 30 s — `NOTE:` at `anchoringSetFor`.
- A transient `"unknown"` still admits the certificate on first use, and absence is cached for the window — `NOTE:` at `composeTrustAnchors`.
- A group member can serve a proof signed by keys it made up at a higher revision, after which a distant subscriber rejects the real group's certificate while that member keeps serving it. This is the already-open proof-anchoring limit; the consequence is recorded as an arm of backlog `feat-cluster-membership-threshold-cert-anchoring`. Nothing new filed.

**Not covered.**

- No automated test asserts the end-to-end verdict on a real mesh; the integration case passes whether the anchor answers `"anchored"` or falls back to first use. The implementer's evidence is a manual run reading the `commit-log-anchor:set` debug line. This pass did not repeat that manual run after the quorum change; the unit specs cover the changed rule, and the integration suite passes.
- Not run: `quereus-plugin-optimystic` suites, `yarn check:rn`, root `yarn test`.
