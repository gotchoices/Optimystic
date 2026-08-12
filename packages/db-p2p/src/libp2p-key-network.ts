import type { AbortOptions, Connection, Libp2p, PeerId, Stream } from "@libp2p/interface";
import { toString as u8ToString } from 'uint8arrays'
import type { ClusterPeers, CoordinatorIntent, FindCoordinatorOptions, IKeyNetwork, IPeerNetwork } from "@optimystic/db-core";
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import type { FretService, SerializedTable } from 'p2p-fret'
import { hashKey } from 'p2p-fret'
import { createLogger, verbose } from './logger.js'
import type { IPeerReputation } from './reputation/types.js'

interface WithFretService { services?: { fret?: FretService } }

export type NetworkMode = 'forming' | 'joining';

/**
 * Error codes surfaced by {@link Libp2pKeyPeerNetwork.findCoordinator}. Callers
 * (notably the batch-retry logic in `NetworkTransactor`) can inspect `.code`
 * to distinguish between "transient — try again with different excludes" and
 * "terminal — stop retrying".
 */
export const FIND_COORDINATOR_ERROR_CODES = {
	/**
	 * Last-resort self-coordination was blocked by a HARD verdict from the
	 * self-coordination guard — self-coordination switched off by config, or a detected
	 * partition / suspicious shrinkage on a WRITE. Retrying is unlikely to help. A
	 * *deferrable* denial (see {@link SelfCoordinationDecision.deferrable}) never produces
	 * this code: selection degrades to self with a warning instead.
	 */
	SELF_COORDINATION_BLOCKED: 'SELF_COORDINATION_BLOCKED',
	/**
	 * Self-coordination was already attempted and self is now excluded. On a solo
	 * or bootstrap node with no other peers, this means retries are exhausted and
	 * the original error from the prior attempt should be surfaced instead.
	 */
	SELF_COORDINATION_EXHAUSTED: 'SELF_COORDINATION_EXHAUSTED',
	/** No peer (including self) is an eligible coordinator. */
	NO_COORDINATOR_AVAILABLE: 'NO_COORDINATOR_AVAILABLE',
	/**
	 * The candidate set was non-empty but every non-self candidate serves a
	 * DIFFERENT network's protocol (or none of this network's). Distinct from
	 * NO_COORDINATOR_AVAILABLE so a Sereus-style trace points at the real cause —
	 * "peer(s) do not serve this network's protocol" — instead of a generic
	 * "all candidates excluded" / super-majority failure.
	 */
	NO_NETWORK_COORDINATOR: 'NO_NETWORK_COORDINATOR'
} as const;

export type FindCoordinatorErrorCode =
	typeof FIND_COORDINATOR_ERROR_CODES[keyof typeof FIND_COORDINATOR_ERROR_CODES];

/**
 * Network-membership classification of a peer relative to THIS node's network,
 * derived from the peer's libp2p peerStore protocol list:
 * - `serves`   — advertises this network's namespaced `cluster`/`repo` protocol.
 * - `foreign`  — has a non-empty protocol list but none for this network → another network.
 * - `unknown`  — protocol list empty / peer absent → identify not yet completed. This is
 *                both a fresh same-network peer (will flip to `serves`) AND a cross-network
 *                peer (whose network-namespaced identify can NEVER complete, so it stays
 *                `unknown` forever) — indistinguishable at a single instant, separated over
 *                the retry/stabilization window.
 */
export type NetworkMembership = 'serves' | 'foreign' | 'unknown';

export class FindCoordinatorError extends Error {
	readonly code: FindCoordinatorErrorCode;
	constructor(code: FindCoordinatorErrorCode, message: string) {
		super(message);
		this.name = 'FindCoordinatorError';
		this.code = code;
	}
}

export interface PersistedNetworkState {
	version: 1;
	networkHighWaterMark: number;
	lastConnectedTimestamp: number;
	consecutiveIsolatedSessions: number;
	fretTable?: SerializedTable;
}

export interface NetworkStatePersistence {
	load(): Promise<PersistedNetworkState | undefined>;
	save(state: PersistedNetworkState): Promise<void>;
}

/**
 * Configuration options for self-coordination behavior
 */
export interface SelfCoordinationConfig {
	/** Time (ms) after last connection before allowing self-coordination. Default: 30000 */
	gracePeriodMs?: number;
	/** Threshold for suspicious network shrinkage (0-1). >50% drop is suspicious. Default: 0.5 */
	shrinkageThreshold?: number;
	/** Allow self-coordination at all. Default: true (for testing). Set false in production. */
	allowSelfCoordination?: boolean;
}

/**
 * Decision result from self-coordination guard
 */
export interface SelfCoordinationDecision {
	allow: boolean;
	reason: 'bootstrap-node' | 'partition-detected' | 'suspicious-shrinkage' | 'grace-period-not-elapsed' | 'extended-isolation' | 'hwm-decay' | 'disabled';
	warn?: boolean;
	/**
	 * Set on a denial. `true` means "self is not the PREFERRED coordinator right now, but
	 * nothing says it is unsafe" — the last-resort tier degrades to self with a warning
	 * rather than failing the caller. `false` means there is a positive reason to refuse
	 * (operator config, or evidence of a partition) and the caller is failed.
	 *
	 * Hardness by reason, given the caller's {@link CoordinatorIntent}:
	 *
	 * | reason                    | write      | read       |
	 * | ------------------------- | ---------- | ---------- |
	 * | `disabled`                | hard       | hard       |
	 * | `grace-period-not-elapsed`| deferrable | deferrable |
	 * | `partition-detected`      | hard       | deferrable |
	 * | `suspicious-shrinkage`    | hard       | deferrable |
	 *
	 * `grace-period-not-elapsed` is deferrable for BOTH because it is a timing condition
	 * with no evidence behind it: the same node, with the same FRET table and the same zero
	 * connections, is allowed to self-coordinate once the clock passes `gracePeriodMs`. It
	 * postpones an isolated write rather than preventing it (a self-only cohort commits
	 * under `allowClusterDownsize`, the default), so failing the caller buys no safety.
	 *
	 * The read column is uniformly deferrable because none of these reasons protects a
	 * read: self-coordinating a read means "answer from my own replica", which is what an
	 * isolated node must accept anyway, and the layers below already report the quality of
	 * that answer (`CoordinatorRepo.fetchBlockFromCluster` short-circuits a self-only cohort
	 * as conclusive; an unreachable cohort comes back flagged `unavailable`). `disabled` is
	 * the exception for both intents — it is an explicit operator switch, not an inference.
	 *
	 * NOTE: optional, so a NEW denial branch that forgets to set it silently reads as HARD
	 * (`findCoordinator` tests `deferrable !== true`) — safe for a write, but it reinstates
	 * the original defect for a read: an outright lookup failure where degrading to our own
	 * replica would do. Every denial branch today sets it explicitly. If a fifth reason is
	 * ever added, either set it there too or split this into a discriminated union
	 * (`{ allow: true, … } | { allow: false, deferrable: boolean, … }`) so omission is a
	 * compile error.
	 */
	deferrable?: boolean;
}

