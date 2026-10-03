description: The first machine to subscribe to a newly watched collection is told "not yet, ask again" and only gets in about half a minute later, because the group serving the subscription has not yet heard whether its members are willing; the group should instead ask its members at once, wait a moment for their answers, and accept the subscription in the same request.
architecture: docs/cohort-topic.md#cold-start-instantiation
files: packages/db-core/src/cohort-topic/willingness.ts, packages/db-core/src/cohort-topic/member-engine.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts, packages/db-p2p/src/reactivity/collection-watch.ts, packages/db-core/test/cohort-topic/willingness.spec.ts, packages/db-core/test/cohort-topic/member-engine.spec.ts, packages/db-p2p/test/cohort-topic/live-tier.spec.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, docs/cohort-topic.md, docs/reactivity.md
difficulty: hard
----

# A new topic admits its first registration without a second ask

## The defect, traced

A subscriber registers with the group of machines serving a topic's root. For a topic nobody has registered under, the walk (`RouterWalkEngine.register` in `packages/db-core/src/cohort-topic/walk.ts`) sends a plain frame (answered `no_state`), then the same frame with `bootstrap: true`. The routed member (`StoreCohortMemberEngine.handleRegister` in `packages/db-core/src/cohort-topic/member-engine.ts`) passes every anti-abuse gate, instantiates the cold-start forwarder, and runs the willingness check (`GossipWillingnessCheck.evaluate` in `packages/db-core/src/cohort-topic/willingness.ts`). That check counts the members whose *gossiped* willingness it holds plus itself. The engine for this coordinate was created by this very register, so its gossip view is empty: one willing member against a quorum of a strict majority (2 of a 3-machine root group). It answers `unwilling_cohort`, `retryAfterMs` 1000.

Nothing tells the siblings to speak up quickly. The routed engine heartbeats its willingness on its first idle gossip round (driver tick every 5 s, `DEFAULT_GOSSIP_INTERVAL_MS`); each sibling instantiates its own engine on that frame (`maybeInstantiateColdSibling` in `packages/db-p2p/src/cohort-topic/host.ts`), then heartbeats back on *its* next tick. So the group is ready about 5–10 s after the first ask, but the subscriber does not come back until the watch service's next tick (30 s Core). Asking sooner is penalised: the per-(peer, topic) limiter allows 4 register frames a minute (`DEFAULT_REGISTER_RATE_PER_PEER`, `DEFAULT_RATE_WINDOW_MS` in `packages/db-core/src/cohort-topic/antidos/rate-limiter.ts`), and the first attempt alone spends two.

The decline is not "my members are unwilling" — it is "I have not heard from my members yet". The fix makes the group tell those apart and handle the second case inside the request.

## Decision: accept once the members have answered (option 1 of the plan ticket)

Chosen over "name a realistic retry delay and exempt the retry from the limiter" because:

- it needs no participant change — the walk, the service and the watch service keep their logic, and every other user of the substrate (matchmaking) benefits;
- it leaves the rate limiter's arithmetic untouched (an exempt retry would need a token or a carve-out an attacker could aim at);
- a delay the group names would be a guess (gossip timing, root-group snapshot reads), whereas waiting on the answers themselves is exact.

Its cost is that the routed member holds the register stream open for a short, bounded time. The participant reads the reply with p2p-fret's `RPC_TIMEOUT_MS` (5 s, applied by `readFramed` for both the FRET-routed path and the direct root-group dial in `FretTopicRouter`), so the wait must stay well under 5 s. Default **2 s**.

## Design

### 1. Willingness says *why* the quorum is short (db-core, `willingness.ts`)

`WillingnessDeps` gains the current cohort membership (the member strings, base64url, the form `selfMember` and the view keys already use) — e.g. `cohortMembers: () => readonly string[]`. `UnwillingCohortOutcome` gains a boolean (suggested name `awaitingMembers`) that is true iff the quorum is short **and** would be met if every cohort member not yet in the view (excluding self) turned out willing:

```
willing   = willing siblings in view + (self live-willing ? 1 : 0)
unheard   = |cohortMembers \ view keys \ {self}|
awaitingMembers = willing < quorum && willing + unheard >= quorum
```

A member that has gossiped unwilling counts as heard, so a cohort whose answers are in and short gets `awaitingMembers: false` — today's plain decline. The out-of-range-tier branch stays `awaitingMembers: false`. View entries from members no longer in the cohort keep counting as willing siblings exactly as today (unchanged behaviour, not this ticket's concern).

### 2. The member engine waits once, then re-decides (db-core, `member-engine.ts`)

