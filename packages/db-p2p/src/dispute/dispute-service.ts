import type { ClusterRecord, ITransactionValidator } from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import type {
	ValidationEvidence,
	DisputeChallenge,
	ArbitrationVote,
	DisputeResolution,
	DisputeConfig,
	DisputeMessage,
	DisputeStatus,
} from './types.js';
import { DEFAULT_DISPUTE_CONFIG } from './types.js';
import { EngineHealthMonitor } from './engine-health-monitor.js';
import type { IPeerReputation } from '../reputation/types.js';
import { PenaltyReason } from '../reputation/types.js';
import { createLogger } from '../logger.js';
import type { IPeerNetwork } from '@optimystic/db-core';
import type { DisputeClient } from './client.js';

const log = createLogger('dispute');

/** Callback to create a DisputeClient for a given peer */
export type CreateDisputeClient = (peerId: PeerId) => DisputeClient;

/** Callback to re-execute a transaction and produce validation evidence */
export type RevalidateTransaction = (record: ClusterRecord) => Promise<ValidationEvidence | undefined>;

export interface DisputeServiceInit {
	peerId: PeerId;
	privateKey: PrivateKey;
	peerNetwork: IPeerNetwork;
	createDisputeClient: CreateDisputeClient;
	reputation?: IPeerReputation;
	validator?: ITransactionValidator;
	revalidate?: RevalidateTransaction;
	config?: Partial<DisputeConfig>;
	/** Select arbitrators for a dispute (next K peers beyond the original cluster) */
	selectArbitrators: (blockId: string, excludePeers: string[], count: number) => Promise<PeerId[]>;
}

/**
 * Manages the dispute escalation protocol.
 *
 * When a transaction proceeds despite minority rejections, the overridden
 * minority can escalate to independent arbitrators. The service coordinates
 * challenge initiation, arbitration vote collection, and resolution.
 */
export class DisputeService {
	private readonly peerId: PeerId;
	private readonly privateKey: PrivateKey;
	private readonly createDisputeClient: CreateDisputeClient;
	private readonly reputation?: IPeerReputation;
	private readonly revalidate?: RevalidateTransaction;
	private readonly config: DisputeConfig;
	private readonly engineHealth: EngineHealthMonitor;
	private readonly selectArbitrators: DisputeServiceInit['selectArbitrators'];

	/** Active disputes initiated by this node */
	private activeDisputes: Map<string, DisputeChallenge> = new Map();
	/** Resolved disputes (disputeId -> resolution) */
	private resolvedDisputes: Map<string, DisputeResolution> = new Map();
	/** Challenges retained after resolution for status lookups */
	private resolvedChallenges: Map<string, DisputeChallenge> = new Map();
	/** Track which transactions we've already disputed (prevent spam) */
	private disputedTransactions: Set<string> = new Set();

	constructor(init: DisputeServiceInit) {
		this.peerId = init.peerId;
		this.privateKey = init.privateKey;
		this.createDisputeClient = init.createDisputeClient;
		this.reputation = init.reputation;
		this.revalidate = init.revalidate;
		this.config = { ...DEFAULT_DISPUTE_CONFIG, ...init.config };
		this.engineHealth = new EngineHealthMonitor(this.config);
		this.selectArbitrators = init.selectArbitrators;
	}

	/** Get the engine health monitor */
	getEngineHealth(): EngineHealthMonitor {
		return this.engineHealth;
	}

	/** Check if disputes are enabled */
	isEnabled(): boolean {
		return this.config.disputeEnabled;
	}

	/** Get the dispute status for a transaction, if any */
	getDisputeStatus(messageHash: string): DisputeStatus | undefined {
		// Check if there's an active dispute for this transaction
		for (const [, challenge] of this.activeDisputes) {
			if (challenge.originalMessageHash === messageHash) {
				return 'committed-disputed';
			}
		}
		// Check resolved disputes
		for (const [, resolution] of this.resolvedDisputes) {
			const challenge = this.findChallengeForDispute(resolution.disputeId);
			if (challenge && challenge.originalMessageHash === messageHash) {
				if (resolution.outcome === 'challenger-wins') return 'committed-invalidated';
				if (resolution.outcome === 'majority-wins') return 'committed-validated';
				return 'committed-disputed'; // inconclusive
			}
		}
		return undefined;
	}