export class Libp2pKeyPeerNetwork implements IKeyNetwork, IPeerNetwork {
	private readonly selfCoordinationConfig: Required<SelfCoordinationConfig>;
	private networkHighWaterMark = 1;
	private lastConnectedTime = Date.now();
	private consecutiveIsolatedSessions = 0;
	/**
	 * NOTE: diagnostic-only — no decision consults this any more. It used to gate the
	 * coordinator retry window, but it is computed once at construction
	 * (`bootstrapNodes.length > 0` in `libp2p-node-base.ts`) and never re-derived, so a node
	 * configured with a bootstrap address it has never reached read as "company is coming"
	 * forever; {@link retryCouldImprove} asks libp2p for live evidence instead. It still earns
	 * its keep in the `retry-futile` log line ("configured
	 * to expect company" vs. "solo by design"). Drop it, or re-derive it from live state, when
	 * the constructor becomes an options bag — removing the positional parameter now would
	 * churn ~50 construction sites in `test/libp2p-key-network.spec.ts` for no behaviour change.
	 */
	private readonly networkMode: NetworkMode;
	private readonly persistence?: NetworkStatePersistence;

	// NOTE: seven positional parameters, and the list stays that way for now — converting to an
	// options bag would touch ~50 construction sites in `test/libp2p-key-network.spec.ts` alone.
	// Revisit if an eighth parameter is ever needed, or if that spec is being rewritten anyway.
	constructor(
		private readonly libp2p: Libp2p,
		/**
		 * Replication factor / target cohort breadth for peer selection. REQUIRED, deliberately:
		 * a silent default here meant a caller that did not know the node's cluster size quietly
		 * selected a different-width cohort than the node's own consensus path used for the same
		 * key. Reuse the node's own instance (`node.keyNetwork`) where one exists; a caller that
		 * genuinely must construct standalone passes `DEFAULT_CLUSTER_SIZE` (`cluster/cluster-policy.ts`).
		 */
		private readonly clusterSize: number,
		selfCoordinationConfig?: SelfCoordinationConfig,
		networkMode?: NetworkMode,
		persistence?: NetworkStatePersistence,
		private readonly reputation?: IPeerReputation,
		/**
		 * Network-namespaced protocol prefix (`/optimystic/<networkName>`). When
		 * provided, coordinator/cohort selection is scoped to peers that serve THIS
		 * network's `cluster`/`repo` protocol, so a peer that only belongs to another
		 * network sharing the same physical nodes/bootstraps is never chosen. When
		 * ABSENT, the membership filter is disabled.
		 *
		 * NOTE: optional for the same reason `clusterSize` used to be — "most call sites don't
		 * know the network name" — and that reason no longer holds: both production sites now
		 * pass it (`libp2p-node-base.ts`, and the foreign-node fallback in the Quereus
		 * collection-factory), and only the mock-based cases in `test/libp2p-key-network.spec.ts`
		 * omit it. So a caller omitting it today gets the filter silently off, exactly the shape
		 * that let a second key network be built with a wrong cohort width. Left optional because
		 * making it required would touch ~50 construction sites in that one spec and no reachable
		 * caller is affected. Make it required (or take the whole list as an options bag) the
		 * moment a THIRD production construction site appears, or when that spec is rewritten.
		 */
		private readonly protocolPrefix?: string
	) {
		// NOTE: no production construction site in this repo passes a SelfCoordinationConfig —
		// both leave it `undefined` (libp2p-node-base.ts, and the foreign-node fallback in
		// quereus-plugin-optimystic's collection-factory.ts), so these defaults are always what
		// is in force and no operator can tune them. If tuning `gracePeriodMs` is ever needed,
		// those two sites have to thread the config through first. Low urgency: a grace-period denial no longer fails the caller, it only costs
		// a write the findCoordinator retry window before self-coordinating — and only when that
		// window is worth paying at all (see `retryCouldImprove`), so an isolated node pays nothing.
		this.log = createLogger('libp2p-key-network', this.libp2p.peerId.toString())
		this.selfCoordinationConfig = {
			gracePeriodMs: selfCoordinationConfig?.gracePeriodMs ?? 30_000,
			shrinkageThreshold: selfCoordinationConfig?.shrinkageThreshold ?? 0.5,
			allowSelfCoordination: selfCoordinationConfig?.allowSelfCoordination ?? true
		};
		this.networkMode = networkMode ?? 'forming';
		this.persistence = persistence;
		this.setupConnectionTracking();
	}

	/** The cluster size this instance actually resolved to, for `assertClusterSizeCoupling`. */
	get effectiveClusterSize(): number {
		return this.clusterSize;
	}

	/**
	 * The network-namespaced protocol prefix (`/optimystic/<networkName>`) selection is scoped to,
	 * or `undefined` when the network-membership filter is off. Readable so a spec can assert the
	 * node's attached instance really is network-scoped without reaching into a private field.
	 */
	get effectiveProtocolPrefix(): string | undefined {
		return this.protocolPrefix;
	}

	// coordinator cache: key (base64url) -> peerId until expiry (bounded LRU-ish via Map insertion order)
	private readonly coordinatorCache = new Map<string, { id: PeerId, expires: number }>()
	private static readonly MAX_CACHE_ENTRIES = 1000
	private readonly log: ReturnType<typeof createLogger>

	private toCacheKey(key: Uint8Array): string { return u8ToString(key, 'base64url') }

	/**
	 * Set up connection event tracking to update high water mark and last connected time.
	 */
	private setupConnectionTracking(): void {
		this.libp2p.addEventListener('connection:open', () => {
			this.updateNetworkObservations();
		});
	}

	/**
	 * Update network high water mark and last connected time.
	 * Called on new connections.
	 */
	private updateNetworkObservations(): void {
		const connections = this.libp2p.getConnections?.() ?? [];
		if (connections.length > 0) {
			this.lastConnectedTime = Date.now();
			this.consecutiveIsolatedSessions = 0;
		}

		try {
			const fret = this.getFret();
			const estimate = fret.getNetworkSizeEstimate();
			if (estimate.size_estimate > this.networkHighWaterMark) {
				this.networkHighWaterMark = estimate.size_estimate;
				this.log('network-hwm-updated mark=%d confidence=%f', this.networkHighWaterMark, estimate.confidence);
			}
		} catch {
			// FRET not available - use connection count as fallback
			const connectionCount = this.libp2p.getConnections?.().length ?? 0;
			const observedSize = connectionCount + 1; // +1 for self
			if (observedSize > this.networkHighWaterMark) {
				this.networkHighWaterMark = observedSize;
				this.log('network-hwm-updated mark=%d (from connections)', this.networkHighWaterMark);
			}
		}

		this.persistState();
	}

