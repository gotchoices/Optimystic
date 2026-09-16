import type { Connection, Libp2p, PeerId, Startable } from '@libp2p/interface';
import type { BlockDurabilityReachedEvent, BlockId, IKeyNetwork } from '@optimystic/db-core';
import { routingKeyForBlock } from '@optimystic/db-core';
import type { PartitionDetector } from '../cluster/partition-detector.js';
import type { PushBlockOutcome } from '../cluster/block-transfer-service.js';
import { buildBlockTransferProtocol } from '../cluster/block-transfer-service.js';
import type { IUnderReplicationLedger, UnderReplicatedEntry } from './i-under-replication-ledger.js';
import { createLogger } from '../logger.js';

const log = createLogger('under-replication-drain');

export interface UnderReplicationDrainConfig {
	/** Debounce after a connection opens or a peer is identified, before a pass runs. Default: 5000 */
	debounceMs: number;
	/**
	 * Minimum interval between passes (ms). A trigger inside the window is DEFERRED to the window's
	 * end, never dropped, so a flapping peer costs at most one pass per interval and a peer that
	 * arrives mid-window is still drained to. Default: 15000
	 */
	minIntervalMs: number;
	/**
	 * Self-arming re-check timer while any ledger entry is outstanding (ms). Passes otherwise fire
	 * only on connection events, so a failed push on a then-quiet network — or a shortfall recorded
	 * while its missing member was already connected — would wait for the next arrival. Cheap while
	 * nothing can be pushed: a tick with no pushable peer connected costs one connection scan and
	 * one in-memory count. `0` disables. Default: 30000
	 */
	recheckIntervalMs: number;
	/**
	 * Entries examined per pass. Passes rotate through the ledger, oldest-recorded first, so a large
	 * backlog drains one budget per pass and no entry starves behind a stuck one. A deferred entry is
	 * not touched at all; it is re-examined on a later pass. Default: 64
	 */
	blockBudget: number;
	/**
	 * Consecutive rounds a reachable peer may fail to confirm one block before it is ABANDONED for
	 * that block — no longer pushed to — until it reconnects, which retries it from scratch. The
	 * entry itself stays in the ledger, visible, whatever happens here. Default: 5
	 */
	maxAttempts: number;
}

export const DEFAULT_UNDER_REPLICATION_DRAIN_CONFIG: UnderReplicationDrainConfig = {
	debounceMs: 5000,
	minIntervalMs: 15_000,
	recheckIntervalMs: 30_000,
	blockBudget: 64,
	maxAttempts: 5
};

/**
 * The one method the drain may call on the node's storage repo: emit a full-replication event.
 * Handed in as a function, exactly as the cluster side receives a `CommitCertificateSink`, so the
 * drain has no way to reach anything else on the repo.
 */
export type BlockDurabilitySink = (event: BlockDurabilityReachedEvent) => void;

/**
 * The push primitive, already bound to this node's own store, dialer and protocol prefix — the
 * node binds `pushBlockToPeers` (`cluster/block-transfer-service.ts`); a unit test binds a double.
 */
export type BoundBlockPusher = (blockId: BlockId, peerIds: readonly string[]) => Promise<PushBlockOutcome>;

/** The slice of libp2p the drain uses: identity, the connection events, and who is connected. */
export type DrainLibp2p = Pick<Libp2p, 'peerId' | 'addEventListener' | 'removeEventListener' | 'getConnections'> & {
	peerStore: Pick<Libp2p['peerStore'], 'get'>;
};

export interface UnderReplicationDrainDeps {
	libp2p: DrainLibp2p;
	ledger: IUnderReplicationLedger;
	/** Re-resolves a block's cohort for an entry that could not name its missing members. */
	keyNetwork: Pick<IKeyNetwork, 'findCluster'>;
	partitionDetector: Pick<PartitionDetector, 'detectPartition'>;
	pushBlock: BoundBlockPusher;
	emit: BlockDurabilitySink;
	/** The `/optimystic/<networkName>` prefix; a connected peer counts as pushable only once identify
	 *  reports it serving this network's block-transfer protocol. Default: none (any connected peer). */
	protocolPrefix?: string;
}

/** What woke a pass. */
export type DrainTrigger = 'start' | 'connection' | 'identify' | 'recheck' | 'manual';