	/**
	 * Initiate a dispute when this node's rejection was overridden.
	 * Called by ClusterMember when it detects a disputed commit.
	 */
	async initiateDispute(record: ClusterRecord, evidence: ValidationEvidence): Promise<DisputeResolution | undefined> {
		if (!this.config.disputeEnabled) {
			log('dispute-disabled', { messageHash: record.messageHash });
			return undefined;
		}

		// One dispute per transaction
		if (this.disputedTransactions.has(record.messageHash)) {
			log('dispute-already-initiated', { messageHash: record.messageHash });
			return undefined;
		}

		// Don't dispute if our engine is unhealthy
		if (this.engineHealth.isUnhealthy()) {
			log('dispute-skipped-unhealthy', { messageHash: record.messageHash });
			return undefined;
		}

		this.disputedTransactions.add(record.messageHash);

		const timestamp = Date.now();
		const disputeId = await this.computeDisputeId(record.messageHash, this.peerId.toString(), timestamp);
		const signature = await this.signDispute(disputeId);

		const defaultTtl = record.message.expiration
			? (record.message.expiration - Date.now()) * 2
			: this.config.disputeArbitrationTimeoutMs * 2;
		const expiration = timestamp + Math.max(defaultTtl, this.config.disputeArbitrationTimeoutMs);

		const challenge: DisputeChallenge = {
			disputeId,
			originalMessageHash: record.messageHash,
			originalRecord: record,
			challengerPeerId: this.peerId.toString(),
			challengerEvidence: evidence,
			signature,
			timestamp,
			expiration,
		};

		this.activeDisputes.set(disputeId, challenge);
		log('dispute-initiated', { disputeId, messageHash: record.messageHash });

		// Select arbitrators and collect votes
		const blockIds = record.coordinatingBlockIds ?? [];
		const blockId = blockIds[0] ?? record.messageHash;
		const originalPeers = Object.keys(record.peers);
		const arbitratorCount = this.config.arbitratorCount ?? originalPeers.length;

		let arbitrators: PeerId[];
		try {
			arbitrators = await this.selectArbitrators(blockId, originalPeers, arbitratorCount);
		} catch (err) {
			log('dispute-arbitrator-selection-failed', { disputeId, error: err instanceof Error ? err.message : String(err) });
			this.activeDisputes.delete(disputeId);
			return undefined;
		}

		if (arbitrators.length === 0) {
			log('dispute-no-arbitrators', { disputeId });
			this.activeDisputes.delete(disputeId);
			return undefined;
		}

		// Send challenge to all arbitrators and collect votes
		const votes = await this.collectVotes(challenge, arbitrators);
		const resolution = this.resolveDispute(challenge, votes);

		this.resolvedChallenges.set(disputeId, challenge);
		this.activeDisputes.delete(disputeId);
		this.resolvedDisputes.set(disputeId, resolution);

		// Apply reputation effects
		this.applyReputationEffects(resolution, record);

		// Broadcast resolution
		await this.broadcastResolution(resolution, arbitrators, originalPeers);

		log('dispute-resolved', {
			disputeId,
			outcome: resolution.outcome,
			votes: votes.length,
			affectedPeers: resolution.affectedPeers.length,
		});

		return resolution;
	}