	async initFromPersistedState(): Promise<void> {
		if (!this.persistence) return;
		const state = await this.persistence.load();
		if (!state) return;

		this.networkHighWaterMark = state.networkHighWaterMark;
		this.lastConnectedTime = state.lastConnectedTimestamp;
		this.consecutiveIsolatedSessions = state.consecutiveIsolatedSessions;

		if (state.fretTable) {
			try {
				this.getFret().importTable(state.fretTable);
			} catch (err) { this.log('init:fret-import-skipped %o', err); }
		}

		// If HWM > 1 but FRET table is empty/self-only, increment isolated sessions
		if (state.networkHighWaterMark > 1) {
			const fretEntryCount = state.fretTable?.entries?.length ?? 0;
			if (fretEntryCount <= 1) {
				this.consecutiveIsolatedSessions++;
				this.log('init:isolated-session count=%d hwm=%d', this.consecutiveIsolatedSessions, this.networkHighWaterMark);
			}
		}
	}

	/**
	 * Can another attempt plausibly return a BETTER answer than this one did? Consulted ONLY
	 * when the current attempt found no candidate and the node holds zero connections — i.e.
	 * purely to decide whether the 500ms inter-attempt sleep is worth paying.
	 *
	 * Answered from evidence available NOW, never from configuration or history (`networkMode`
	 * is frozen at construction and `networkHighWaterMark` is monotonic, so both used to keep
	 * the window open forever on a node that could never fill it):
	 *  - a non-self candidate in the FRET neighbourhood for this key — a peer we know of and
	 *    route to; a connection to it landing during the sleep makes it selectable.
	 *  - a dial in flight (`queued` / `active` in libp2p's dial queue) — a connection attempt
	 *    that can complete inside the sleep. This is the signal that covers a
	 *    configured-but-not-yet-reached bootstrap peer: while its dial runs, the window is
	 *    worth paying; once the dial has failed, it is not.
	 *
	 * Neither present → nothing this call can wait for; break to the last-resort tier.
	 *
	 * NOTE: accepted regression — a node with no known peers and no dial in flight that
	 * received an INBOUND connection during a sleep it now skips will route that one lookup to
	 * self instead of to the arriving peer. A self pick is never cached, so the next lookup
	 * picks the peer up; the benefit is that every genuinely isolated lookup stops paying ~1s
	 * per block. Inbound reachability is deliberately NOT a futility signal: it holds for
	 * nearly every node with a listen address, so it would neuter the test.
	 * NOTE: deliberately no `peerStore` scan — "we have a record of a peer" is not "a peer can
	 * arrive in the next 500ms". A peerStore entry with no FRET entry and no in-flight dial is
	 * a peer nobody is currently attempting, and the scan is an async datastore iteration on a
	 * per-lookup hot path.
	 */
	private retryCouldImprove(candidateIds: string[]): boolean {
		if (candidateIds.some(id => id !== this.libp2p.peerId.toString())) return true;
		return this.dialsInFlight() > 0;
	}

	/**
	 * Number of dials libp2p is currently attempting (`queued` or `active`) — a connection
	 * that can plausibly complete inside the inter-attempt sleep.
	 *
	 * Over-inclusive by design: the queue may hold a dial to an excluded, banned, or
	 * foreign-network peer. That keeps the retry window (conservative, matches the behaviour
	 * before the futility test existed); cross-referencing it would cost more than the sleep
	 * it saves. `getDialQueue` is non-optional on the Libp2p interface, so an absent method
	 * only ever means a test mock — treated as "no evidence of an in-flight dial", exactly as
	 * `getConnections?.()` is handled elsewhere.
	 *
	 * NOTE: this bounds — it does not eliminate — the futile window for the motivating case (a
	 * node whose only configured bootstrap is unreachable). FRET re-probes such a peer at most
	 * once per its capped 32s backoff (`fret-service.ts` `recordBackoff`: base 1000ms × factor
	 * ≤32), and each probe's dial can sit `active` for libp2p's 10s `DIAL_TIMEOUT` — so up to
	 * roughly a third of wall-clock still has a dial in flight, and lookups in those stretches
	 * still pay ~1s. Paying there is correct (a succeeding probe makes the peer selectable);
	 * revisit only if either upstream constant moves far enough to make the duty cycle ~1.
	 */
	private dialsInFlight(): number {
		return (this.libp2p.getDialQueue?.() ?? [])
			.filter(d => d.status === 'queued' || d.status === 'active').length;
	}

	/**
	 * The caller-independent half of eligibility: this peer is neither excluded by the caller
	 * nor banned by reputation. Shared by all three places `findCoordinator` narrows a candidate
	 * list — the FRET tier, the connected-peer fallback, and the retry-futility input — so the
	 * futility test can never disagree with the tiers about who is pickable.
	 */
	private isSelectable(id: string, excluded: Set<string>): boolean {
		return !excluded.has(id) && !(this.reputation?.isBanned(id));
	}

	private persistState(): void {
		if (!this.persistence) return;
		const state: PersistedNetworkState = {
			version: 1,
			networkHighWaterMark: this.networkHighWaterMark,
			lastConnectedTimestamp: this.lastConnectedTime,
			consecutiveIsolatedSessions: this.consecutiveIsolatedSessions,
		};
		try {
			const fret = this.getFret();
			state.fretTable = fret.exportTable();
		} catch { /* FRET not available */ }
		void this.persistence.save(state).catch(err => this.log('persist-state-failed %o', err));
	}

