description: This package publishes two entry points — one for Node, one for React Native and browsers — and nothing keeps them in step. One export went missing and was caught only by a downstream build breaking; nineteen modules currently differ between them, and the newly built proof-verification code is one of them, so browser consumers cannot check a proof at all.
prereq:
files: packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/cohort-topic/peer-sig.ts, packages/quereus-plugin-optimystic/src
difficulty: medium
----

# The Node and RN entry points drift silently

`backlog/bug-rn-entry-omits-with-read-cache` was the symptom: `index.ts:25` exports
`./storage/with-read-cache.js`, `rn.ts` did not, and the omission surfaced as a **downstream build
failure** in sereus rather than as anything red in this repo. That one line is now fixed directly
(the module imports only sibling storage modules already on the RN entry, so it was unambiguously
accidental). This ticket is the class behind it.

## What the drift actually is

Comparing the two entries at the time of filing, `rn.ts` is missing **19** modules that `index.ts`
exports. Some omissions are deliberate and documented in-file — there is a comment explaining that
only `cohort-topic/peer-sig` is surfaced because the rest of `./cohort-topic` pulls node-heavy
`host.js`. Others are unexplained, and at least one matters right now:

- **`cluster/commit-proof.js` is absent from the RN entry.** That is the whole verification surface
  of the commit-certificate work — the thing that decides whether a block's content is provably what
  a cohort committed. A React-Native or browser consumer currently cannot verify a proof at all.
  Its imports are `@optimystic/db-core`, `@libp2p/peer-id`, `@libp2p/crypto/keys` and `uint8arrays`;
  `peer-sig` already ships `@libp2p/peer-id` and `@noble/curves` through this entry, so it is
  plausibly browser-safe — but `@libp2p/crypto/keys` needs checking before it is added, because
  pulling Node crypto into an RN bundle breaks the entry in the other direction.
- Others in the gap, unexamined: `cluster/client-signature-verifier`, `cluster/commit-cert`,
  `cluster/rebalance-monitor`, `cluster/spread-on-churn`, `cluster/block-transfer`,
  `cluster/block-transfer-service`, `inbound-authorization`, `storage/block-archive`,
  `reputation/index`, `dispute/index`, `matchmaking/index`, `reactivity/index`, the three
  transaction-state-store modules, and the two kv-store modules.

## What to decide, then build

1. **Classify every one of the 19.** Each is either (a) belongs on both entries — add it, or (b)
   Node-only — record *why*, in the file, next to the exclusion list. No third category. The
   `cohort-topic` comment is the model.
2. **Add a guard so this fails here, not downstream.** A spec comparing the two entries' export sets
   against a declared exclusion list, so adding a module to `index.ts` without a decision about
   `rn.ts` fails the build. The downstream repo already uses this shape for its duplicated schema
   copies, held identical by a drift spec.
3. **Verify RN-safety by construction, not by eye.** A module list is only as good as the check that
   nothing on it drags in a Node builtin. If there is a cheap way to assert that (an import-graph
   walk over the RN entry looking for `node:`-prefixed or known-Node-only specifiers), prefer it to a
   hand-maintained list.

The plugin's own `/rn` build is the natural canary — it is what caught this one — so wiring it into
CI would be a defensible alternative to (3) if the import-graph check proves fiddly. Say which you
chose.

## Edge cases & interactions

- **Class identity.** The downstream `cached-storage.ts` comment asserts that both entries re-export
  the same storage modules and relies on it for `instanceof` checks. A module exported from only one
  entry gives two class identities on Node; that assumption should be stated somewhere it can be
  checked, not left in a downstream comment.
- **Bundle size.** Adding modules to the RN entry costs browser consumers bundle weight even when
  tree-shaking works; anything large and genuinely Node-shaped should stay out with a reason.
- **`libp2p-node.js` vs `libp2p-node-rn.js`** is the one intended asymmetry — the guard must model it
  as a mapping, not flag it as drift.