/** What one pass did. Counts are per ledger ENTRY (one per block). */
export interface DrainPassResult {
	trigger: DrainTrigger;
	/** Set when the pass did no work at all, and why. */
	skipped?: 'partition' | 'no-pushable-peer';
	/** Entries in the ledger when the pass began. */
	entries: number;
	/** Entries examined this pass, up to the block budget. */
	examined: number;
	/** Entries the budget left for a later pass. */
	deferred: number;
	/** Entries whose cohort resolves to this node alone: nothing owed, nothing counted. */
	solo: number;
	/** Entries owing a copy to nobody currently pushable (not connected, not yet identified, or
	 *  abandoned) — or whose cohort could not be resolved this pass. */
	waiting: number;
	/** Entries pushed to at least one peer. */
	pushed: number;
	/** Entries whose last shortfall cleared — one full-replication event fired for each. */
	cleared: number;
	/** Entries deleted because the block is gone from local storage. */
	dropped: number;
	/** Peers newly abandoned for a block this pass. */
	abandoned: number;
}

/** Who an entry still owes a copy to, or that it owes nobody because the node is alone. */
type Owed =
	| { kind: 'solo' }
	| { kind: 'unresolved' }
	| { kind: 'peers'; peerIds: string[]; named: boolean };

const zeroCounts = (trigger: DrainTrigger): DrainPassResult => ({
	trigger, entries: 0, examined: 0, deferred: 0, solo: 0, waiting: 0, pushed: 0, cleared: 0, dropped: 0, abandoned: 0
});

/**
 * Sends the copies the under-replication ledger says this node still owes, and says when a block
 * finally has all of them.
 *
 * `CoordinatorRepo.commit` writes an entry per block it acknowledged below full replication, naming
 * the cohort members that had not confirmed it (or an EMPTY set when no cohort could be named — a
 * `local` or `unrouted` write). This service is the other half: on start, whenever a peer connects or
 * is identified, and on a re-check timer while anything is outstanding, it walks the ledger and pushes
 * each block to the owed peers that are reachable right now. A peer that confirms is removed from the
 * entry; when the entry empties it is deleted and ONE {@link BlockDurabilityReachedEvent} fires through
 * the sink — after the deletion, never before.
 *
 * What it deliberately does not do:
 * - **Dial the world.** A copy goes only to a peer that is connected and identified as serving this
 *   network. An entry whose owed peers are all away simply waits; the next arrival wakes the drain.
 * - **Re-resolve a NAMED peer.** A `majority` entry names members that were in the cohort when the
 *   write was acknowledged; a copy there is never harmful even if the cohort has since moved on.
 * - **Count an attempt against a node that is alone.** An entry with no named members whose cohort
 *   still resolves to this node alone is left exactly as it is: nobody is owed anything yet.
 * - **Delete an entry to tidy up.** Only a confirmed copy (or the block leaving local storage) removes
 *   one. A peer that never returns leaves its entry in place; the ledger's size cap is the backstop.
 * - **Coordinate with the rebalance growth arm or spread-on-churn.** All three may push the same
 *   block to the same peer; the receiver is idempotent, so the overlap costs duplicate work only.
 *
 * NOTE: a pass that finds work SCANS the ledger (`IUnderReplicationLedger.list`, one store read per
 * entry) and examines up to `blockBudget` entries, oldest first. Bounded by the node's owned-block
 * count today. If a node ever holds so many under-replicated blocks that the scan shows up — a long
 * solo run with a persistent store — index the ledger by missing peer instead of scanning, and
 * consider draining newest-first so a host's most recent pending writes settle before old ones.
 */
export class UnderReplicationDrain implements Startable {
	private running = false;
	private readonly config: UnderReplicationDrainConfig;
	private readonly blockTransferProtocol: string;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private timerDueAt = 0;
	private lastPassAt = 0;
	private passInFlight: Promise<DrainPassResult> | null = null;
	private pendingTrigger: DrainTrigger | null = null;
	/** Rotation cursor into the oldest-first entry list, so a backlog wider than the budget is
	 *  swept in full over successive passes rather than the same oldest slice every time. */
	private cursor = 0;
	/** Consecutive unconfirmed rounds per (block, peer) — the give-up counter. */
	private readonly failures = new Map<BlockId, Map<string, number>>();
	/** Peers given up on per block; excluded from pushes until they reconnect. */
	private readonly abandoned = new Map<BlockId, Set<string>>();

	private readonly onConnectionOpen: (event: CustomEvent<Connection>) => void;
	private readonly onPeerIdentify: () => void;