	/**
	 * Determine if self-coordination should be allowed based on network observations.
	 *
	 * Principle: If we've ever seen a larger network, assume our connectivity is the problem,
	 * not the network shrinking.
	 *
	 * A denial is classified as HARD or DEFERRABLE via {@link SelfCoordinationDecision.deferrable}
	 * — see that field for the reason/intent table. A hard denial fails the caller; a deferrable
	 * one only means "self is not the preferred coordinator", and the last-resort tier degrades
	 * to self with a warning.
	 *
	 * @param intent What the caller means to do with the coordinator. Defaults to `'write'`,
	 * the conservative reading, so callers that don't know are held to the stricter bar.
	 */
	shouldAllowSelfCoordination(intent: CoordinatorIntent = 'write'): SelfCoordinationDecision {
		// A read never coordinates a mutation, so every evidence-based denial below is merely
		// a preference for a better-placed peer — the caller can always be answered from this
		// node's own replica. Only the explicit `disabled` switch is absolute for a read.
		const deferrableOnEvidence = intent === 'read';

		// Check global disable
		if (!this.selfCoordinationConfig.allowSelfCoordination) {
			return { allow: false, reason: 'disabled', deferrable: false };
		}

		// Case 1: New/bootstrap node (never seen larger network)
		if (this.networkHighWaterMark <= 1) {
			return { allow: true, reason: 'bootstrap-node' };
		}

		// Case 1b: Repeated isolation across sessions — decay HWM to allow eventual self-coordination
		if (this.consecutiveIsolatedSessions >= 3) {
			this.log('self-coord-allowed: hwm-decayed sessions=%d', this.consecutiveIsolatedSessions);
			return { allow: true, reason: 'hwm-decay', warn: true };
		}

		// Case 2: Check for partition via FRET
		try {
			const fret = this.getFret();
			if (fret.detectPartition()) {
				this.log('self-coord-blocked: partition-detected intent=%s', intent);
				return { allow: false, reason: 'partition-detected', deferrable: deferrableOnEvidence };
			}

			// Case 3: Suspicious network shrinkage (>threshold drop)
			const estimate = fret.getNetworkSizeEstimate();
			const shrinkage = 1 - (estimate.size_estimate / this.networkHighWaterMark);
			if (shrinkage > this.selfCoordinationConfig.shrinkageThreshold) {
				this.log('self-coord-blocked: suspicious-shrinkage current=%d hwm=%d shrinkage=%f intent=%s',
					estimate.size_estimate, this.networkHighWaterMark, shrinkage, intent);
				return { allow: false, reason: 'suspicious-shrinkage', deferrable: deferrableOnEvidence };
			}
		} catch {
			// FRET not available - be conservative
			const connections = this.libp2p.getConnections?.() ?? [];
			if (this.networkHighWaterMark > 1 && connections.length === 0) {
				// We've seen peers before but have none now - suspicious
				const timeSinceConnection = Date.now() - this.lastConnectedTime;
				if (timeSinceConnection < this.selfCoordinationConfig.gracePeriodMs) {
					this.log('self-coord-blocked: grace-period-not-elapsed since=%dms', timeSinceConnection);
					return { allow: false, reason: 'grace-period-not-elapsed', deferrable: true };
				}
			}
		}

		// Case 4: Recently connected (grace period not elapsed)
		const timeSinceConnection = Date.now() - this.lastConnectedTime;
		if (timeSinceConnection < this.selfCoordinationConfig.gracePeriodMs) {
			const connections = this.libp2p.getConnections?.() ?? [];
			// Only block if we have no connections but did recently
			if (connections.length === 0) {
				this.log('self-coord-blocked: grace-period-not-elapsed since=%dms', timeSinceConnection);
				// Deferrable for BOTH intents: nothing here is evidence, only a clock. The same
				// node with the same information self-coordinates once gracePeriodMs elapses.
				return { allow: false, reason: 'grace-period-not-elapsed', deferrable: true };
			}
		}

		// Case 5: Extended isolation with gradual shrinkage - allow with warning
		this.log('self-coord-allowed: extended-isolation (warn)');
		return { allow: true, reason: 'extended-isolation', warn: true };
	}

	/**
	 * Memoize the coordinator for a key. A pick of SELF is deliberately ignored — the
	 * cache is consulted ahead of every selection tier, so a self entry would keep the
	 * key routed at our own (possibly stale) replica for the full TTL long after a
	 * better-placed peer became reachable, and would return self without re-consulting
	 * {@link shouldAllowSelfCoordination}, letting a partitioned node silently serve its
	 * own data. Self needs no memoizing anyway: every tier that can select it re-derives
	 * it from a local lookup with no dial and no retry sleep.
	 *
	 * The gate lives here rather than at each call site because most writers are OUTSIDE
	 * this class — `recordCoordinator` is public and is fed self-valued picks by
	 * `NetworkTransactor` (it writes back whatever `findCoordinator` returned, including
	 * self) and by `RepoClient`/`ClusterClient` on redirect responses.
	 */
	public recordCoordinator(key: Uint8Array, peerId: PeerId, ttlMs = 30 * 60 * 1000): void {
		if (peerId.toString() === this.libp2p.peerId.toString()) {
			this.log('coordinator-cache:self-write-ignored key=%s', this.toCacheKey(key).substring(0, 12))
			return
		}
		const k = this.toCacheKey(key)
		const now = Date.now()
		for (const [ck, entry] of this.coordinatorCache) {
			if (entry.expires <= now) this.coordinatorCache.delete(ck)
		}
		this.coordinatorCache.set(k, { id: peerId, expires: now + ttlMs })
		while (this.coordinatorCache.size > Libp2pKeyPeerNetwork.MAX_CACHE_ENTRIES) {
			const firstKey = this.coordinatorCache.keys().next().value as string | undefined
			if (firstKey == null) break
			this.coordinatorCache.delete(firstKey)
		}
	}

	private getCachedCoordinator(key: Uint8Array): PeerId | undefined {
		const k = this.toCacheKey(key)
		const hit = this.coordinatorCache.get(k)
		if (hit && hit.expires > Date.now()) return hit.id
		if (hit) this.coordinatorCache.delete(k)
		return undefined
	}

	/**
	 * True for a circuit-relay ("limited") connection. libp2p stamps a relayed
	 * connection with `limits` (per-circuit data/duration caps); we additionally
	 * sniff the multiaddr for `/p2p-circuit` as a fallback for transports/versions
	 * that don't populate `limits`.
	 */
	private isLimitedConnection(c: Connection): boolean {
		if ((c as { limits?: unknown }).limits != null) return true
		const addr = c.remoteAddr?.toString?.()
		return addr != null && addr.includes('/p2p-circuit')
	}

	connect(peerId: PeerId, protocol: string, options?: AbortOptions): Promise<Stream> {
		const conns = this.libp2p.getConnections?.(peerId) ?? []
		// Filter to only-open connections so a closing/closed entry that libp2p
		// hasn't yet evicted from its index doesn't get picked up here.
		const open = conns.filter(c => c?.status === 'open' && typeof c?.newStream === 'function')
		// Prefer a DIRECT connection over a limited (circuit-relay) one for the RPC.
		// A relayed/limited connection can be reset by the relay once a per-circuit
		// cap or reservation lapses (@libp2p/circuit-relay-v2), surfacing to the
		// coordinator as a StreamResetError that fails consensus. After DCUtR upgrades
		// a relayed link to direct, both connections briefly coexist — picking the
		// direct one avoids riding the soon-to-be-reset circuit. We only fall back to
		// the limited connection (with runOnLimitedConnection) when it is the only open
		// path — the steady state for browsers and NATed peers before any upgrade.
		const chosen = open.find(c => !this.isLimitedConnection(c)) ?? open[0]
		if (chosen) {
			// runOnLimitedConnection: true is required to open a stream over a
			// circuit-relay (limited) connection — the steady-state path for
			// browsers and NATed peers. Without it, the warm relay connection
			// from a prior dialProtocol cannot be reused on subsequent RPCs. It is
			// a harmless no-op on the preferred direct connection.
			return chosen.newStream([protocol], {
				signal: options?.signal,
				runOnLimitedConnection: true,
				negotiateFully: false
			})
		}
		// Forward the caller's AbortSignal so a per-peer dial deadline (enforced
		// upstream by ProtocolClient.processMessage) can actually cancel a stuck
		// dial — without this, libp2p falls back to its built-in dial timeout
		// (default ~30s) and the caller's tighter deadline is decorative.
		const dialOptions = { runOnLimitedConnection: true, negotiateFully: false, signal: options?.signal } as const
		return this.libp2p.dialProtocol(peerId, [protocol], dialOptions)
	}

	private getFret(): FretService {
		const svc = (this.libp2p as unknown as WithFretService).services?.fret
		if (svc == null) throw new Error('FRET service is not registered on this libp2p node')
		return svc
	}

