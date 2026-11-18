import type { Connection, Libp2p, PeerId, Startable } from '@libp2p/interface';
import type { PartitionDetector } from '../cluster/partition-detector.js';
import { admittedBy, type NetworkMembershipGate } from '../network-membership-gate.js';
import type { Logger } from '../logger.js';
import { unrefTimer } from '../unref-timer.js';

/** What woke a pass. */
export type DrainTrigger = 'start' | 'connection' | 'identify' | 'recheck' | 'manual';

/** The slice of libp2p a drain uses: identity, the connection events, who is connected, and the peer store. */
export type DrainLibp2p = Pick<Libp2p, 'peerId' | 'addEventListener' | 'removeEventListener' | 'getConnections'> & {
	peerStore: Pick<Libp2p['peerStore'], 'get'>;
};

export interface DrainSchedulerConfig {
	/** Debounce after a connection opens, a peer is identified, or `wake` is called, before a pass runs. */
	debounceMs: number;
	/** Minimum interval between passes; a trigger inside it is deferred to its end, never dropped. */
	minIntervalMs: number;
	/** Self-arming re-check while the source reports anything outstanding. `0` disables. */
	recheckIntervalMs: number;
	/** Entries examined per pass, rotating, so a backlog wider than the budget is swept in full. */
	entryBudget: number;
	/** Consecutive unconfirmed rounds per (entry, peer) before the peer is abandoned for that entry. */
	maxAttempts: number;
}

/** Seam 1: what is owed. Read once per pass. */
export interface DrainEntrySource<TEntry> {
	/** Every outstanding entry, oldest first. */
	list(): Promise<readonly TEntry[]>;
	/** Outstanding count; must be cheap once warm — it decides whether the re-check timer re-arms. */
	size(): Promise<number>;
	/** A stable string key per entry; the give-up counters are keyed by it. */
	keyOf(entry: TEntry): string;
}

/** What the scheduler lends one entry's drain step. */
export interface DrainEntryContext<TTally extends string> {
	/** `candidates` filtered to this pass's eligible peers, minus those abandoned for this entry. */
	reachable(candidates: readonly string[]): string[];
	/** One unconfirmed round for `peerId` on this entry. Returns true when it abandoned the peer now. */
	noteFailure(peerId: string): boolean;
	/** `peerId` confirmed: its consecutive-failure count for this entry resets. */
	noteSuccess(peerId: string): void;
	/** The entry has left the source (settled, dropped): forget its counters now. */
	forgetEntry(): void;
	/** Count one outcome toward this pass's report. An entry may tally several. */
	tally(outcome: TTally): void;
}

/** Seam 2: the per-entry work. Never throws for an expected outcome; a throw is logged as a pass error. */
export type DrainEntryStep<TEntry, TTally extends string> = (entry: TEntry, context: DrainEntryContext<TTally>) => Promise<void>;

export interface DrainSchedulerDeps<TEntry, TTally extends string> {
	libp2p: DrainLibp2p;
	partitionDetector: Pick<PartitionDetector, 'detectPartition'>;
	/** The node's network-membership gate: a connected peer it refuses is never eligible. Absent → no check. */
	membership?: NetworkMembershipGate;
	/** A peer counts as eligible only once its peer-store protocol list includes this id. Absent → every connected admitted peer. */
	protocol?: string;
	source: DrainEntrySource<TEntry>;
	drainEntry: DrainEntryStep<TEntry, TTally>;
	/** Every tally the step may report, in the order `pass:done` prints them. */
	tallies: readonly TTally[];
	/** The word `peer:abandoned` uses for an entry key (`block`, `blob`). */
	entryLabel: string;
	/** The owner's logger, so the scheduler's lines stay under the owner's namespace. */
	log: Logger;
	/** Called with a peer's id when its only connection opens (after its give-up state is forgotten). */
	onPeerReturned?: (peerId: string) => void;
}

/** What one pass did. Counts are per entry. */
export interface DrainPassReport<TTally extends string> {
	trigger: DrainTrigger;
	/** Set when the pass did no work at all, and why. */
	skipped?: 'partition' | 'no-eligible-peer';
	/** Entries the source listed when the pass began. */
	entries: number;
	/** Entries examined this pass, up to the entry budget. */
	examined: number;
	/** Entries the budget left for a later pass. */
	deferred: number;
	/** Peers newly abandoned for an entry this pass. */
	abandoned: number;
	tallies: Record<TTally, number>;
}

