import {
	type IPeerReputation,
	type PeerRecord,
	type PenaltyRecord,
	type PeerReputationSummary,
	type ReputationConfig,
	type ReputationThresholds,
	PenaltyReason,
	DEFAULT_PENALTY_WEIGHTS,
	DEFAULT_THRESHOLDS,
} from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('peer-reputation');

export class PeerReputationService implements IPeerReputation {
	// Bounded at `maxPeers`, enforced in `getOrCreateRecord` — the one place an entry is created. The keys
	// arrive off the wire (`ClusterMember.validateSignatures` reports against the peer ids of an inbound
	// consensus record, on a protocol whose per-stream authorization is opt-in), so a collection keyed this
	// way is bounded where entries are admitted, as `peer-address-book.ts` does for its own ingress.
	// NOTE: accepted limits of the cap. (a) Only bans are protected, so a spray of fresh names (each scoring
	// as much as a single `InvalidSignature`) can push a lower-scoring deprioritized record out — the same
	// effect time has, sooner. (b) An attacker with unlimited fresh keys can fill the table with
	// ban-weight records, after which genuine new offenders go unrecorded until those decay (minutes at the
	// default half-life). Both stand until an authenticated membership layer exists to say which names are
	// worth a slot; revisit then. A forgotten name scores 0, exactly what an unseen machine already scores.
	private readonly peers = new Map<string, PeerRecord>();
	private readonly halfLifeMs: number;
	private readonly thresholds: ReputationThresholds;
	private readonly weights: Record<PenaltyReason, number>;
	private readonly maxPenaltiesPerPeer: number;
	private readonly maxPeers: number;
	private readonly selfPeerId: string | undefined;
	private selfReportsRefused = 0;
	private newRecordsRefused = 0;

	constructor(config?: ReputationConfig) {
		this.halfLifeMs = config?.halfLifeMs ?? 30 * 60_000;
		this.thresholds = {
			...DEFAULT_THRESHOLDS,
			...config?.thresholds,
		};
		this.weights = {
			...DEFAULT_PENALTY_WEIGHTS,
			...config?.weights,
		};
		this.maxPenaltiesPerPeer = config?.maxPenaltiesPerPeer ?? 100;
		this.maxPeers = config?.maxPeers ?? 1024;
		this.selfPeerId = config?.selfPeerId;
	}

	reportPeer(peerId: string, reason: PenaltyReason, context?: string): void {
		if (this.refuseSelfReport(peerId, reason, context)) return;
		const record = this.getOrCreateRecord(peerId);
		if (!record) return;
		const weight = this.weights[reason];
		const penalty: PenaltyRecord = {
			reason,
			weight,
			timestamp: Date.now(),
			context,
		};
		record.penalties.push(penalty);
		record.lastPenalty = penalty.timestamp;
		this.pruneRecord(record);

		const score = this.computeScore(record);
		log('report peerId=%s reason=%s weight=%d score=%d context=%s',
			peerId.substring(0, 12), reason, weight, Math.round(score), context ?? '');
	}

	recordSuccess(peerId: string): void {
		// Silent, unlike a refused report — a success naming this machine is not a fault worth counting.
		// Refusing it here is what keeps "no record for this machine is ever created" true, so the read
		// methods answer 0 / false for it by construction rather than by a second guard.
		if (this.isSelf(peerId)) return;
		const record = this.getOrCreateRecord(peerId);
		if (!record) return;
		record.successCount++;
		record.lastSuccess = Date.now();
	}

	getScore(peerId: string): number {
		const record = this.peers.get(peerId);
		if (!record) return 0;
		return this.computeScore(record);
	}

	isBanned(peerId: string): boolean {
		return this.getScore(peerId) >= this.thresholds.ban;
	}

	isDeprioritized(peerId: string): boolean {
		return this.getScore(peerId) >= this.thresholds.deprioritize;
	}

	getReputation(peerId: string): PeerReputationSummary {
		const score = this.getScore(peerId);
		const record = this.peers.get(peerId);
		return {
			peerId,
			effectiveScore: score,
			isBanned: score >= this.thresholds.ban,
			isDeprioritized: score >= this.thresholds.deprioritize,
			penaltyCount: record?.penalties.length ?? 0,
			successCount: record?.successCount ?? 0,
			lastPenalty: record?.lastPenalty ?? 0,
			lastSuccess: record?.lastSuccess ?? 0,
		};
	}

	getAllReputations(): Map<string, PeerReputationSummary> {
		const result = new Map<string, PeerReputationSummary>();
		for (const peerId of this.peers.keys()) {
			result.set(peerId, this.getReputation(peerId));
		}
		return result;
	}

	resetPeer(peerId: string): void {
		this.peers.delete(peerId);
		log('reset peerId=%s', peerId.substring(0, 12));
	}