	private async getNeighborIdsForKey(key: Uint8Array, wants: number): Promise<string[]> {
		const fret = this.getFret()
		const coord = await hashKey(key)
		const both = fret.getNeighbors(coord, 'both', wants)
		return Array.from(new Set(both)).slice(0, wants)
	}

	async findCoordinator(key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		const t0 = Date.now();
		const excludedSet = new Set<string>((_options?.excludedPeers ?? []).map(p => p.toString()))
		// Unset means 'write' — the conservative reading, so a caller that doesn't declare an
		// intent is held to the stricter self-coordination bar.
		const intent: CoordinatorIntent = _options?.intent ?? 'write';
		const keyStr = this.toCacheKey(key).substring(0, 12);
		// Tracks whether the network-membership filter excluded an UNCONFIRMED candidate
		// — `foreign` (another network) OR `unknown` (not yet confirmed to serve this
		// network) — during any attempt. If selection ultimately fails with self
		// unavailable, this lets us surface NO_NETWORK_COORDINATOR (the real cause)
		// instead of the generic NO_COORDINATOR_AVAILABLE.
		let droppedUnconfirmedAnyAttempt = false;

		this.log('findCoordinator:start key=%s excluded=%o', keyStr, Array.from(excludedSet).map(s => s.substring(0, 12)))

		// honor cache if not excluded
		const cached = this.getCachedCoordinator(key)
		if (cached != null && !excludedSet.has(cached.toString())) {
			this.log('findCoordinator:done key=%s ms=%d source=%s', keyStr, Date.now() - t0, 'cache')
			return cached
		}

		// Retry logic: connections can be temporarily down, so retry a few times with delay
		const maxRetries = 3;
		const retryDelayMs = 500;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			// Get currently connected peers for filtering
			const connected = (this.libp2p.getConnections?.() ?? []).map((c: any) => c.remotePeer) as PeerId[]
			const connectedSet = new Set(connected.map(p => p.toString()))
			this.log('findCoordinator:connected-peers key=%s count=%d peers=%o attempt=%d', keyStr, connected.length, connected.map(p => p.toString().substring(0, 12)), attempt)

			// prefer FRET neighbors that are also connected, pick first non-excluded
			let ids: string[] = [];
			try {
				ids = await this.getNeighborIdsForKey(key, this.clusterSize)
				this.log('findCoordinator:fret-neighbors key=%s candidates=%d', keyStr, ids.length)
				if (verbose) this.log('findCoordinator:fret-candidates key=%s ids=%o connected=%o', keyStr, ids, Array.from(connectedSet))

				// Filter to only connected FRET neighbors, excluding banned peers. Self is
				// never "connected" to itself, so it is admitted by the explicit self clause
				// below — but ONLY when the self-coordination guard allows it, otherwise a
				// node whose FRET neighborhood contains self (essentially always on a small or
				// forming network) would bypass the guard and the last-resort tier's
				// SELF_COORDINATION_BLOCKED would never fire. On refusal self is merely DROPPED
				// from the candidate list, so the connected-peer fallback below still gets its
				// chance at a good remote peer; only if that also comes up empty does the
				// last-resort tier raise the accurate error.
				//
				// An ISOLATED READ is the exception: with no connection left there is no better
				// answer to wait for, and a deferrable denial is not evidence that answering
				// from our own replica is wrong — so self is admitted here and the read resolves
				// immediately instead of paying the ~1s retry loop before the last-resort tier
				// degrades to the same answer. A WRITE keeps dropping self exactly as before,
				// so a peer that lands during the retry window still wins the key.
				const selfStr = this.libp2p.peerId.toString()
				let selfAllowedThisAttempt: boolean | undefined
				// Memoized per ATTEMPT, and evaluated lazily so an all-remote neighborhood never
				// pays detectPartition() / getNetworkSizeEstimate(). Re-evaluated on each attempt
				// because a connection can land during the 500ms inter-attempt sleep and
				// legitimately flip the answer — as filterByMembership re-reads the peerStore.
				// NOTE: on a small network self is a neighbor of nearly every key, so this runs
				// per findCoordinator call and self-coordinated keys are never cached to absorb
				// it. Fine while detectPartition()/getNetworkSizeEstimate() stay local FRET
				// table reads; if either ever grows a probe or other network round-trip, cache
				// the decision with a short TTL on the instance instead of per attempt.
				// NOTE: the guard re-reads getConnections() live, while `connectedSet` above was
				// snapshotted at the top of this attempt. A connection landing between the two
				// lifts the guard's grace-period denial while the new peer is still absent from
				// the candidate filter — so self can win an attempt on evidence that attempt
				// cannot yet use. Bounded to one attempt (the next re-snapshots and prefers the
				// peer) and self picks are never cached, so it costs at most one lookup's
				// routing. If that ever matters, pass the snapshot into the guard instead.
				const isSelfAdmissible = (): boolean => {
					if (selfAllowedThisAttempt === undefined) {
						const decision = this.shouldAllowSelfCoordination(intent)
						// Gated on ISOLATION, not just on the read intent. Self carries no reputation
						// record, so it scores 0 and sorts ahead of every remote candidate in the rank
						// below — admitting it while a connection is live would hand the key to a node
						// its own guard just called partitioned, over a reachable FRET neighbour. And
						// waiting costs a connected read nothing: the inter-attempt sleep further down
						// only runs when `connected.length === 0`, so with peers present the remaining
						// attempts and the last-resort degrade run back-to-back with no delay.
						const degradedRead = !decision.allow && decision.deferrable === true
							&& intent === 'read' && connected.length === 0
						selfAllowedThisAttempt = decision.allow || degradedRead
						if (degradedRead) {
							this.log('findCoordinator:fret-self-degraded key=%s reason=%s intent=read attempt=%d', keyStr, decision.reason, attempt)
						} else if (!decision.allow) {
							this.log('findCoordinator:fret-self-dropped key=%s reason=%s intent=%s attempt=%d', keyStr, decision.reason, intent, attempt)
						}
					}
					return selfAllowedThisAttempt
				}
				const connectedFretIds = ids
					.filter(id => this.isSelectable(id, excludedSet))
					.filter(id => connectedSet.has(id) || (id === selfStr && isSelfAdmissible()))
					.sort((a, b) => (this.reputation?.getScore(a) ?? 0) - (this.reputation?.getScore(b) ?? 0))
				this.log('findCoordinator:fret-connected key=%s count=%d peers=%o', keyStr, connectedFretIds.length, connectedFretIds.map(s => s.substring(0, 12)))

				// Network-membership scoping (no-op when protocolPrefix is unset): only a peer
				// CONFIRMED to serve this network ('serves') is eligible — both `foreign`
				// (another network) and `unknown` (not yet identified) peers are excluded
				// from selection. A cross-network peer is permanently 'unknown' (its
				// namespaced identify never completes), so it is never gambled on; over the
				// 3×500ms retry window a genuine same-network peer flips to 'serves' on a
				// re-read of the peerStore and is selected normally on that attempt. Self
				// always classifies as 'serves' and stays eligible.
				const { ranked, droppedUnconfirmed } = await this.filterByMembership(connectedFretIds)
				if (droppedUnconfirmed) droppedUnconfirmedAnyAttempt = true
				const pick = ranked[0]
				if (pick) {
					const pid = peerIdFromString(pick)
					// A self pick is a no-op here — recordCoordinator ignores self-valued
					// writes (see its doc comment), matching the last-resort self tier below.
					this.recordCoordinator(key, pid)
					this.log('findCoordinator:done key=%s ms=%d source=%s', keyStr, Date.now() - t0, 'fret')
					return pid
				}
			} catch (err) {
				this.log('findCoordinator getNeighborIdsForKey failed - %o', err)
			}

			// fallback: prefer any existing connected peer that's not excluded or banned,
			// scoped to this network's serving peers (a `foreign` or not-yet-confirmed
			// `unknown` peer is never picked). Note this candidate set is built from
			// connected REMOTE peers and never includes self, so when no serving peer is
			// present selection falls through to the last-resort self-coordination block.
			// Being remote-only, this tier needs no self-coordination guard check, unlike the
			// FRET tier above.
			const connectedCandidates = connected
				.filter(p => this.isSelectable(p.toString(), excludedSet))
				.sort((a, b) => (this.reputation?.getScore(a.toString()) ?? 0) - (this.reputation?.getScore(b.toString()) ?? 0))
				.map(p => p.toString())
			const { ranked: connRanked, droppedUnconfirmed: connDroppedUnconfirmed } = await this.filterByMembership(connectedCandidates)
			if (connDroppedUnconfirmed) droppedUnconfirmedAnyAttempt = true
			const connectedPick = connRanked[0]
			if (connectedPick) {
				const pid = peerIdFromString(connectedPick)
				this.recordCoordinator(key, pid)
				this.log('findCoordinator:done key=%s ms=%d source=%s', keyStr, Date.now() - t0, 'connected-fallback')
				return pid
			}

			// If no connections and not the last attempt, wait and retry
			if (connected.length === 0 && attempt < maxRetries - 1) {
				// Exclusion/ban filtered — a neighbour we may never pick is not something to
				// wait for. This network's membership filter (peerStore protocols) is deliberately
				// NOT applied: a neighbour still `unknown` to it is exactly the peer that flips to
				// `serves` inside the retry window, so its presence must keep the window. FRET's
				// own ring membership has already applied a stricter cut upstream — `getNeighbors`
				// returns confirmed ring members only — so a configured-but-never-reached bootstrap
				// peer is absent from `ids` entirely, and only the dial-in-flight signal below can
				// keep the window for it.
				const knowable = ids.filter(id => this.isSelectable(id, excludedSet));
				if (!this.retryCouldImprove(knowable)) {
					this.log('findCoordinator:retry-futile key=%s neighbors=%d dialsInFlight=%d mode=%s hwm=%d',
						keyStr, knowable.length, this.dialsInFlight(), this.networkMode, this.networkHighWaterMark);
					break;
				}
				this.log('findCoordinator:no-connections-retry key=%s attempt=%d delay=%dms', keyStr, attempt, retryDelayMs)
				await new Promise(resolve => setTimeout(resolve, retryDelayMs))
				continue
			}
		}