/**
 * The scheduling a drain of owed copies needs, whatever it sends: when a pass runs, which peers it
 * may send to, how much of the backlog one pass examines, and when to give up on a peer. The owner
 * supplies what is owed (`source`) and what to do for one entry (`drainEntry`); everything around
 * that is here, so two drains — the block drain (`UnderReplicationDrain`) and the blob drain — share
 * one schedule, one give-up rule and one membership filter rather than two copies of them.
 *
 * - **Wake-ups.** The start (one pass, off the start path), a peer connecting or completing identify,
 *   `wake` from the owner, and a re-check timer armed while the source reports anything outstanding;
 *   `checkNow` runs a pass at once. Every trigger but `checkNow` is debounced and throttled to one
 *   pass per `minIntervalMs`, a trigger inside the window being deferred to its end, never dropped.
 *   Passes never overlap: a trigger landing mid-pass runs one more pass afterwards.
 * - **Suppression.** A pass during a detected partition does no work.
 * - **Eligibility.** A pass sends only to peers connected now, admitted by the membership gate, and
 *   — when `protocol` is given — identified as serving it.
 * - **Budget.** At most `entryBudget` entries per pass, from a rotating cursor.
 * - **Give-up.** `maxAttempts` consecutive unconfirmed rounds abandon a peer for one entry until the
 *   peer reconnects, which retries it from scratch.
 */
export class DrainScheduler<TEntry, TTally extends string> implements Startable {
	private running = false;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private timerDueAt = 0;
	private lastPassAt = 0;
	private passInFlight: Promise<DrainPassReport<TTally>> | null = null;
	private pendingTrigger: DrainTrigger | null = null;
	/** Rotation cursor into the oldest-first entry list, so a backlog wider than the budget is
	 *  swept in full over successive passes rather than the same oldest slice every time. */
	private cursor = 0;
	/** Consecutive unconfirmed rounds per (entry key, peer) — the give-up counter. */
	private readonly failures = new Map<string, Map<string, number>>();
	/** Peers given up on per entry key; excluded until they reconnect. */
	private readonly abandoned = new Map<string, Set<string>>();
	private readonly passDoneFormat: string;

	private readonly onConnectionOpen: (event: CustomEvent<Connection>) => void;
	private readonly onPeerIdentify: () => void;

	constructor(
		private readonly deps: DrainSchedulerDeps<TEntry, TTally>,
		private readonly config: DrainSchedulerConfig
	) {
		this.passDoneFormat = 'pass:done trigger=%s entries=%d examined=%d deferred=%d'
			+ deps.tallies.map(name => ` ${name}=%d`).join('') + ' abandoned=%d';
		this.onConnectionOpen = (event) => this.handleConnectionOpen(event);
		this.onPeerIdentify = () => this.schedule('identify');
	}

