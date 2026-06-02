description: Review the restored cluster membership/responsibility scoping on the ClusterService update path (record.peers-authoritative redirect) and the dead-knob reconciliation
files: packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/repo/redirect.ts, packages/db-p2p/test/cluster-service-redirect.spec.ts
----

# Review: re-enable cluster membership/responsibility scoping on the update path

## What shipped

The cluster `'update'` path now scopes consensus participation to the peers the
coordinator actually addressed, instead of unconditionally calling
`cluster.update(...)` for every peer that receives an update. The membership gate
that was disabled behind a `TEMPORARY` comment is restored — but reimplemented to
be **regression-proof against the "empty promises" symptom** that caused the
original disable.

### Core change — `packages/db-p2p/src/cluster/service.ts`

- **New `ClusterService.checkRedirect(record): RedirectPayload | null`** (public,
  unit-testable). Membership is scoped against **`record.peers`** — the
  authoritative set the coordinator already computed and embedded — **not** an
  independently recomputed `getCluster(sha256(...))`. This is the key design
  decision: the coordinator only ever dials peers in `record.peers`
  (`cluster-coordinator.ts` → `collectPromises(peers, record)` with
  `peers === record.peers`), so any peer that legitimately receives an update is
  by construction in `record.peers` and is therefore **never** redirected. That is
  precisely what avoids the empty-promises regression the old recompute caused.
  - Returns `null` (→ process locally) when: no self `peerId` (can't scope),
    `record.peers` empty (nothing to scope against), self **is** a member, or the
    peer set is smaller than `responsibilityK` (small-mesh bypass).
  - Returns `encodePeers(others)` (reusing `repo/redirect.ts`, `reason:
    'not_in_cluster'`) when the peer set is ≥ `responsibilityK` and self is **not**
    a member. Redirect addrs prefer `record.peers[id].multiaddrs`, falling back to
    a `getConnectionAddrs` lookup only when empty.
- **Update path** (`handleIncomingStream` → `processStream`): the `TEMPORARY`
  unconditional `cluster.update` is replaced with
  `const redirect = this.checkRedirect(message.record); response = redirect ?? await this.cluster.update(message.record)`.
  The existing `ClusterClient.update` already follows redirect responses (hop-limit
  + loop detection), so **no client-side change** was needed.
- **`responsibilityK` is now live**: read in the constructor
  (`this.responsibilityK = init.responsibilityK ?? 1`) and used for the small-mesh
  bypass.
- **Dead init knobs removed**: `kBucketSize`, `configuredClusterSize`,
  `allowClusterDownsize`, `clusterSizeTolerance` deleted from `ClusterServiceInit`
  (the constructor never read them; consensus quorum / downsize policy is governed
  by `consensusConfig` flowing into `ClusterMember`/`CoordinatorRepo`/
  `NetworkManagerService`, which is unchanged).
- **Components extended**: optional `peerId?: PeerId` and
  `getConnectionAddrs?: (peerId) => string[]` added to `ClusterServiceComponents`,
  mirroring `RepoServiceComponents`.
- **Verbose debug logging removed**: the `cluster-service:pre-serialize` /
  `post-serialize` diagnostic block (added while debugging empty-promises) is gone;
  the update path now just serializes the response.

### Wiring — `packages/db-p2p/src/libp2p-node-base.ts`

- Cluster wrapper now passes `peerId: components.peerId` and a
  `getConnectionAddrs` resolver into the cluster service, and **stops** passing the
  removed dead knobs. (`peerId` is a core libp2p component available at
  service-construction time; without it `checkRedirect` would no-op and the gate
  would stay inert, as it was before.)

## What was DEFERRED (read this — it is the main honesty flag)

**The repo wrapper was deliberately left inert.** The ticket asked to "while here"
also forward `peerId`/`networkManager`/`getConnectionAddrs` to the **repo** wrapper
so `RepoService.checkRedirect` is no longer inert, *"if it risks breaking live
behavior, isolate it and note the deferral."* It does risk it, so it was deferred:

- `RepoService.checkRedirect` derives the responsible set via
  `nm.getCluster(sha256(blockKey))` — an **extra sha256** over the raw bytes.
- The coordinator forms the cluster via `keyNetwork.findCluster(encode(blockId))`
  → `hashKey(encode(blockId))` on the **raw** blockId bytes (no sha256).
- These two coordinates differ, so `getCluster(sha256(...))` can yield a different
  cohort than the coordinator used. Un-inerting the repo redirect would let a peer
  the coordinator legitimately routed to redirect the request away — the **same
  divergence class** that caused the cluster-path empty-promises regression this
  ticket fixes. Unlike the cluster path, the repo path does **not** have a
  `record.peers` authoritative set to trust, so the safe fix is non-trivial.
- A code comment documenting this deferral was added at the repo wrapper in
  `libp2p-node-base.ts`. **No behavior change** to the repo path: it stays inert
  exactly as before this ticket.

**Reviewer decision needed:** whether to (a) accept the deferral and file a
follow-up to reconcile `RepoService.checkRedirect`'s key derivation with the
coordinator's (raw bytes, no sha256) before activating it, or (b) treat it as out
of scope entirely. Recommendation: file a `fix/` or `backlog/` ticket — the repo
`checkRedirect` is dead code today and its sha256 path is a latent bug, but fixing
it properly is its own unit of work. (The existing `test/redirect.spec.ts` covers
the repo `checkRedirect` logic in isolation but, like before this ticket, it is
never exercised in a live node.)

**The optional defense-in-depth cross-check was NOT implemented** (recompute the
cohort via the coordinator's exact derivation and cross-check against
`record.peers`). The ticket marked it out-of-scope unless trivially safe; it is
not trivially safe (it would require wiring `keyNetwork`/`networkManager` into the
cluster service and getting the raw-bytes derivation exactly right), so it was
deferred. The chosen `record.peers`-authoritative approach already satisfies the
ticket's primary correctness goal.

## Validation

From `packages/db-p2p`:

- `yarn build` — clean (tsc, silent, exit 0).
- `yarn test` — **483 passing, 7 pending, 0 failing** (~20s). The 7 pending are
  pre-existing env-gated cases. No pre-existing failures surfaced.
- New spec `test/cluster-service-redirect.spec.ts` — **9 passing** in isolation.
- There is no lint script in the package; tsc is the effective gate and is clean.

## Use cases / what the reviewer should scrutinize

The new tests (`test/cluster-service-redirect.spec.ts`, modeled on
`redirect.spec.ts`, real Ed25519 peer ids) cover, and are the **floor not the
ceiling**:

- self NOT in `record.peers`, `peers.size >= responsibilityK` → redirect with
  `reason: 'not_in_cluster'`, peers exclude self, `cluster.update` NOT called.
- self IN `record.peers` → `null`, `cluster.update` IS called (the explicit
  no-empty-promises-regression assertion).
- `peers.size < responsibilityK` (small mesh), self not a member → `null`
  (processed locally).
- no `peerId` in components → `null`; empty `record.peers` → `null`.
- `responsibilityK` defaulting to 1.
- redirect addrs: prefer `record.peers[id].multiaddrs`, else `getConnectionAddrs`.

Suggested adversarial angles for the reviewer (gaps / things tests do NOT cover):

- **Semantics of `responsibilityK` for the small-mesh bypass.** The bypass compares
  `record.peers.length < responsibilityK`. With the default `K=1`, *any* non-empty
  non-member set redirects. Confirm this matches the intended responsibility model
  and the repo-path semantics (which compares against a recomputed `cluster.length`,
  a subtly different quantity — repo compares the *recomputed cohort* size, cluster
  compares the *embedded peer set* size). They will usually agree but can differ.
- **`getSelfId()`/`getPeerAddrs()` fallback to `(components as any).libp2p`.** In the
  real node we pass `peerId` and `getConnectionAddrs` explicitly, so the `libp2p`
  fallback is only a safety net. Worth confirming `components.peerId` is in fact
  populated at cluster-service construction time in a live node (if it were ever
  `undefined`, the gate silently no-ops and every peer processes every update — the
  pre-ticket behavior — which is safe-but-unscoped; not a correctness break but
  worth a sanity check via a running mesh).
- **Live mesh behavior is NOT covered by a running-node test here** — only unit
  tests of `checkRedirect`. The end-to-end "non-member peer actually redirects and
  the coordinator still collects enough promises" path relies on the
  `record.peers`-authoritative argument being correct. The existing integration/
  consensus specs (`cluster-coordinator*.spec.ts`, `cluster-repo.spec.ts`,
  `byzantine-fault-injection.spec.ts`) all still pass, which is the main evidence
  that the restored gate does not re-introduce empty promises, but none of them was
  written specifically to assert a redirect-then-reroute round trip.
- **`peerIdFromString(id)` in `getPeerAddrs`** is wrapped in try/catch returning
  `[]` — only reached on the empty-multiaddrs fallback path. Low risk.

## Notes for the reviewer

- Minor findings → fix inline. The one likely-major item (repo-wrapper deferral) is
  already scoped above as a follow-up ticket candidate rather than something to fix
  in this review, since reconciling the repo key-derivation is a separate unit of
  work with its own regression risk.
- Do not "finish the job" by un-inerting the repo path without first fixing the
  sha256-vs-raw-bytes derivation mismatch — that would re-introduce the exact
  regression this ticket was created to avoid.
