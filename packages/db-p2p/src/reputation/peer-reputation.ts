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
	// NOTE: unbounded, and keyed by strings that arrive off the wire — `ClusterMember.validateSignatures`
	// reports against the peer ids of an inbound consensus record, on a protocol whose per-stream
	// authorization is opt-in. `pruneRecord` trims the penalties inside a record but never removes the
	// record, and `resetPeer` has no caller, so the map only grows for the life of the process. Bounding it
	// is `debt-the-reputation-table-has-no-entry-cap`; do not add a second uncapped attacker-keyed map here
	// in the meantime (`peer-address-book.ts` caps its own ingress for the same reason).
	private readonly peers = new Map<string, PeerRecord>();
	private readonly halfLifeMs: number;
	private readonly thresholds: ReputationThresholds;
	private readonly weights: Record<PenaltyReason, number>;
	private readonly maxPenaltiesPerPeer: number;
	private readonly selfPeerId: string | undefined;
	private selfReportsRefused = 0;

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
		this.selfPeerId = config?.selfPeerId;
	}

	reportPeer(peerId: string, reason: PenaltyReason, context?: string): void {
		if (this.refuseSelfReport(peerId, reason, context)) return;
		const record = this.getOrCreateRecord(peerId);
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

	private getOrCreateRecord(peerId: string): PeerRecord {
		let record = this.peers.get(peerId);
		if (!record) {
			record = {
				penalties: [],
				successCount: 0,
				lastSuccess: 0,
				lastPenalty: 0,
			};
			this.peers.set(peerId, record);
		}
		return record;
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