	// ── Startable ────────────────────────────────────────────────────

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.deps.libp2p.addEventListener('connection:open', this.onConnectionOpen);
		this.deps.libp2p.addEventListener('peer:identify', this.onPeerIdentify);
		this.deps.log('started');
		// Off the start path so a slow scan never blocks the node coming up.
		void this.run('start').catch(err => { this.deps.log('start pass error: %o', err); });
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		this.deps.libp2p.removeEventListener('connection:open', this.onConnectionOpen);
		this.deps.libp2p.removeEventListener('peer:identify', this.onPeerIdentify);
		this.clearDebounce();
		this.clearTimer();
		this.pendingTrigger = null;
		// An in-flight pass checks `running` between entries and bails; it is not awaited here so a
		// stop never waits out a push deadline.
		this.deps.log('stopped');
	}

	// ── Public API ───────────────────────────────────────────────────

	/** Run one pass now, bypassing the debounce and the interval throttle. Waits for an in-flight pass first. */
	async checkNow(): Promise<DrainPassReport<TTally>> {
		if (this.passInFlight) await this.passInFlight.catch(() => undefined);
		return this.run('manual');
	}

	/**
	 * Ask for a pass through the debounce and the interval throttle, as a connection event does — for
	 * an owner that has just added an entry. Forgets no peer state. A no-op while stopped.
	 */
	wake(): void {
		this.schedule('manual');
	}

	/** Observability: given-up (entry, peer) pairs, whether a timer is armed, and the last pass. */
	getDiagnostics(): { abandonedPairs: number; timerArmed: boolean; lastPassAt: number } {
		let abandonedPairs = 0;
		for (const peers of this.abandoned.values()) abandonedPairs += peers.size;
		return { abandonedPairs, timerArmed: this.timer !== null, lastPassAt: this.lastPassAt };
	}

	// ── Scheduling ───────────────────────────────────────────────────

	private handleConnectionOpen(event: CustomEvent<Connection>): void {
		if (!this.running) return;
		// A peer that comes back is retried from scratch: its abandonment and give-up counts go.
		// Only a FRESH connection counts — libp2p opens parallel connections to one peer, and a second
		// one must not wipe the record of a peer that never went away.
		// NOTE: "fresh" is read as "this is the peer's only connection", which relies on libp2p's
		// connection manager having registered the new connection before this listener runs. True on
		// libp2p 3.x: the manager subscribes to `connection:open` at its own start (before any user
		// listener) and stores the connection synchronously, before its first await. If a libp2p
		// upgrade ever defers that store, every parallel connection would look fresh and an abandoned
		// peer would be retried on each one — cheap, not wrong — and the check would want the
		// `peer:connect` event instead, which fires only for a peer's first connection.
		const remotePeer = event?.detail?.remotePeer;
		if (remotePeer !== undefined && this.deps.libp2p.getConnections(remotePeer).length <= 1) {
			const peerId = remotePeer.toString();
			this.forgetPeer(peerId);
			this.deps.onPeerReturned?.(peerId);
		}
		this.schedule('connection');
	}

	private schedule(trigger: DrainTrigger): void {
		if (!this.running) return;
		this.clearDebounce();
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.maybeRun(trigger);
		}, this.config.debounceMs);
		unrefTimer(this.debounceTimer);
	}

	/** Run now, or defer to the end of the minimum interval — a trigger is never dropped. */
	private maybeRun(trigger: DrainTrigger): void {
		if (!this.running) return;
		const wait = this.lastPassAt + this.config.minIntervalMs - Date.now();
		if (wait > 0) {
			this.deps.log('throttled trigger=%s wait=%dms', trigger, wait);
			this.armTimer(wait, trigger);
			return;
		}
		void this.run(trigger).catch(err => { this.deps.log('pass error trigger=%s: %o', trigger, err); });
	}

	/** Arm the one timer, pulling an already-armed one EARLIER when `delayMs` asks for sooner. */
	private armTimer(delayMs: number, trigger: DrainTrigger): void {
		if (!this.running) return;
		const dueAt = Date.now() + delayMs;
		if (this.timer !== null) {
			if (this.timerDueAt <= dueAt) return;
			this.clearTimer();
		}
		this.timerDueAt = dueAt;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.maybeRun(trigger);
		}, delayMs);
		unrefTimer(this.timer);
	}

	private clearTimer(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private clearDebounce(): void {
		if (this.debounceTimer !== null) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}

	/** Arm the re-check while anything is outstanding; otherwise let the timer lapse. */
	private async rearmRecheck(): Promise<void> {
		if (!this.running || this.config.recheckIntervalMs <= 0) return;
		const outstanding = await this.deps.source.size();
		if (outstanding > 0) this.armTimer(this.config.recheckIntervalMs, 'recheck');
	}

	// ── The pass ─────────────────────────────────────────────────────

	/** One pass, never overlapping another: a trigger that lands mid-pass runs one more afterwards. */
	private run(trigger: DrainTrigger): Promise<DrainPassReport<TTally>> {
		if (this.passInFlight) {
			this.pendingTrigger = trigger;
			return this.passInFlight;
		}
		const pass = this.performPass(trigger).finally(() => {
			this.passInFlight = null;
			const pending = this.pendingTrigger;
			this.pendingTrigger = null;
			if (pending !== null) this.maybeRun(pending);
		});
		this.passInFlight = pass;
		return pass;
	}

	private async performPass(trigger: DrainTrigger): Promise<DrainPassReport<TTally>> {
		const report = this.emptyReport(trigger);
		// A pass that scanned counts for the throttle however it ends — a source fault mid-pass must
		// not make the next trigger an unthrottled retry. A skipped pass is free and does not count.
		let scanned = false;
		try {
			if (this.deps.partitionDetector.detectPartition()) {
				this.deps.log('pass:skip trigger=%s reason=partition', trigger);
				return { ...report, skipped: 'partition' };
			}
			const eligible = await this.eligiblePeers();
			this.forgetDisconnected(eligible);
			if (eligible.size === 0) {
				return { ...report, skipped: 'no-eligible-peer' };
			}

			const entries = await this.deps.source.list();
			scanned = true;
			this.pruneState(entries);
			report.entries = entries.length;
			const examined = this.takeBudget(entries);
			report.examined = examined.length;
			report.deferred = entries.length - examined.length;

			for (const entry of examined) {
				if (!this.running) break;
				await this.deps.drainEntry(entry, this.contextFor(this.deps.source.keyOf(entry), eligible, report));
			}
			this.deps.log(this.passDoneFormat, trigger, report.entries, report.examined, report.deferred,
				...this.deps.tallies.map(name => report.tallies[name]), report.abandoned);
			return report;
		} finally {
			if (scanned) this.lastPassAt = Date.now();
			await this.rearmRecheck();
		}
	}

	private emptyReport(trigger: DrainTrigger): DrainPassReport<TTally> {
		const tallies = Object.fromEntries(this.deps.tallies.map(name => [name, 0])) as Record<TTally, number>;
		return { trigger, entries: 0, examined: 0, deferred: 0, abandoned: 0, tallies };
	}

	private contextFor(key: string, eligible: Set<string>, report: DrainPassReport<TTally>): DrainEntryContext<TTally> {
		return {
			reachable: (candidates) => {
				const abandoned = this.abandoned.get(key);
				return candidates.filter(peerId => eligible.has(peerId) && !abandoned?.has(peerId));
			},
			noteFailure: (peerId) => {
				const abandonedNow = this.countFailure(key, peerId);
				if (abandonedNow) report.abandoned++;
				return abandonedNow;
			},
			noteSuccess: (peerId) => { this.failures.get(key)?.delete(peerId); },
			forgetEntry: () => this.forgetKey(key),
			tally: (outcome) => { report.tallies[outcome]++; }
		};
	}

	/** The next `entryBudget` entries from the rotation cursor, wrapping; the cursor advances past them. */
	private takeBudget(entries: readonly TEntry[]): readonly TEntry[] {
		const budget = Math.max(1, this.config.entryBudget);
		if (entries.length <= budget) {
			this.cursor = 0;
			return entries;
		}
		const start = this.cursor % entries.length;
		const taken = [...entries.slice(start, start + budget), ...entries.slice(0, Math.max(0, start + budget - entries.length))];
		this.cursor = (start + budget) % entries.length;
		return taken;
	}

	/** Count one unconfirmed round for a peer; abandon it at the bound. @returns whether it was abandoned now. */
	private countFailure(key: string, peerId: string): boolean {
		let perPeer = this.failures.get(key);
		if (!perPeer) {
			perPeer = new Map();
			this.failures.set(key, perPeer);
		}
		const count = (perPeer.get(peerId) ?? 0) + 1;
		if (count < this.config.maxAttempts) {
			perPeer.set(peerId, count);
			return false;
		}
		perPeer.delete(peerId);
		let peers = this.abandoned.get(key);
		if (!peers) {
			peers = new Set();
			this.abandoned.set(key, peers);
		}
		peers.add(peerId);
		this.deps.log('peer:abandoned %s=%s peer=%s after=%d rounds (until it reconnects)', this.deps.entryLabel, key, peerId, count);
		return true;
	}

	/**
	 * Connected peers this pass may send to. A peer the membership gate refuses never counts: a
	 * peer-store protocol list is one any connected peer can write. With a `protocol` configured, a
	 * peer counts only once identify has filled its protocol list with it, so a peer that just
	 * connected is not yet eligible; the `peer:identify` trigger brings it in.
	 */
	private async eligiblePeers(): Promise<Set<string>> {
		const seen = new Set<string>();
		const eligible = new Set<string>();
		for (const connection of this.deps.libp2p.getConnections()) {
			const peerId = connection.remotePeer;
			const peerIdStr = peerId.toString();
			if (seen.has(peerIdStr)) continue;
			seen.add(peerIdStr);
			if (!admittedBy(this.deps.membership, peerIdStr)) continue;
			if (this.deps.protocol === undefined || await this.servesProtocol(peerId, this.deps.protocol)) {
				eligible.add(peerIdStr);
			}
		}
		return eligible;
	}

	private async servesProtocol(peerId: PeerId, protocol: string): Promise<boolean> {
		try {
			const peer = await this.deps.libp2p.peerStore.get(peerId);
			return peer.protocols.includes(protocol);
		} catch {
			// Not in the peer store (not yet identified) or a store fault: not eligible this pass.
			return false;
		}
	}

	// ── In-memory state upkeep ───────────────────────────────────────

	private forgetPeer(peerId: string): void {
		for (const peers of this.failures.values()) peers.delete(peerId);
		for (const [key, peers] of this.abandoned) {
			if (peers.delete(peerId) && peers.size === 0) this.abandoned.delete(key);
		}
	}

	/** An abandoned peer that has gone is forgotten: when it returns it is retried from scratch. */
	private forgetDisconnected(eligible: Set<string>): void {
		for (const [key, peers] of this.abandoned) {
			for (const peerId of peers) {
				if (!eligible.has(peerId)) peers.delete(peerId);
			}
			if (peers.size === 0) this.abandoned.delete(key);
		}
	}

	private forgetKey(key: string): void {
		this.failures.delete(key);
		this.abandoned.delete(key);
	}

	/** Drop state for entries the source no longer lists (settled, evicted, dropped). */
	private pruneState(entries: readonly TEntry[]): void {
		const listed = new Set(entries.map(entry => this.deps.source.keyOf(entry)));
		for (const key of [...this.failures.keys(), ...this.abandoned.keys()]) {
			if (!listed.has(key)) this.forgetKey(key);
		}
	}
}