	/**
	 * Whether `peerId` names the machine running this service — the one identifier this table never
	 * describes. An unconfigured `selfPeerId` matches nothing, so a service built without one scores
	 * every identifier, this machine's included.
	 *
	 * NOTE: exact string equality against `PeerId.toString()` output, which covers only the canonical
	 * spelling of an identity. `peerIdFromString` accepts others (a base58btc CIDv1, for instance), so an
	 * attacker-supplied consensus record can spell this machine's id a second way, bind its real key
	 * (`peerIdBindsPublicKey`), and reach `reportPeer` past this comparison. That is inert today because
	 * the only live readers of a score — `isBanned` and `getScore`, from `isSelectable` and the two
	 * candidate sorts in `libp2p-key-network.ts` — always look up a locally-produced `toString()`, so a
	 * record filed under any other spelling is one nothing reads. If a reader is ever added that looks a
	 * score up by a string taken off the wire, normalize through `peerIdFromString(...).toString()` here
	 * first — the guard becomes bypassable the moment that stops being true.
	 */
	private isSelf(peerId: string): boolean {
		return this.selfPeerId !== undefined && peerId === this.selfPeerId;
	}

	/**
	 * The one place a report is refused, so a reporter added later cannot bypass it. The count on the log
	 * line is how "this machine faulted N times" stays answerable without any mechanism that can take the
	 * machine out of service; the id is on it because several nodes share one logger in an in-process mesh.
	 */
	private refuseSelfReport(peerId: string, reason: PenaltyReason, context: string | undefined): boolean {
		if (!this.isSelf(peerId)) return false;
		this.selfReportsRefused++;
		log('refused self-report peerId=%s reason=%s context=%s refused=%d',
			peerId.substring(0, 12), reason, context ?? '', this.selfReportsRefused);
		return true;
	}

	/**
	 * The one place a record is created, and so the one place the table's cap is enforced. Returns
	 * `undefined` when the table is full of banned records and there is nothing safe to forget — the
	 * caller drops the report.
	 */
	private getOrCreateRecord(peerId: string): PeerRecord | undefined {
		const existing = this.peers.get(peerId);
		if (existing) return existing;
		if (this.peers.size >= this.maxPeers && !this.evictOne()) {
			this.refuseNewRecord(peerId);
			return undefined;
		}
		const record: PeerRecord = {
			penalties: [],
			successCount: 0,
			lastSuccess: 0,
			lastPenalty: 0,
		};
		this.peers.set(peerId, record);
		return record;
	}

	private evictOne(): boolean {
		const victim = this.pickEvictionVictim();
		if (victim === undefined) return false;
		this.peers.delete(victim);
		return true;
	}

	/**
	 * The record that carries the least information: never a banned one (time releases a ban, eviction
	 * must not do it sooner — otherwise spraying fresh names would launder a real offender out of the
	 * table), otherwise the lowest current score, ties to the least recently touched. Map iteration is
	 * insertion order, so a strict comparison also leaves a full tie to the oldest entry.
	 *
	 * NOTE: scans every entry, and every penalty inside it, on each new name once the table is full — and
	 * a stranger picks when that happens, since one inbound message naming an id this node has not seen is
	 * one creation. The work per scan is bounded by `maxPeers` x `maxPenaltiesPerPeer` decay computations
	 * (1024 x 100 at the defaults), and the message that drove it already paid for a signature
	 * verification, so the scan is not self-evidently the cheaper half of that exchange; neither has been
	 * profiled. Revisit if the cap is raised into the tens of thousands, if records routinely carry many
	 * penalties, or if a profile shows this scan — keep a running lowest-score index, or sample a bounded
	 * number of candidates rather than scanning all of them.
	 */
	private pickEvictionVictim(): string | undefined {
		let victim: string | undefined;
		let victimScore = Infinity;
		let victimTouched = Infinity;
		for (const [peerId, record] of this.peers) {
			const score = this.computeScore(record);
			if (score >= this.thresholds.ban) continue;
			const touched = Math.max(record.lastPenalty, record.lastSuccess);
			if (score < victimScore || (score === victimScore && touched < victimTouched)) {
				victim = peerId;
				victimScore = score;
				victimTouched = touched;
			}
		}
		return victim;
	}

	/** Counted and logged like `refuseSelfReport`, never acted on: a full table is not a fault of the peer named. */
	private refuseNewRecord(peerId: string): void {
		this.newRecordsRefused++;
		log('refused new record, table full of banned peers peerId=%s maxPeers=%d refused=%d',
			peerId.substring(0, 12), this.maxPeers, this.newRecordsRefused);
	}

	private computeScore(record: PeerRecord): number {
		const now = Date.now();
		let score = 0;
		for (const penalty of record.penalties) {
			score += penalty.weight * this.decayFactor(now, penalty.timestamp);
		}
		return score;
	}

	private decayFactor(now: number, timestamp: number): number {
		const elapsed = now - timestamp;
		if (elapsed <= 0) return 1;
		return Math.pow(0.5, elapsed / this.halfLifeMs);
	}

	/** Remove penalties that have decayed below significance (< 1% of original weight) */
	private pruneRecord(record: PeerRecord): void {
		const now = Date.now();
		const cutoff = this.halfLifeMs * 7; // 2^-7 ≈ 0.8% — below significance
		record.penalties = record.penalties.filter(p => (now - p.timestamp) < cutoff);

		// Hard cap to prevent unbounded growth
		if (record.penalties.length > this.maxPenaltiesPerPeer) {
			record.penalties = record.penalties.slice(-this.maxPenaltiesPerPeer);
		}

	}
}