	/**
	 * Handle an incoming dispute challenge (when this node is selected as arbitrator).
	 * Re-executes the transaction and returns a vote.
	 */
	async handleChallenge(challenge: DisputeChallenge): Promise<ArbitrationVote> {
		log('dispute-handle-challenge', { disputeId: challenge.disputeId });

		// Verify the challenge signature
		const validSignature = await this.verifyDisputeSignature(
			challenge.disputeId,
			challenge.signature,
			challenge.originalRecord.peers[challenge.challengerPeerId]?.publicKey
		);

		if (!validSignature) {
			log('dispute-invalid-challenge-signature', { disputeId: challenge.disputeId });
			return this.makeVote(challenge.disputeId, 'inconclusive', {
				computedHash: '',
				engineId: 'unknown',
				schemaHash: '',
				blockStateHashes: {},
			});
		}

		// Re-execute the transaction to produce our own evidence
		let evidence: ValidationEvidence | undefined;
		if (this.revalidate) {
			try {
				evidence = await this.revalidate(challenge.originalRecord);
			} catch (err) {
				log('dispute-revalidation-failed', {
					disputeId: challenge.disputeId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		if (!evidence) {
			// Can't re-execute — vote inconclusive
			return this.makeVote(challenge.disputeId, 'inconclusive', {
				computedHash: '',
				engineId: 'unknown',
				schemaHash: '',
				blockStateHashes: {},
			});
		}

		// Compare our evidence with the challenger's
		let vote: ArbitrationVote['vote'];
		if (evidence.computedHash === challenge.challengerEvidence.computedHash) {
			// Our re-execution matches the challenger — the challenger is right
			vote = 'agree-with-challenger';
		} else {
			// Our re-execution differs from the challenger — the majority is likely right
			vote = 'agree-with-majority';
		}

		return this.makeVote(challenge.disputeId, vote, evidence);
	}

	/**
	 * Handle an incoming dispute resolution (broadcast from the dispute initiator).
	 */
	handleResolution(resolution: DisputeResolution): void {
		this.resolvedDisputes.set(resolution.disputeId, resolution);
		log('dispute-resolution-received', {
			disputeId: resolution.disputeId,
			outcome: resolution.outcome,
		});

		// If we were penalized and the challenger won, check engine health
		const ourId = this.peerId.toString();
		const ourPenalty = resolution.affectedPeers.find(p => p.peerId === ourId);
		if (ourPenalty && ourPenalty.reason === 'false-approval') {
			this.engineHealth.recordDisputeLoss();
		}
	}

	/** Collect votes from arbitrators with a timeout */
	private async collectVotes(challenge: DisputeChallenge, arbitrators: PeerId[]): Promise<ArbitrationVote[]> {
		const timeoutMs = this.config.disputeArbitrationTimeoutMs;
		const votes: ArbitrationVote[] = [];

		const votePromises = arbitrators.map(async (arbitratorPeerId) => {
			try {
				const client = this.createDisputeClient(arbitratorPeerId);
				const vote = await client.sendChallenge(challenge, timeoutMs);
				return vote;
			} catch (err) {
				log('dispute-vote-collection-failed', {
					disputeId: challenge.disputeId,
					arbitrator: arbitratorPeerId.toString(),
					error: err instanceof Error ? err.message : String(err),
				});
				return undefined;
			}
		});

		const results = await Promise.allSettled(votePromises);
		for (const result of results) {
			if (result.status === 'fulfilled' && result.value) {
				votes.push(result.value);
			}
		}

		return votes;
	}

	/** Determine dispute resolution from collected votes */
	resolveDispute(challenge: DisputeChallenge, votes: ArbitrationVote[]): DisputeResolution {
		const challengerVotes = votes.filter(v => v.vote === 'agree-with-challenger').length;
		const majorityVotes = votes.filter(v => v.vote === 'agree-with-majority').length;
		const totalDecisive = challengerVotes + majorityVotes;

		// Need super-majority of decisive votes (>2/3)
		const superMajorityThreshold = Math.ceil(totalDecisive * 2 / 3);

		let outcome: DisputeResolution['outcome'];
		const affectedPeers: DisputeResolution['affectedPeers'] = [];

		if (totalDecisive === 0) {
			outcome = 'inconclusive';
		} else if (challengerVotes >= superMajorityThreshold) {
			outcome = 'challenger-wins';
			// Penalize majority peers who approved the transaction
			const originalRecord = challenge.originalRecord;
			for (const [peerId, signature] of Object.entries(originalRecord.promises)) {
				if (signature.type === 'approve' && peerId !== challenge.challengerPeerId) {
					affectedPeers.push({ peerId, reason: 'false-approval' });
				}
			}
		} else if (majorityVotes >= superMajorityThreshold) {
			outcome = 'majority-wins';
			// Penalize the challenger
			affectedPeers.push({ peerId: challenge.challengerPeerId, reason: 'dispute-lost' });
		} else {
			outcome = 'inconclusive';
		}

		return {
			disputeId: challenge.disputeId,
			outcome,
			votes,
			affectedPeers,
			timestamp: Date.now(),
		};
	}

	/** Apply reputation effects based on dispute resolution */
	private applyReputationEffects(resolution: DisputeResolution, record: ClusterRecord): void {
		if (!this.reputation) return;

		for (const affected of resolution.affectedPeers) {
			if (affected.reason === 'false-approval') {
				// Weight: 40 as specified in ticket
				this.reputation.reportPeer(affected.peerId, PenaltyReason.FalseApproval,
					`dispute:false-approval:${resolution.disputeId}`);
			} else if (affected.reason === 'dispute-lost') {
				// Weight: 30 as specified in ticket
				this.reputation.reportPeer(affected.peerId, PenaltyReason.DisputeLost,
					`dispute:dispute-lost:${resolution.disputeId}`);
			}
		}

		// If challenger wins, track engine health for majority peers
		if (resolution.outcome === 'challenger-wins') {
			const ourId = this.peerId.toString();
			if (resolution.affectedPeers.some(p => p.peerId === ourId)) {
				this.engineHealth.recordDisputeLoss();
			}
		}
	}

	/** Broadcast resolution to all interested parties */
	private async broadcastResolution(
		resolution: DisputeResolution,
		arbitrators: PeerId[],
		originalPeers: string[]
	): Promise<void> {
		const allTargets = new Set<string>();
		for (const arb of arbitrators) allTargets.add(arb.toString());
		for (const peer of originalPeers) allTargets.add(peer);
		// Don't send to self
		allTargets.delete(this.peerId.toString());

		const promises = Array.from(allTargets).map(async (peerIdStr) => {
			try {
				const { peerIdFromString } = await import('@libp2p/peer-id');
				const client = this.createDisputeClient(peerIdFromString(peerIdStr));
				await client.sendResolution(resolution);
			} catch (err) {
				log('dispute-broadcast-failed', {
					disputeId: resolution.disputeId,
					peer: peerIdStr,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		});

		await Promise.allSettled(promises);
	}

	private async makeVote(
		disputeId: string,
		vote: ArbitrationVote['vote'],
		evidence: ValidationEvidence
	): Promise<ArbitrationVote> {
		const payload = `${disputeId}:${vote}:${evidence.computedHash}`;
		const payloadBytes = new TextEncoder().encode(payload);
		const sigBytes = await this.privateKey.sign(payloadBytes);

		return {
			disputeId,
			arbitratorPeerId: this.peerId.toString(),
			vote,
			evidence,
			signature: uint8ArrayToString(sigBytes, 'base64url'),
		};
	}

	private async computeDisputeId(messageHash: string, peerId: string, timestamp: number): Promise<string> {
		const input = `${messageHash}+${peerId}+${timestamp}`;
		const inputBytes = new TextEncoder().encode(input);
		const hashBytes = await sha256.digest(inputBytes);
		return base58btc.encode(hashBytes.digest);
	}

	private async signDispute(disputeId: string): Promise<string> {
		const payload = new TextEncoder().encode(disputeId);
		const sigBytes = await this.privateKey.sign(payload);
		return uint8ArrayToString(sigBytes, 'base64url');
	}

	private async verifyDisputeSignature(
		disputeId: string,
		signature: string,
		publicKey?: string | Uint8Array
	): Promise<boolean> {
		if (!publicKey?.length) return false;
		try {
			const keyBytes = typeof publicKey === 'string'
				? uint8ArrayFromString(publicKey, 'base64url')
				: publicKey;
			const pubKey = publicKeyFromRaw(keyBytes);
			const payload = new TextEncoder().encode(disputeId);
			const sigBytes = uint8ArrayFromString(signature, 'base64url');
			return pubKey.verify(payload, sigBytes);
		} catch {
			return false;
		}
	}

	private findChallengeForDispute(disputeId: string): DisputeChallenge | undefined {
		return this.activeDisputes.get(disputeId) ?? this.resolvedChallenges.get(disputeId);
	}
}