		// last resort: prefer self only if not excluded and guard allows
		const self = this.libp2p.peerId
		if (!excludedSet.has(self.toString())) {
			const decision = this.shouldAllowSelfCoordination(intent);
			// Only a HARD denial fails the caller. A deferrable one (see
			// SelfCoordinationDecision.deferrable) means self is merely not the preferred
			// coordinator — by this point every better tier has already come up empty and the
			// retry window has been spent, so refusing here would just convert "serve from my
			// own replica, degraded" into an outright failure of the whole operation.
			if (!decision.allow && decision.deferrable !== true) {
				this.log('findCoordinator:self-coord-blocked key=%s reason=%s intent=%s', keyStr, decision.reason, intent);
				throw new FindCoordinatorError(
					FIND_COORDINATOR_ERROR_CODES.SELF_COORDINATION_BLOCKED,
					`Self-coordination blocked: ${decision.reason}. No coordinator available for key.`
				);
			}
			if (!decision.allow) {
				this.log('findCoordinator:self-selected-degraded key=%s coordinator=%s reason=%s intent=%s',
					keyStr, self.toString().substring(0, 12), decision.reason, intent);
				this.log('findCoordinator:done key=%s ms=%d source=%s', keyStr, Date.now() - t0, 'self-degraded')
				return self
			}
			if (decision.warn) {
				this.log('findCoordinator:self-selected-warn key=%s coordinator=%s reason=%s',
					keyStr, self.toString().substring(0, 12), decision.reason);
			} else {
				this.log('findCoordinator:self-selected key=%s coordinator=%s reason=%s',
					keyStr, self.toString().substring(0, 12), decision.reason);
			}
			this.log('findCoordinator:done key=%s ms=%d source=%s', keyStr, Date.now() - t0, 'self')
			return self
		}

		// Self is excluded and selection found no eligible peer. If the membership filter is
		// the reason the candidate set emptied (the only other peers are `foreign` — serving
		// a DIFFERENT network — or `unknown` — not yet confirmed to serve this network),
		// surface a distinct, accurate cause instead of the generic codes below.
		if (droppedUnconfirmedAnyAttempt) {
			this.log('findCoordinator:no-network-coordinator key=%s prefix=%s self=%s',
				keyStr, this.protocolPrefix ?? '?', self.toString().substring(0, 12))
			throw new FindCoordinatorError(
				FIND_COORDINATOR_ERROR_CODES.NO_NETWORK_COORDINATOR,
				`No coordinator available for key on network ${this.protocolPrefix ?? '?'}: ` +
				`the remaining candidate peer(s) are foreign or not-yet-confirmed to serve this network's cluster/repo protocol.`
			);
		}

		// Self is excluded. On a solo/bootstrap node (HWM<=1 and no other connected/FRET peers),
		// this means the caller already tried self and the retry has nowhere to go — surface a
		// distinct error so retry logic stops and the original first-attempt cause is preserved.
		const isSoloBootstrap = this.networkHighWaterMark <= 1;
		if (isSoloBootstrap) {
			this.log('findCoordinator:self-exhausted-solo key=%s self=%s', keyStr, self.toString().substring(0, 12))
			throw new FindCoordinatorError(
				FIND_COORDINATOR_ERROR_CODES.SELF_COORDINATION_EXHAUSTED,
				'Self-coordination exhausted on solo/bootstrap node (self already attempted). ' +
				'The original first-attempt error describes the actual failure cause.'
			);
		}