`CohortMemberEngineDeps` gains an optional port (absent ⇒ today's behaviour exactly), suggested shape:

```ts
export interface QuorumWait {
	/**
	 * Resolve when `ready()` turns true or the wait's deadline passes, with the clock at which it settled.
	 * Resolves at once (with `now`) when no wait can be opened: closed engine, solicitation throttled, waiter cap reached.
	 */
	until(ready: () => boolean, now: number): Promise<number>;
}
```

In `admitOrDecline`, on `unwilling_cohort` with `awaitingMembers` and a `quorumWait` present (and only on the first pass — pass a flag so the re-decision cannot wait again):

- `settledAt = await quorumWait.until(() => !stillAwaiting(reg), now)` where `stillAwaiting` re-runs `willingness.evaluate` and is true while the outcome is `unwilling_cohort` with `awaitingMembers`;
- then re-enter the hot-path decision at `settledAt`: if the topic is now promoted answer `promotedRedirectReply`; if it is no longer served (topic-budget eviction tore the forwarder down mid-wait) answer `unwilling_cohort`; otherwise `admitOrDecline` again without wait permission, and `accept` stamps `attachedAt`/`lastPing` with `settledAt`, not the stale `now`.

The probe path (`handleProbe`) never waits.

### 3. The host opens the wait and makes members answer at once (db-p2p, `host.ts`)

Per `CoordEngine` (`createCoordEngine` region where `willingness` and `engine` are built):

- **Feed membership** to the willingness check from `cohort().members` (bytes → base64url).
- **Supply `quorumWait` only where answers can arrive**: a tier-0 engine on a live-signer host (the same two conditions `maybeInstantiateColdSibling` requires — a tier-`d > 0` frame or a key-less host never makes a cold sibling instantiate, so waiting there would only add latency to a decline). Elsewhere leave it absent.
- **One shared wait per engine.** The first `until` call opens a wait: it sends the solicitation (below), records the deadline `now + coldQuorumWaitMs`, and subscribes to the engine's bus with `bus.onGossip`; each inbound merge re-tests every waiter's `ready()` and resolves the ones now ready; the deadline timer resolves the rest and closes the wait. A call while a wait is open joins it (up to a waiter cap — a constant, 64, with a `NOTE:` — beyond which it resolves at once). A call when no wait is open and a solicitation was already sent within the last `gossipIntervalMs` resolves at once (decline, as today) — this is what stops a member that never answers (dead, partitioned) from turning every register on the engine into a 2 s hold. Engine close resolves every waiter at once and clears the timer (the engine is otherwise inert after close; keep that true).
- **Solicitation = an out-of-band willingness advert.** Build the heartbeat-shaped frame with `buildCohortGossip` (`heartbeat: true`, no summaries, no deltas — nothing drained from `pending`, no sweep), sign it with `ctx.signGossip`, broadcast it on the bus, and set `lastGossipAt` so the routine idle heartbeat does not repeat it. Only an **idle** engine (no resident topics and nothing queued in `pending`) adverts out of band: a contribution merges last-writer-wins as a whole, so a summary-less frame from an engine holding records would blank its topic summaries in every sibling's view until its next round. A non-idle engine already gossips every round. Throttled to one advert per engine per `gossipIntervalMs` (the engine context needs that value; it has `willingnessHeartbeatMs` today).
- **Answer a member heard for the first time.** Each engine keeps the set of members (excluding self) it has ever merged a frame from; an `onGossip` handler that sees a new one sends the out-of-band advert (same helper, same throttle, same idle rule), fire-and-forget with any signing/broadcast failure logged. This is what makes a cold sibling — instantiated by the solicitation itself, and so hearing the routed member for the first time — answer within one delivery instead of on its next tick; it also lets a member newly rotated into a cohort learn its siblings' willingness at once. It fires at most once per newly-heard member per engine, and the throttle caps it per engine.

New host option, suggested `coldQuorumWaitMs` (default 2000, `0` disables the wait), plumbed like `willingnessHeartbeatMs`. Its doc comment states the 5 s participant read bound it must stay under.

### What the convergence looks like on the integration mesh

Bootstrap register reaches routed member R → R instantiates the forwarder, evaluates `awaitingMembers: true` (1 willing + 2 unheard ≥ 2), opens the wait and adverts → each sibling's `/cohort-gossip` handler instantiates its root-placed engine (root-group snapshot read) and merges R's frame → the new engine has heard R for the first time and adverts back → R merges one sibling's willingness, quorum 2 met → the waiter re-decides and R answers `accepted` on the same stream. Expected: well under a second on a local mesh.

### Anti-abuse argument (record it in `docs/cohort-topic.md` §Anti-DoS)

- No new frames per cold start: the routed member's first idle heartbeat and each sibling's first heartbeat were already sent; they are now sent sooner. The first-heard rule adds at most one advert per newly heard member per engine, throttled per engine.
- The wait runs only after every existing gate passed — participant signature, rate limiter, bootstrap evidence (cold start costs the same proof as before), replay guard, topic budget — so making many groups start up costs exactly what it did.
- What a register can now hold is one stream for at most `coldQuorumWaitMs`, only while its engine is in the not-yet-heard state, at most one solicitation window per `gossipIntervalMs`, and at most the waiter cap per engine.

## Edge cases & interactions

- **Members heard and genuinely short** (some answered unwilling, or too few exist): `awaitingMembers: false`, immediate decline as today. Verified by the willingness test below.
- **A member never answers** (down, partitioned, or its engine pre-existed and already heard R's previous incarnation — the restart case): the wait times out, decline as today; later registers inside that `gossipIntervalMs` decline at once rather than each waiting. The restart case stays slow (the sibling's idle heartbeat is 30 s away); record it as a `NOTE:` tripwire at the first-heard handler — if it shows up, add a signed "please answer" bit to the gossip frame instead of inferring it from first contact. Verified by inspection.
- **Several registers arrive during one wait**: they share the wait; each re-decides independently on resolution; each admitted record is replicated through `onAdmit` as usual. Inspection.
- **Engine closed or evicted mid-wait**: the engine holds a forwarder (pinned, so not evictable) on the cold path and records or a forwarder on the hot path; close (host stop) must still resolve waiters and clear the timer. Inspection.
- **Topic promoted or budget-evicted mid-wait**: handled by re-entering the hot-path decision after the wait (step 2). Inspection.
- **Wait deadline vs the participant's 5 s read**: default 2 s leaves margin for a FRET-routed hop and the root-group dial loop. Inspection plus the integration timing below.
- **Tier `d > 0` and key-less hosts**: no `quorumWait` supplied, behaviour unchanged. Inspection.
- **Out-of-band advert vs the driver tick**: the advert drains nothing and updates `lastGossipAt`, so a tick racing it neither double-sends deltas nor re-heartbeats; a non-idle engine never adverts out of band. Inspection; `gossip-cadence.spec.ts` must stay green.
- **Probe frames**: never wait, never advert. Inspection.
- **Rate limiter**: unchanged; the first attempt still spends two frames, but now lands. Inspection.

## Tests

- `packages/db-core/test/cohort-topic/willingness.spec.ts` — one test pinning `awaitingMembers`: 3-member cohort, quorum 2, empty view ⇒ `unwilling_cohort` with `awaitingMembers: true`; the same with one sibling's frame merged as unwilling and the other also merged unwilling ⇒ `awaitingMembers: false`.
- `packages/db-core/test/cohort-topic/member-engine.spec.ts` — one test: a bootstrap register whose first evaluation is `awaitingMembers`, with a fake `quorumWait` that merges a willing sibling before resolving, is answered `accepted` and the record is stored; with a `quorumWait` that resolves without any merge it is answered `unwilling_cohort`.
- `packages/db-p2p/test/cohort-topic/live-tier.spec.ts` case 5b — rewrite: the cold cohort's **first** `service.register` resolves to a handle (no `CohortBackoffError`, no manual gossip pumping before it), a sibling instantiated its engine, and the record replicates. This is the host-level reproduction; it currently asserts the decline. If the mock mesh only delivers gossip when pumped, make its transport deliver a broadcast on send (or pump concurrently while the register is in flight) — say which in the handoff.
- `packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts`, "collection watch over real libp2p (every machine in every cohort)" — no assertion changes. Run it (`OPTIMYSTIC_INTEGRATION=1`, grep the describe) and record the measured time from `watch()` to `isAttached` in the review handoff; the target is a few seconds, down from ~30 s.

## Docs and comments to update

- `docs/cohort-topic.md` §Willingness (the `UnwillingCohort` bullet: distinguish unheard from unwilling), §Cold-start instantiation → *Bootstrapping a cold multi-node cohort* (the convergence paragraph now ends with the first register admitted on the same request; describe the wait, the solicitation and the first-heard answer), §Anti-DoS (the argument above), §Configuration defaults table (new row, e.g. `T_cold_quorum_wait` 2 s, with the 5 s bound).
- `docs/reactivity.md` §The node's watch service, the *Attach* bullet (first attach is no longer ~30 s), and the "Decided, not built: the outgoing root does not tell its direct subscribers" bullet in §Tail rotation: the cold-start half of its revisit condition is now met; the other half (tail check as dominant wake latency on busy collections) is unmeasured, so the decision stands — say so and drop the ~30 s figure.
- `packages/db-p2p/src/reactivity/collection-watch.ts` — the accepted-tradeoff `NOTE:` in `moveTo` that cites this ticket: rewrite to the new reality (a decline now means the group's members did not answer within the wait; the tick retries).
- `docs/internals.md` if any sentence there states the 30 s first attach (grep; none found at planning time).

## TODO

- Willingness: add the membership input and the `awaitingMembers` flag; willingness test.
- Member engine: `QuorumWait` port, single wait-then-re-decide in `admitOrDecline` with `settledAt`; member-engine test.
- Host: membership feed; per-engine shared wait with deadline, throttle, waiter cap, close handling; out-of-band idle advert helper; first-heard answer via `bus.onGossip`; `coldQuorumWaitMs` option plumbed and documented; tripwire `NOTE:`s (restart case, waiter cap).
- Rewrite live-tier 5b; run `gossip-cadence.spec.ts`, `host-antidos-coldstart.spec.ts`, `live-tier.spec.ts`, the db-core cohort-topic specs, then the integration case; record attach timing.
- Docs and the collection-watch `NOTE:` as listed; `yarn lint:docs`.
- `yarn build`, `yarn typecheck`, `yarn test` in db-core and db-p2p.
