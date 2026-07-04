----
description: Verify the fix that stops a malicious cluster coordinator from forging approval votes from other members — votes must now be signed by a key provably tied to the voting member's real identity, and honest peers can no longer be framed for reputation penalties on votes they never cast.
files: packages/db-p2p/src/cluster/peer-key-binding.ts (new), packages/db-p2p/src/cluster/cluster-repo.ts (verifySignature/validateSignatures/detectEquivocation), packages/db-p2p/src/dispute/dispute-service.ts (verifyDisputeSignature/resolveDispute/verifyPromiseSignature), packages/db-p2p/test/byzantine-fault-injection.spec.ts, packages/db-p2p/test/dispute.spec.ts
difficulty: medium
----

# Review: bind cluster-vote public keys to the peer id

## What the bug was

In the cluster two-phase-commit path, a vote's signing key was read straight from
the record (`record.peers[peerId].publicKey`) and the signature verified against
it — **without ever checking the key belongs to `peerId`.** For a libp2p Ed25519
identity the peer id *is* the multihash of the public key, so this binding is
trivially checkable and is the whole basis of the signature scheme. Without it a
coordinator could attribute a vote to any peer id `X` while signing it with a key
the coordinator controls (stored in `peers[X].publicKey`); verification passed and
the honest member applied the operation as though `X` approved it. The dispute path
had the same unbound-key shape, and its reputation paths penalized peer ids whose
key binding was never verified.

## What the fix does

- **New shared predicate** `peerIdBindsPublicKey(peerIdStr, rawKey)` in
  `cluster/peer-key-binding.ts` — true iff `rawKey` is the Ed25519 key `peerIdStr`
  names. Total: returns `false` on any hostile/malformed input, never throws.
  Mirrors the existing cohort-topic binding logic (`cohort-topic/peer-sig.ts`)
  without importing that specialized module.

- **`ClusterMember.verifySignature`** rewritten to return a `VerifyOutcome`
  (`{valid:true} | {valid:false, penalize:boolean}`) instead of a bare boolean, and
  to be total on hostile input (it used to **throw** `No public key for peer`):
  - missing/empty key, non-Ed25519 id, key **not bound** to the peer id, or
    malformed key/signature bytes → `{valid:false, penalize:false}` (reject, but do
    NOT report the named peer — its id may be attacker-chosen);
  - key **is** bound but the signature fails to verify →
    `{valid:false, penalize:true}` (genuine bad vote from a proven identity).

- **`validateSignatures`** now reports an `InvalidSignature` penalty **only when
  `penalize` is true**, and still throws `Invalid promise/commit signature from
  ${peerId}` in every failure case (record always rejected).