		this.log('findCoordinator:all-excluded key=%s self=%s', keyStr, self.toString().substring(0, 12))
		throw new FindCoordinatorError(
			FIND_COORDINATOR_ERROR_CODES.NO_COORDINATOR_AVAILABLE,
			'No coordinator available for key (all candidates excluded)'
		);
	}

	private getConnectedAddrsByPeer(): Record<string, string[]> {
		const conns = this.libp2p.getConnections()
		const byPeer: Record<string, string[]> = {}
		for (const c of conns) {
			const id = c.remotePeer.toString()
			const addr = c.remoteAddr?.toString?.()
			if (addr) (byPeer[id] ??= []).push(addr)
		}
		return byPeer
	}

	private parseMultiaddrs(addrs: string[]): string[] {
		const out: string[] = []
		for (const a of addrs) {
			try { multiaddr(a); out.push(a) } catch (err) { this.log('WARN: invalid multiaddr from connection %s %o', a, err) }
		}
		return out
	}

	async findCluster(key: Uint8Array): Promise<ClusterPeers> {
		const t0 = Date.now();
		const fret = this.getFret()
		const coord = await hashKey(key)
		// When membership scoping is active, over-fetch a wider proximity band so the
		// nearest peers that SERVE this network are in the candidate pool even if cross-
		// network peers sit nearer the key (see membershipOverfetch).
		const wants = this.protocolPrefix != null ? this.membershipOverfetch() : this.clusterSize
		const cohort = fret.assembleCohort(coord, wants)
		const keyStr = this.toCacheKey(key).substring(0, 12);
		this.log('findCluster:start key=%s', keyStr);

		// Include self in the cohort
		const selfId = this.libp2p.peerId.toString()
		let ids = Array.from(new Set([...cohort, selfId]))

		// Network-membership scoping (no-op when protocolPrefix is unset): a cohort
		// member that serves a DIFFERENT network's protocol can never negotiate THIS
		// network's cluster/repo dial, so it guarantees a super-majority failure rather
		// than contributing a promise. Drop such 'foreign' members; build the cohort from
		// positively-'serves' members only and NEVER admit a not-yet-identified ('unknown')
		// member. A permanently cross-network peer and a freshly-discovered same-network
		// peer mid-identify are indistinguishable while 'unknown' (both have an empty
		// peerStore protocol list), so admitting an 'unknown' on the strength of a viability
		// floor risks pulling a cross-network contaminant into the cohort — its repo dial
		// then negotiates a different network's protocol and the whole write fails. A fresh
		// same-network peer is not starved: it flips to 'serves' once identify completes and
		// is re-included on the caller's retry, and in the meantime a self-only cohort still
		// completes the write under allowClusterDownsize (the default).
		// Scoped path only: one peerStore read per cohort member yields both protocols
		// (for membership classification here) and addresses (reused at backfill below),
		// so a finally-selected member isn't fetched from the peerStore twice. Left
		// undefined on the unscoped path, which never classifies membership.
		let peerStoreRecords: Record<string, { protocols: string[]; addrs: string[] }> | undefined
		if (this.protocolPrefix != null) {
			// `cohort` is the over-fetched nearest-first band. Classify each non-self
			// member, preserving proximity order within each tier.
			const nonSelf = cohort.filter(id => id !== selfId)
			peerStoreRecords = await this.getPeerStoreRecordsByPeer(nonSelf)
			const serves: string[] = []
			const unknown: string[] = []
			let foreignDropped = 0
			for (const id of nonSelf) {
				const m = this.membershipOf(id, peerStoreRecords[id]?.protocols)
				if (m === 'serves') serves.push(id)
				else if (m === 'unknown') unknown.push(id)
				else foreignDropped++
			}
			// Take the nearest `clusterSize - 1` SERVING peers. Self is ALWAYS added below and
			// counts toward `clusterSize` (matching the unscoped path, where `assembleCohort`
			// returns the nearest `clusterSize` peers INCLUDING self when self is near the key —
			// the coordinator case), so reserving a slot for self keeps a healthy same-network
			// cohort at exactly `clusterSize` members rather than `clusterSize + 1`. Over-sizing
			// would inflate the super-majority promise count (ceil(peerCount * threshold)) above
			// what the configured `clusterSize` intends and hurt write availability. 'unknown'
			// members are never backfilled: an 'unknown' peer may be a permanently cross-network
			// contaminant whose repo dial cannot negotiate this network's protocol, and a fresh
			// same-network peer mid-identify is indistinguishable from it. We therefore admit
			// only positively-'serves' peers; when self is the sole serving member the cohort is
			// self-only, which completes the write under allowClusterDownsize (the default) and
			// re-includes any legitimate peer as 'serves' on the caller's retry once identify
			// completes. `unknown.length` is still computed above for the diagnostic log line.
			const nonSelfTarget = Math.max(0, this.clusterSize - 1)
			const others = serves.slice(0, nonSelfTarget)
			ids = Array.from(new Set([selfId, ...others]))
			this.log('findCluster:membership key=%s serves=%d unknown=%d foreignDropped=%d kept=%d',
				keyStr, serves.length, unknown.length, foreignDropped, ids.length)
		}

		const connectedByPeer = this.getConnectedAddrsByPeer()
		const connectedPeerIds = Object.keys(connectedByPeer)

		// Backfill addresses from the peerStore for cohort members we don't have
		// a live connection to. The cohort is keyspace-determined and can include
		// peers we know-of but haven't dialed yet; without this backfill those
		// would be silently dropped. On the scoped path reuse the addresses already
		// read into `peerStoreRecords` above (no second store.get per member); on the
		// unscoped path (no record map) do the single peerStore read as before.
		const backfillIds = ids.filter(id => id !== selfId)
		const peerStoreAddrs = peerStoreRecords
			? Object.fromEntries(
				backfillIds
					.map(id => [id, peerStoreRecords![id]?.addrs ?? []] as const)
					.filter(([, addrs]) => addrs.length > 0)
			)
			: await this.getPeerStoreAddrsByPeer(backfillIds)

		this.log('findCluster key=%s fretCohort=%d connected=%d', keyStr, cohort.length, connectedPeerIds.length)
		if (verbose) this.log('findCluster:detail key=%s cohortPeers=%o connectedPeers=%o', keyStr, ids, connectedPeerIds)

		const peers: ClusterPeers = {}

		for (const idStr of ids) {
			if (idStr === selfId) {
				const raw = this.libp2p.peerId.publicKey?.raw ?? new Uint8Array()
				peers[idStr] = { multiaddrs: this.libp2p.getMultiaddrs().map(ma => ma.toString()), publicKey: u8ToString(raw, 'base64url') }
				continue
			}
			const connectedStrings = connectedByPeer[idStr] ?? []
			const peerStoreStrings = peerStoreAddrs[idStr] ?? []
			// De-duplicate while preserving connected-first ordering. The
			// connected multiaddr is the one libp2p just used to reach this peer
			// and is the most reliable; peerStore addrs are the fallback for
			// cohort members we know-of but aren't currently connected to.
			const merged = Array.from(new Set([...connectedStrings, ...peerStoreStrings]))
			const parsed = this.parseMultiaddrs(merged)
			const remotePeerId = peerIdFromString(idStr)
			const raw = remotePeerId.publicKey?.raw ?? new Uint8Array()
			// Note: parsed may be empty for a cohort member we have neither a
			// live connection to nor a peerStore entry for. The dial will then
			// surface as `code=none msg="no valid addresses"` and the caller's
			// retry/exclude logic takes over — we intentionally do NOT drop
			// addressless members here, because shrinking the cohort below
			// `clusterSize` puts consensus supermajority out of reach.
			peers[idStr] = { multiaddrs: parsed, publicKey: u8ToString(raw, 'base64url') }
		}

		this.log('findCluster:done key=%s ms=%d peers=%d',
			keyStr, Date.now() - t0, Object.keys(peers).length)
		return peers
	}

	/**
	 * Look up the libp2p peerStore for known multiaddrs of the given peer ids.
	 * Returns a map from peer-id string to multiaddr strings — empty/missing
	 * when the peerStore has no entry. Errors are swallowed; we'd rather fail
	 * back to the defense-in-depth drop than throw out of findCluster.
	 */
	private async getPeerStoreAddrsByPeer(ids: string[]): Promise<Record<string, string[]>> {
		const out: Record<string, string[]> = {}
		const store = (this.libp2p as { peerStore?: { get?: (id: PeerId) => Promise<{ addresses?: Array<{ multiaddr: { toString(): string } }> }> } }).peerStore
		if (!store?.get) return out
		await Promise.all(ids.map(async (idStr) => {
			try {
				const pid = peerIdFromString(idStr)
				const peer = await store.get!(pid)
				const addrs = (peer?.addresses ?? []).map(a => a.multiaddr.toString())
				if (addrs.length > 0) out[idStr] = addrs
			} catch {
				// Unknown peer or peerStore failure — leave out of the map.
			}
		}))
		return out
	}

	/**
	 * Single-pass peerStore read returning BOTH protocols and addresses per peer from one
	 * `store.get` call. Used on the membership-scoped `findCluster` hot path, where the
	 * cohort needs protocols (to classify membership) AND addresses (to backfill dial
	 * targets) for the same peers — reading them together avoids a second `store.get` per
	 * finally-selected member. Same error handling as {@link getPeerStoreProtocolsByPeer}
	 * and {@link getPeerStoreAddrsByPeer}: a missing peer or peerStore failure is left
	 * absent from the map (caller treats absent protocols as 'unknown', absent addrs as none).
	 */
	private async getPeerStoreRecordsByPeer(ids: string[]): Promise<Record<string, { protocols: string[]; addrs: string[] }>> {
		const out: Record<string, { protocols: string[]; addrs: string[] }> = {}
		const store = (this.libp2p as { peerStore?: { get?: (id: PeerId) => Promise<{ protocols?: string[]; addresses?: Array<{ multiaddr: { toString(): string } }> }> } }).peerStore
		if (!store?.get) return out
		await Promise.all(ids.map(async (idStr) => {
			try {
				const pid = peerIdFromString(idStr)
				const peer = await store.get!(pid)
				const addrs = (peer?.addresses ?? []).map(a => a.multiaddr.toString())
				out[idStr] = { protocols: peer?.protocols ?? [], addrs }
			} catch {
				// Unknown peer or peerStore failure — leave out of the map.
			}
		}))
		return out
	}

	/**
	 * Prefetch each peer's advertised protocol list from the libp2p peerStore.
	 * Returns a map from peer-id string to its protocols (empty array when the peer
	 * is absent or has not yet been identified). Mirrors {@link getPeerStoreAddrsByPeer};
	 * errors are swallowed so a peerStore hiccup degrades to "unknown" rather than throwing.
	 */
	private async getPeerStoreProtocolsByPeer(ids: string[]): Promise<Record<string, string[]>> {
		const out: Record<string, string[]> = {}
		const store = (this.libp2p as { peerStore?: { get?: (id: PeerId) => Promise<{ protocols?: string[] }> } }).peerStore
		if (!store?.get) return out
		await Promise.all(ids.map(async (idStr) => {
			try {
				const pid = peerIdFromString(idStr)
				const peer = await store.get!(pid)
				out[idStr] = peer?.protocols ?? []
			} catch {
				// Unknown peer or peerStore failure — leave out (treated as 'unknown').
			}
		}))
		return out
	}

	/**
	 * Over-fetch width for network-membership scoping. A cross-network peer can sit
	 * NEARER the key than a legitimate same-network peer and displace it from the
	 * nearest-`clusterSize` window, so when scoping is active we ask FRET for a wider
	 * proximity band and then keep the nearest peers that actually serve this network.
	 * (A ring polluted by more cross-network peers than this band is the domain of the
	 * separate FRET-side eviction follow-up; this band covers realistic co-location.)
	 */
	private membershipOverfetch(): number {
		return Math.max(this.clusterSize * 4, this.clusterSize + 16)
	}

	/**
	 * Classify a peer's network membership from its advertised protocols. Self always
	 * `serves` (it trivially serves its own network). When no `protocolPrefix` is
	 * configured the filter is disabled and EVERY peer is reported `serves`, so all
	 * callers behave exactly as before this scoping was added.
	 */
	private membershipOf(idStr: string, protocols: string[] | undefined): NetworkMembership {
		if (this.protocolPrefix == null) return 'serves'
		if (idStr === this.libp2p.peerId.toString()) return 'serves'
		if (protocols == null || protocols.length === 0) return 'unknown'
		if (protocols.includes(`${this.protocolPrefix}/cluster/1.0.0`)
			|| protocols.includes(`${this.protocolPrefix}/repo/1.0.0`)) return 'serves'
		return 'foreign'
	}

	/**
	 * Scope a reputation-ordered candidate id list to this network for COORDINATOR
	 * selection: keep ONLY peers confirmed to serve this network (`serves`, which always
	 * includes self), dropping both `foreign` peers (serving another network) and
	 * `unknown` peers (peerStore protocol list empty — not yet confirmed). Incoming
	 * (reputation) order is preserved among the surviving `serves` peers. A no-op
	 * (returns the input unchanged, no drops) when `protocolPrefix` is unset or the list
	 * is empty — the membership-disabled path is therefore untouched.
	 *
	 * `droppedUnconfirmed` reports whether any candidate was excluded because it was not
	 * confirmed to serve this network — `foreign` OR `unknown` under scoping — so the
	 * caller can surface a distinct "no network coordinator" failure rather than a generic
	 * one. An `unknown` peer is not gambled on as coordinator: a permanent cross-network
	 * contaminant and a fresh same-network peer mid-identify are indistinguishable at an
	 * instant, but the filter re-reads the peerStore on every retry attempt, so a genuine
	 * same-network peer that completes `identify` within the retry window flips to `serves`
	 * and is selected normally on that attempt.
	 */
	private async filterByMembership(ids: string[]): Promise<{ ranked: string[]; droppedUnconfirmed: boolean }> {
		if (this.protocolPrefix == null || ids.length === 0) return { ranked: ids, droppedUnconfirmed: false }
		const selfStr = this.libp2p.peerId.toString()
		const protocolsByPeer = await this.getPeerStoreProtocolsByPeer(ids.filter(id => id !== selfStr))
		const serves: string[] = []
		let droppedUnconfirmed = false
		for (const id of ids) {
			const m = this.membershipOf(id, protocolsByPeer[id])
			if (m === 'serves') serves.push(id)
			else droppedUnconfirmed = true
		}
		return { ranked: serves, droppedUnconfirmed }
	}
}