	constructor(
		private readonly deps: UnderReplicationDrainDeps,
		config: Partial<UnderReplicationDrainConfig> = {}
	) {
		this.config = { ...DEFAULT_UNDER_REPLICATION_DRAIN_CONFIG, ...config };
		this.blockTransferProtocol = buildBlockTransferProtocol(deps.protocolPrefix ?? '');
		this.onConnectionOpen = (event) => this.handleConnectionOpen(event);
		this.onPeerIdentify = () => this.schedule('identify');
	}

	// ── Startable ────────────────────────────────────────────────────

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.deps.libp2p.addEventListener('connection:open', this.onConnectionOpen);
		this.deps.libp2p.addEventListener('peer:identify', this.onPeerIdentify);
		log('started');
		// The one case no in-memory mechanism ever covered: entries the ledger carried across a
		// restart. Off the start path so a slow scan never blocks the node coming up.
		void this.run('start').catch(err => { log('start pass error: %o', err); });
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
		log('stopped');
	}

	// ── Public API ───────────────────────────────────────────────────

	/** Run one pass now, bypassing the debounce and the interval throttle. Waits for an in-flight pass first. */
	async checkNow(): Promise<DrainPassResult> {
		if (this.passInFlight) await this.passInFlight.catch(() => undefined);
		return this.run('manual');
	}

	/** Observability: given-up (block, peer) pairs, whether a timer is armed, and the last pass. */
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
		const remotePeer = event?.detail?.remotePeer;
		if (remotePeer !== undefined && this.deps.libp2p.getConnections(remotePeer).length <= 1) {
			this.forgetPeer(remotePeer.toString());
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
		unref(this.debounceTimer);
	}

	/** Run now, or defer to the end of the minimum interval — a trigger is never dropped. */
	private maybeRun(trigger: DrainTrigger): void {
		if (!this.running) return;
		const wait = this.lastPassAt + this.config.minIntervalMs - Date.now();
		if (wait > 0) {
			log('throttled trigger=%s wait=%dms', trigger, wait);
			this.armTimer(wait, trigger);
			return;
		}
		void this.run(trigger).catch(err => { log('pass error trigger=%s: %o', trigger, err); });
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
		unref(this.timer);
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
		const outstanding = await this.deps.ledger.size();
		if (outstanding > 0) this.armTimer(this.config.recheckIntervalMs, 'recheck');
	}

	// ── The pass ─────────────────────────────────────────────────────

	/** One pass, never overlapping another: a trigger that lands mid-pass runs one more afterwards. */
	private run(trigger: DrainTrigger): Promise<DrainPassResult> {
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

	private async performPass(trigger: DrainTrigger): Promise<DrainPassResult> {
		const counts = zeroCounts(trigger);
		try {
			if (this.deps.partitionDetector.detectPartition()) {
				log('pass:skip trigger=%s reason=partition', trigger);
				return { ...counts, skipped: 'partition' };
			}
			const pushable = await this.pushablePeers();
			this.forgetDisconnected(pushable);
			if (pushable.size === 0) {
				return { ...counts, skipped: 'no-pushable-peer' };
			}

			const entries = await this.deps.ledger.list();
			this.pruneState(entries);
			counts.entries = entries.length;
			const examined = this.takeBudget(entries);
			counts.examined = examined.length;
			counts.deferred = entries.length - examined.length;

			for (const entry of examined) {
				if (!this.running) break;
				await this.drainEntry(entry, pushable, counts);
			}
			this.lastPassAt = Date.now();
			log('pass:done trigger=%s entries=%d examined=%d deferred=%d solo=%d waiting=%d pushed=%d cleared=%d dropped=%d abandoned=%d',
				trigger, counts.entries, counts.examined, counts.deferred, counts.solo, counts.waiting,
				counts.pushed, counts.cleared, counts.dropped, counts.abandoned);
			return counts;
		} finally {
			await this.rearmRecheck();
		}
	}

	/** The next `blockBudget` entries from the rotation cursor, wrapping; the cursor advances past them. */
	private takeBudget(entries: UnderReplicatedEntry[]): UnderReplicatedEntry[] {
		const budget = Math.max(1, this.config.blockBudget);
		if (entries.length <= budget) {
			this.cursor = 0;
			return entries;
		}
		const start = this.cursor % entries.length;
		const taken = [...entries.slice(start, start + budget), ...entries.slice(0, Math.max(0, start + budget - entries.length))];
		this.cursor = (start + budget) % entries.length;
		return taken;
	}

	private async drainEntry(entry: UnderReplicatedEntry, pushable: Set<string>, counts: DrainPassResult): Promise<void> {
		const owed = await this.owedPeers(entry);
		if (owed.kind === 'solo') {
			counts.solo++;
			return;
		}
		if (owed.kind === 'unresolved') {
			counts.waiting++;
			return;
		}
		const abandoned = this.abandoned.get(entry.blockId);
		const reachable = owed.peerIds.filter(peerId => pushable.has(peerId) && !abandoned?.has(peerId));
		if (reachable.length === 0) {
			counts.waiting++;
			return;
		}

		const outcome = await this.deps.pushBlock(entry.blockId, reachable);
		if (outcome.status === 'no-local-data') {
			// A block this node no longer holds is not one it can owe — the same call spread-on-churn
			// makes when a tracked block has left local storage.
			log('entry:dropped block=%s rev=%d (no local data)', entry.blockId, entry.rev);
			await this.deps.ledger.delete(entry.blockId);
			this.forgetBlock(entry.blockId);
			counts.dropped++;
			return;
		}
		if (outcome.status === 'unavailable') {
			// Could not find out what this node holds — not "holds nothing". Keep the entry, count nothing.
			log('entry:unavailable block=%s rev=%d reason=%s (keeping)', entry.blockId, entry.rev, outcome.reason);
			counts.waiting++;
			return;
		}
		counts.pushed++;
		const heldRev = outcome.latest?.rev ?? entry.rev;
		for (const peerId of outcome.confirmed) {
			log('push:ok block=%s peer=%s rev=%d', entry.blockId, peerId, heldRev);
			this.failures.get(entry.blockId)?.delete(peerId);
		}

		if (outcome.confirmed.length > 0) {
			const cleared = await this.recordConfirmed(entry, owed, outcome.confirmed, heldRev);
			if (cleared) {
				counts.cleared++;
				this.forgetBlock(entry.blockId);
				// After the deletion, never before: a listener that re-reads the ledger sees it gone.
				this.deps.emit({ blockIds: [entry.blockId], rev: entry.rev, actionId: entry.actionId, collectionId: outcome.collectionId });
				return;
			}
		}
		if (outcome.refusals.length > 0) {
			await this.deps.ledger.noteAttempt(entry.blockId);
			counts.abandoned += this.noteRefusals(entry, outcome);
		}
	}

	/**
	 * Take the confirmed peers off the entry. An entry that could not name its members is named now,
	 * at its own revision, with the cohort resolved for this push — so `satisfy` has a set to shrink.
	 * Both writes carry the revision guard: a newer shortfall recorded while the push was in flight
	 * is left alone (`record` skips a lower revision; `satisfy` keeps a higher one).
	 *
	 * @returns whether the entry is gone — its last missing member confirmed.
	 */
	private async recordConfirmed(entry: UnderReplicatedEntry, owed: Owed & { kind: 'peers' }, confirmed: string[], heldRev: number): Promise<boolean> {
		if (!owed.named) {
			await this.deps.ledger.record({ ...entry, missingPeerIds: owed.peerIds });
		}
		const remaining = await this.deps.ledger.satisfy(entry.blockId, confirmed, heldRev);
		if (remaining === undefined) {
			log('entry:cleared block=%s rev=%d action=%s', entry.blockId, entry.rev, entry.actionId);
			return true;
		}
		return false;
	}

	/** Log each refusal so "cannot place" reads differently from "cannot reach", and count the round. */
	private noteRefusals(entry: UnderReplicatedEntry, outcome: PushBlockOutcome & { status: 'pushed' }): number {
		let abandoned = 0;
		for (const refusal of outcome.refusals) {
			if (refusal.reason === 'rejected') {
				// Uncertified means this node retained no proof for the revision: the receiver's
				// default policy refuses it, and no retry changes that until the block is rewritten.
				log('push:rejected block=%s peer=%s rev=%d certified=%s%s', entry.blockId, refusal.peerId, entry.rev,
					outcome.certified, outcome.certified ? '' : ' (no retained proof — cannot place)');
			} else {
				log('push:unreachable block=%s peer=%s err=%s', entry.blockId, refusal.peerId, refusal.error);
			}
			if (this.countFailure(entry.blockId, refusal.peerId)) abandoned++;
		}
		return abandoned;
	}

	/** Count one unconfirmed round for a peer; abandon it at the bound. @returns whether it was abandoned now. */
	private countFailure(blockId: BlockId, peerId: string): boolean {
		let perPeer = this.failures.get(blockId);
		if (!perPeer) {
			perPeer = new Map();
			this.failures.set(blockId, perPeer);
		}
		const count = (perPeer.get(peerId) ?? 0) + 1;
		if (count < this.config.maxAttempts) {
			perPeer.set(peerId, count);
			return false;
		}
		perPeer.delete(peerId);
		let peers = this.abandoned.get(blockId);
		if (!peers) {
			peers = new Set();
			this.abandoned.set(blockId, peers);
		}
		peers.add(peerId);
		log('peer:abandoned block=%s peer=%s after=%d rounds (until it reconnects)', blockId, peerId, count);
		return true;
	}

	/**
	 * Who the entry still owes. Named members are taken as recorded. An unknown set re-resolves the
	 * cohort NOW; a cohort of this node alone is `solo` — not a failure, not an attempt.
	 */
	private async owedPeers(entry: UnderReplicatedEntry): Promise<Owed> {
		const selfId = this.deps.libp2p.peerId.toString();
		if (entry.missingPeerIds.length > 0) {
			return { kind: 'peers', peerIds: entry.missingPeerIds.filter(peerId => peerId !== selfId), named: true };
		}
		let cluster: Awaited<ReturnType<IKeyNetwork['findCluster']>>;
		try {
			cluster = await this.deps.keyNetwork.findCluster(routingKeyForBlock(entry.blockId));
		} catch (err) {
			log('cohort:unresolved block=%s err=%s', entry.blockId, err instanceof Error ? err.message : String(err));
			return { kind: 'unresolved' };
		}
		const members = Object.keys(cluster).filter(peerId => peerId !== selfId);
		return members.length === 0 ? { kind: 'solo' } : { kind: 'peers', peerIds: members, named: false };
	}

	/**
	 * Connected peers identified as serving this network's block-transfer protocol — the only peers a
	 * push can land on. Identify fills the peer store's protocol list, so a peer that just connected
	 * is not yet pushable; the `peer:identify` trigger brings it in. With no prefix configured every
	 * connected peer counts.
	 */
	private async pushablePeers(): Promise<Set<string>> {
		const seen = new Set<string>();
		const pushable = new Set<string>();
		for (const connection of this.deps.libp2p.getConnections()) {
			const peerId = connection.remotePeer;
			const peerIdStr = peerId.toString();
			if (seen.has(peerIdStr)) continue;
			seen.add(peerIdStr);
			if (this.deps.protocolPrefix === undefined || await this.servesBlockTransfer(peerId)) {
				pushable.add(peerIdStr);
			}
		}
		return pushable;
	}

	private async servesBlockTransfer(peerId: PeerId): Promise<boolean> {
		try {
			const peer = await this.deps.libp2p.peerStore.get(peerId);
			return peer.protocols.includes(this.blockTransferProtocol);
		} catch {
			// Not in the peer store (not yet identified) or a store fault: not pushable this pass.
			return false;
		}
	}

	// ── In-memory state upkeep ───────────────────────────────────────

	private forgetPeer(peerId: string): void {
		for (const peers of this.failures.values()) peers.delete(peerId);
		for (const [blockId, peers] of this.abandoned) {
			if (peers.delete(peerId) && peers.size === 0) this.abandoned.delete(blockId);
		}
	}

	/** An abandoned peer that has gone is forgotten: when it returns it is retried from scratch. */
	private forgetDisconnected(pushable: Set<string>): void {
		for (const [blockId, peers] of this.abandoned) {
			for (const peerId of peers) {
				if (!pushable.has(peerId)) peers.delete(peerId);
			}
			if (peers.size === 0) this.abandoned.delete(blockId);
		}
	}

	private forgetBlock(blockId: BlockId): void {
		this.failures.delete(blockId);
		this.abandoned.delete(blockId);
	}

	/** Drop state for blocks the ledger no longer lists (settled by a `full` commit, evicted, dropped). */
	private pruneState(entries: UnderReplicatedEntry[]): void {
		const listed = new Set(entries.map(entry => entry.blockId));
		for (const blockId of [...this.failures.keys(), ...this.abandoned.keys()]) {
			if (!listed.has(blockId)) this.forgetBlock(blockId);
		}
	}
}

/** Never hold the process open for a drain timer. */
function unref(timer: ReturnType<typeof setTimeout>): void {
	(timer as unknown as { unref?: () => void }).unref?.();
}