- **Dispute parity** in `dispute-service.ts`:
  - `verifyDisputeSignature` takes `challengerPeerId` and rejects unless the
    embedded key is bound to it.
  - `resolveDispute` is now **async**; before adding a peer to `affectedPeers` with
    `reason:'false-approval'` it re-verifies that peer's promise signature is
    binding-valid against `originalRecord` (new `verifyPromiseSignature` +
    `computePromiseHash`, which reproduce the cluster path's promise-vote preimage).
    Unbound/invalid approvals are skipped, never penalized. This closes the
    fabricated-`originalRecord` framing vector.

## The boundary this fix does NOT cross (read before reviewing)

The binding check proves a vote attributed to `X` was **signed by the key `X`
names**. It does **not** decide *which peer ids are legitimately in the cohort* — a
coordinator that mints N fresh keypairs and uses each key's own derived id passes
the binding check for all of them. Sybil/cohort membership is a separate layer
(cohort-topic membership certificates, ticket `2-cohort-topic-peer-key-signing`,
complete). This is noted with `NOTE:` comments at the verify site and in the new
module. Do not assume Sybil membership is solved here.

## Residual the reviewer should weigh (NOT gated — intentional)

An Ed25519 peer's public key is **derivable from its public peer id**. So an
attacker can attach a *victim's real* public key together with a garbage signature;
binding passes, the signature fails, and the victim takes an `InvalidSignature`
penalty (the record is still rejected). Binding **narrows** framing — the attacker
must use the victim's own key, not an arbitrary one — but cannot eliminate it at
this layer: a single signature can't distinguish "victim signed badly" from
"someone pasted the victim's public key + junk." Fully closing it needs an
authenticated membership/channel layer, out of scope here. Parked as a `NOTE:` at
the `penalize:true` site in `cluster-repo.ts:verifySignature`. Reviewer decision:
accept as documented residual, or open a follow-up (`debt-`/`backlog/`) to
rate-limit or context-gate the `InvalidSignature` penalty. I recommend accepting it
for now — it is strictly better than the pre-fix state (where *any* key framed the
victim) and a real fix belongs with the membership layer.

## Tripwires parked (index only — see the code sites)

- `cluster-repo.ts` `verifySignature` — `NOTE:` on the public-key framing residual
  above.
- `cluster-repo.ts` `detectEquivocation` — `NOTE:` that its Equivocation penalty
  relies on `validateSignatures` having run first (it does: `validateRecord` →
  `validateSignatures` at `processUpdate` runs before `mergeRecords` →
  `detectEquivocation`). Confirm this ordering still holds if the update flow is
  ever refactored.

## Use cases to validate

Reproduction tests were written first (fail before the fix, pass after):

- **Cluster (`byzantine-fault-injection.spec.ts`, describe "peer-id key binding"):**
  - *coordinator cannot forge a promise from a victim by attaching its own key under
    the victim id* — mints a key, embeds it under a victim's id, signs with it;
    `update()` must reject with `Invalid promise signature` AND the victim must have
    **zero** reputation penalties (locks in "no reputation decision on an unverified
    identity").
  - *penalizes a bound-key bad signature* — the counterpart: a peer whose embedded
    key IS bound but whose signature is garbage takes exactly one `InvalidSignature`
    penalty. (This is also the residual above, exercised.)
- **Dispute (`dispute.spec.ts`, describe "resolveDispute"):** *does not frame a peer
  whose approval carries a key not bound to its id* — a challenger-wins resolution
  penalizes the two binding-valid approvers but NOT the framed victim.
- **Regression:** the pre-existing `rejects peer with missing public key` test now
  asserts `Invalid promise signature` (verifySignature no longer throws `No public
  key`); `wrong public key`, empty/truncated signature, equivocation, and all
  dispute tests still pass.

## Validation performed

From `packages/db-p2p`:
- `yarn build` — exit 0, clean (tsc).
- `yarn test` — **1106 passing, 36 pending, 0 failing** (55s). No pre-existing
  failures surfaced.

## Suggested reviewer focus / possible gaps

- **Adversarial angle the tests do not cover:** confirm the binding check cannot be
  bypassed by a non-Ed25519 (e.g. secp256k1/RSA) peer id — `peerIdBindsPublicKey`
  returns `false` for `type !== 'Ed25519'`, so such votes are rejected as
  unbound/no-penalty. There is no positive test for a non-Ed25519 id; add one if you
  want that path pinned. (The whole substrate assumes Ed25519 — the libp2p default.)
- **Duplication:** `dispute-service.ts` now re-implements `canonicalJson` and the
  promise-hash/signing-payload reconstruction that `cluster-repo.ts` owns privately.
  This mirrors an existing pattern (the test files duplicate it too) and is called
  out in the code comments, but if the promise-vote scheme ever changes, both sites
  must move together. Consider whether a shared `db-core` helper is worth it (I judged
  it not worth the churn now — flagged for your call).
- **`resolveDispute` is now async** — verify no other caller invokes it
  synchronously (only `initiateDispute` and the tests do; both updated).
- Double-check the `verifyPromiseSignature` payload reconstruction exactly matches
  `ClusterMember.computeSigningPayload` for the `reject` case (`hash:type:reason`) —
  the false-approval path only inspects `approve` promises, so the reason branch is
  currently unexercised by that path but is implemented for correctness.
