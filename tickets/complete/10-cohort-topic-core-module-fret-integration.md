description: Reviewed and shipped — the CohortTopicService / CohortMemberEngine db-core composition plus the db-p2p FRET host that registers the four /optimystic/cohort-topic/1.0.0/* protocols and binds db-core's ports to FRET + libp2p. Build + tests green; the deliberately-interim "mock-tier e2e pending" gaps were verified sound and tracked forward in plan/cohort-topic-live-tier-fret-binding.
files:
  - packages/db-core/src/cohort-topic/service.ts, member-engine.ts, index.ts
  - packages/db-p2p/src/cohort-topic/host.ts, protocols.ts, topic-router.ts, cohort-gossip-transport.ts, membership-source.ts, membership-publish-sink.ts, threshold-crypto.ts, size-estimator.ts, peer-codec.ts, stream-util.ts
  - packages/db-p2p/test/cohort-topic/coord-byte-compat.spec.ts, service.spec.ts, peer-codec.spec.ts
  - docs/architecture.md, docs/internals.md, docs/cohort-topic.md
----

# Complete: CohortTopicService + full FRET integration

The capstone that assembled the cohort-topic substrate's prereq modules into the participant-facing
`CohortTopicService`, the cohort-side `CohortMemberEngine`, and a db-p2p FRET host registering the
four `/optimystic/cohort-topic/1.0.0/*` protocols. db-core stays FRET-free (port-injected); db-p2p
binds the ports to FRET + libp2p. Validated at mock-tier; live-tier e2e is tracked forward.

## Review findings

Adversarial pass over the implement-stage diff (`1c12403`), read with fresh eyes before the handoff.
Scrutinized for SPP/DRY, modularity, type safety, resource cleanup, error handling, correctness,
wire/byte compatibility, and test completeness (happy / edge / error / regression / interaction).
**lint** is a no-op echo in this repo, so the type-check floor is `tsc` (`yarn build`) — run green for
db-core, db-p2p, and quereus-plugin-optimystic. **tests** green: db-core 533, db-p2p 517 (+4 added
below) / 9 pending, quereus-plugin-optimystic 205 / 4 pending.

### Minor findings — fixed in this pass

- **Weak / collision-prone correlation id** (`service.ts` `freshCorrelationId`). It derived 16 bytes
  from `clock()` (with an overlapping-nibble bit-pack) + the participant id — so two probes in the same
  millisecond for one participant produced the **same** correlation id, and the `CorrelationReplayGuard`
  keys on exactly that id (a legitimate second register would read as a replay → `no_state`). Also a DRY
  miss: db-core already uses `randomBytes` from `@noble/hashes/utils.js` (`collection.ts`,
  `transactor-source.ts`). **Fixed:** `freshCorrelationId` now returns `bytesToB64url(randomBytes(16))`.
  Latent today (the host leaves the replay guard unwired) but a live landmine; the fix is also called
  out in the follow-on's anti-DoS gap.

- **`withdraw()` did not actually stop renewal** (`service.ts`). The `renewals` map was only ever
  `.set`/`.delete`d — **never read** — so `withdraw()` deleted an unused entry while `renew(handle)`
  pinged `handle.renewal.pingLoop()` directly; an app that kept calling `renew` after `withdraw` kept
  refreshing the registration, contradicting the documented "stop renewing" contract. **Fixed:**
  `renew()` now short-circuits when the handle's key is absent from the live set, giving the previously
  dead map a purpose and `withdraw()` real local teeth. New regression test added (below). The *remote*
  half (a withdraw tombstone) is filed as out-of-scope in the follow-on.

- **False `makeCohortTopicProtocols` docstring** (`protocols.ts`). It claimed the `"default"` network
  "yields the canonical IDs in `DEFAULT_COHORT_TOPIC_PROTOCOLS`". Verified against the installed
  `p2p-fret`: `makeProtocols("default")` → `/optimystic/default/fret/1.0.0/...`, i.e. FRET inserts the
  segment even for default. So `makeCohortTopicProtocols("default")` → `/optimystic/default/cohort-topic/...`,
  which does **not** equal the canonical, segment-less `DEFAULT_COHORT_TOPIC_PROTOCOLS`. The function
  correctly mirrors FRET; only the doc was wrong. **Fixed:** docstring now states this explicitly. (No
  interop bug: the host defaults to the canonical set, and all cohort-topic peers use the same IDs.)

- **Host returned before its protocol handlers were live** (`host.ts`). The four `node.handle(...)`
  calls were fire-and-forget (`void`), so `createCohortTopicHost` could resolve — and the node be
  dialed — before libp2p finished registering the handlers (a real race; `handle` is async). **Fixed:**
  `registerProtocolHandlers` is now `async` and awaits all four via `Promise.all`, and the host awaits
  it before setting the activity handler.

### Minor findings — accepted as-is (with reason)

- **`samePeer` is an unused export** and `host.ts countPrimaryTopics` reimplements peer equality via
  base64url string compare rather than `samePeer`/`bytesEqual`. Left as-is: the string form is there to
  feed a `Set` for dedup, and removing a small public utility is lower value than the churn. Noted, not
  fixed.

- **`lookup()` shares the registration walk** (leaves TTL-expiring soft state) and **`withdraw()` has
  no wire tombstone**. The API-contract wording is honest and acceptable for now; both remote-side
  follow-ons are captured in `plan/cohort-topic-live-tier-fret-binding` (out-of-scope section).

### Verified correct (no change needed)

- **Stream lifecycle is not a bug.** `requestResponse` does `send → await stream.close() → readAllBounded`,
  which *looks* like reading after close — but FRET's own `sendMaybeAct` (`p2p-fret/rpc/maybe-act.ts`)
  uses the identical sequence; `close()` is the graceful write-half close in this libp2p version, and the
  reply still reads. The stream-util header's "mirrors FRET exactly" claim is accurate. Handlers `abort`
  on error and `close` in `finally` — resource cleanup is sound.
- **Coord byte-compat** (`coord-byte-compat.spec.ts`) asserts `RingHash().H(x) == FRET hashKey(x)` over
  five representative inputs (empty, single byte, short, 32-byte, UTF-8 string) at the pinned 256-bit
  ring. Inputs are adequate; full-digest SHA-256 on both sides makes broader fuzzing low-value.
- **`currentCohort()` epoch derivation** dedupes self (prepends `selfMemberBytes`, filters it out of the
  assembled peer list) and rotates the epoch deterministically from the sorted member set — correct.
- **`threshold-crypto.verify`** recomputes `sha256(payload)` and ignores `signers`; correct for the
  interim digest, and the `≥ minSigs distinct members` rule is enforced one layer up in `CohortSigner`.
- **The interim gaps are genuinely cohort-distributed**, not shortcuts in the wired surface — each is
  isolated behind a clean seam (`ICohortThresholdCrypto`, `ParticipantSigner`, the engine's optional
  anti-DoS injections, the cold-start `parentRegistrar`). Verified before filing the follow-on.

### Test completeness — gaps filled

The implementer's suite was an honest floor (single-member mock mesh + handshake). Added in this pass:

- `peer-codec.spec.ts` (new) — round-trips a real Ed25519 peer id through `peerIdToBytes` /
  `bytesToPeerIdString` / `bytesToPeerId` (the encoding the wire depends on had **zero** coverage),
  asserts string-vs-PeerId encode equivalence, and confirms the fatal UTF-8 decoder rejects garbage
  bytes rather than fabricating a bogus peer.
- `service.spec.ts` — added a `withdraw` regression: a live handle dials its primary once on `renew`,
  and a post-`withdraw` `renew` performs **no** further dial (locks in the dead-map fix).

Remaining uncovered paths (host activity callback, cold-path instantiate, anti-DoS short-circuits,
gossip broadcast/deliver) are inherently multi-node and belong to the live-tier e2e milestone, not a
unit floor — see the follow-on.

### Major findings — filed forward

- **`plan/cohort-topic-live-tier-fret-binding`** — the deliberately-interim "mock-tier → live-tier"
  gaps the implementer documented and the review confirmed sound: real `k − x` threshold-signature
  assembly, participant peer-key signing, per-coord cohort scoping, `promote` verify-and-apply, gossip
  publishing cadence, anti-DoS wiring, and cold-start parent registration. These are cohort-distributed
  operations one node cannot fake; they need a round-protocol design, hence `plan/` rather than `fix/`.

### Out-of-diff observation (no action — already landed, correct, tested)

The implement commit (`1c12403`) also bundled **unrelated** changes: `db-core` `collection.ts` /
`tree.ts` replaced `discardPending`/`discardChanges` with `snapshotPending`/`restorePending` /
`snapshot`/`restore`, and `quereus-plugin-optimystic` `txn-bridge.ts` / `optimystic-module.ts` +
new `deferred-constraint-rollback.spec.ts` switched the dirty-tree rollback from blanket-clear to
pre-stage snapshot/restore (so a never-synced collection's header/root survives a deferred-constraint
rollback). This is the deferred-constraint atomicity fix, not cohort-topic work, and the implement
handoff never mentioned it. The code is correct and its tests pass (quereus 205/4 pending), and the
commit is already landed, so there is nothing to undo — flagged here only so the history is not
misread as part of the cohort-topic capstone.

## Done-when (met)
- `yarn build` green for db-core, db-p2p, quereus-plugin-optimystic. ✅
- `yarn test` green: db-core 533, db-p2p 517 / 9 pending, quereus-plugin-optimystic 205 / 4 pending. ✅
- Docs reflect reality: `architecture.md` Doc Sync (substrate implemented, mock-tier e2e pending),
  `internals.md` Service composition + Protocol IDs sections, `cohort-topic.md` §FRET integration. ✅
- Interim gaps verified sound and tracked in `plan/cohort-topic-live-tier-fret-binding`. ✅
