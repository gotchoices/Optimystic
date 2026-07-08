import type { ClusterRecord, ITransactionValidator, InvalidateRequest, CommitRequest, PendRequest, CollectionId } from '@optimystic/db-core';
import { blockIdsForTransforms, computeClusterPromiseHash, recordMembershipDigest } from '@optimystic/db-core';
import { buildDisputeResolutionProof, computeTargetHash, computeArbitratorSetHash, voteSigningPayload, arbitratorSetSigningPayload, VOTE_VERSION, type CertificateTarget } from './invalidation.js';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdBindsPublicKey } from '../cluster/peer-key-binding.js';
import type {
	ValidationEvidence,
	DisputeChallenge,
	ArbitrationVote,
	DisputeResolution,
	DisputeConfig,
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
	/**
	 * Select arbitrators for a dispute via verifiable dispersed sampling (see `sampleArbitrators`): draw
	 * `count` distinct peers from coordinates spread across the whole keyspace, not the block's neighborhood.
	 * `round` (0-based escalation round) and `epoch` (agreed membership epoch bytes) are folded into every
	 * coordinate so the draw is deterministic yet not pre-positionable — an honest node re-derives the
	 * identical set from the same `(blockId, round, epoch)` + agreed membership.
	 */
	selectArbitrators: (blockId: string, excludePeers: string[], count: number, round: number, epoch: Uint8Array) => Promise<PeerId[]>;
	/**
	 * Originates the durable reversal when a dispute resolves `challenger-wins`. The dissent
	 * coordinator (the node that initiated the dispute, holding the original record) builds the
	 * {@link InvalidateRequest} and hands it here to be driven through the critical cluster as a
	 * consensus-ordered invalidation; every member then applies it deterministically. Absent on
	 * nodes not wired to originate invalidations (today's default) — the in-memory status still flips,
	 * but nothing durable is written until this is supplied.
	 */
	onInvalidation?: (request: InvalidateRequest) => Promise<void> | void;
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
	private readonly onInvalidation?: DisputeServiceInit['onInvalidation'];

	/** Active disputes initiated by this node */
	private activeDisputes: Map<string, DisputeChallenge> = new Map();
	/** Resolved disputes (disputeId -> resolution) */
	private resolvedDisputes: Map<string, DisputeResolution> = new Map();
	/** Challenges retained after resolution for status lookups */
	private resolvedChallenges: Map<string, DisputeChallenge> = new Map();
	/** Track which transactions we've already disputed (prevent spam) */
	private disputedTransactions: Set<string> = new Set();
	/** Track which transactions we've already originated an invalidation for (fire once per messageHash) */
	private invalidatedTransactions: Set<string> = new Set();

	constructor(init: DisputeServiceInit) {
		this.peerId = init.peerId;
		this.privateKey = init.privateKey;
		this.createDisputeClient = init.createDisputeClient;
		this.reputation = init.reputation;
		this.revalidate = init.revalidate;
		this.config = { ...DEFAULT_DISPUTE_CONFIG, ...init.config };
		this.engineHealth = new EngineHealthMonitor(this.config);
		this.selectArbitrators = init.selectArbitrators;
		this.onInvalidation = init.onInvalidation;
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

		// Select the arbitrator set FIRST so the challenge can carry it: each arbitrator folds the set's
		// digest into the v3 vote it signs, binding every vote to the legitimately-selected set (#1).
		const blockIds = record.coordinatingBlockIds ?? [];
		const blockId = blockIds[0] ?? record.messageHash;
		const originalPeers = Object.keys(record.peers);
		const arbitratorCount = this.config.arbitratorCount ?? originalPeers.length;

		// Round 0 is the only round today (single-round arbitration); `design-dispute-synchronous-escalation`
		// drives real-time round progression. `epoch` pins the dispersed draw to a membership the attacker
		// cannot freely advance.
		// NOTE: interim agreed-membership epoch — hash of the admission-gate-agreed responsible set
		// (`Object.keys(record.peers)`). When `design-cluster-membership-agreement` lands, `epoch` becomes
		// the agreed membership epoch rather than this locally-hashed stand-in.
		const round = 0;
		const epoch = await this.computeEpochBytes(originalPeers);

		let arbitrators: PeerId[];
		try {
			arbitrators = await this.selectArbitrators(blockId, originalPeers, arbitratorCount, round, epoch);
		} catch (err) {
			log('dispute-arbitrator-selection-failed', { disputeId, error: err instanceof Error ? err.message : String(err) });
			return undefined;
		}

		if (arbitrators.length === 0) {
			log('dispute-no-arbitrators', { disputeId });
			return undefined;
		}

		const arbitratorSet = arbitrators.map(a => a.toString());

		const challenge: DisputeChallenge = {
			disputeId,
			originalMessageHash: record.messageHash,
			originalRecord: record,
			challengerPeerId: this.peerId.toString(),
			challengerEvidence: evidence,
			signature,
			timestamp,
			expiration,
			arbitratorSet,
		};

		this.activeDisputes.set(disputeId, challenge);
		log('dispute-initiated', { disputeId, messageHash: record.messageHash });

		// Send challenge to all arbitrators and collect votes
		const votes = await this.collectVotes(challenge, arbitrators);
		const resolution = await this.resolveDispute(challenge, votes);

		this.resolvedChallenges.set(disputeId, challenge);
		this.activeDisputes.delete(disputeId);
		this.resolvedDisputes.set(disputeId, resolution);

		// Apply reputation effects
		this.applyReputationEffects(resolution, record);

		// On a proven-invalid transaction, originate the durable reversal through the cluster. The
		// challenger-selected `arbitratorSet` is bound into the proof (#1).
		await this.maybeInvalidate(resolution, record, arbitratorSet);

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

		// Bind every vote to the disputed transaction AND the legitimately-selected arbitrator set: derive
		// the reversal target the same way the originator/apply path does (so the verifier recomputes an
		// identical targetHash), digest the set the challenger carried, and sign over both (#1, #2).
		const targetHash = await this.computeChallengeTargetHash(challenge);
		const setHash = await computeArbitratorSetHash(challenge.arbitratorSet ?? []);

		// Verify the challenge signature — bound to the challenger's id so a relay cannot attach a key it
		// controls under some other peer's id and pass a forged challenge as that peer.
		const validSignature = await this.verifyDisputeSignature(
			challenge.disputeId,
			challenge.signature,
			challenge.challengerPeerId,
			challenge.originalRecord.peers[challenge.challengerPeerId]?.publicKey
		);

		if (!validSignature) {
			log('dispute-invalid-challenge-signature', { disputeId: challenge.disputeId });
			return this.makeVote(challenge.disputeId, 'inconclusive', {
				computedHash: '',
				engineId: 'unknown',
				schemaHash: '',
				blockStateHashes: {},
			}, targetHash, setHash);
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
			}, targetHash, setHash);
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

		return this.makeVote(challenge.disputeId, vote, evidence, targetHash, setHash);
	}

	/**
	 * Derives the v2 target hash binding a vote to the disputed transaction: its `messageHash` plus the
	 * reversal target (the committed action being reversed and the blocks it wrote), extracted from the
	 * challenge's `originalRecord` exactly as {@link extractInvalidationTarget} does on the originate/apply
	 * side. A record with no extractable target yields an empty target — the resulting vote still verifies
	 * self-consistently but will not match a real reversal, which is correct (no real reversal exists).
	 */
	private async computeChallengeTargetHash(challenge: DisputeChallenge): Promise<string> {
		const target = DisputeService.extractInvalidationTarget(challenge.originalRecord);
		const certTarget: CertificateTarget = target
			? { invalidatedActionId: target.actionId, blockIds: target.blockIds }
			: { invalidatedActionId: '', blockIds: [] };
		return computeTargetHash(challenge.originalRecord.messageHash, certTarget);
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
	async resolveDispute(challenge: DisputeChallenge, votes: ArbitrationVote[]): Promise<DisputeResolution> {
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
			// Penalize majority peers who approved the transaction. The promise signatures in a challenge's
			// originalRecord are NOT otherwise verified on the dispute path, so an attacker who crafts a
			// challenge carrying a fabricated originalRecord could attach a forged approval under an honest
			// peer's id to get that peer a FalseApproval penalty. Gate each false-approval on the approval
			// being binding-valid (key bound to the id AND signature verifies); skip — never penalize —
			// any approval that is unbound or invalid.
			const originalRecord = challenge.originalRecord;
			const promiseHash = await this.computePromiseHash(originalRecord);
			for (const [peerId, signature] of Object.entries(originalRecord.promises)) {
				if (signature.type === 'approve' && peerId !== challenge.challengerPeerId) {
					if (await this.verifyPromiseSignature(originalRecord, peerId, promiseHash, signature)) {
						affectedPeers.push({ peerId, reason: 'false-approval' });
					} else {
						log('dispute-skip-unverified-approval', { disputeId: challenge.disputeId, peerId });
					}
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
	private applyReputationEffects(resolution: DisputeResolution, _record: ClusterRecord): void {
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

	/**
	 * When a dispute resolves `challenger-wins`, originate the durable invalidation. Builds the
	 * independently-verifiable {@link buildDisputeResolutionProof proof} and the {@link InvalidateRequest}
	 * from the disputed transaction, then hands it to the injected `onInvalidation` originator (which
	 * drives it through the critical cluster). Fires at most once per disputed transaction. A no-op
	 * when no originator is wired (the in-memory status still flips via {@link getDisputeStatus}).
	 */
	private async maybeInvalidate(resolution: DisputeResolution, record: ClusterRecord, arbitratorSet: string[]): Promise<void> {
		if (resolution.outcome !== 'challenger-wins' || !this.onInvalidation) {
			return;
		}
		if (this.invalidatedTransactions.has(record.messageHash)) {
			return;
		}

		const target = DisputeService.extractInvalidationTarget(record);
		if (!target) {
			log('dispute-invalidation-no-target', { disputeId: resolution.disputeId, messageHash: record.messageHash });
			return;
		}

		// Bind the legitimately-selected arbitrator set (#1): the challenger signs (disputeId, target, set)
		// so a third-party relay cannot swap in its own cohort. Same target derivation as the apply path.
		const certTarget: CertificateTarget = { invalidatedActionId: target.actionId, blockIds: target.blockIds };
		const targetHash = await computeTargetHash(record.messageHash, certTarget);
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		const arbitratorSetSignature = await this.signArbitratorSet(resolution.disputeId, targetHash, setHash);

		this.invalidatedTransactions.add(record.messageHash);
		const request: InvalidateRequest = {
			invalidatedActionId: target.actionId,
			invalidatedRev: target.rev,
			blockIds: target.blockIds,
			collectionId: target.collectionId,
			resolution: buildDisputeResolutionProof(resolution, record.messageHash, {
				arbitratorSet,
				challengerPeerId: this.peerId.toString(),
				arbitratorSetSignature,
			}),
		};

		try {
			await this.onInvalidation(request);
			log('dispute-invalidation-originated', {
				disputeId: resolution.disputeId,
				invalidatedActionId: target.actionId,
				blockCount: target.blockIds.length,
			});
		} catch (err) {
			// Roll back the once-guard so a retry can re-originate.
			this.invalidatedTransactions.delete(record.messageHash);
			log('dispute-invalidation-originate-failed', {
				disputeId: resolution.disputeId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Derives the invalidation target — the committed action, its revision, the blocks it wrote, and
	 * its owning collection — from the disputed record. Prefers the commit operation (the disputed
	 * transaction is committed); falls back to the pend operation defensively.
	 */
	private static extractInvalidationTarget(record: ClusterRecord): { actionId: string; rev: number; blockIds: string[]; collectionId: CollectionId } | undefined {
		for (const operation of record.message.operations) {
			if ('commit' in operation) {
				const commit = operation.commit as CommitRequest;
				return {
					actionId: commit.actionId,
					rev: commit.rev,
					blockIds: commit.blockIds,
					collectionId: commit.headerId ?? record.coordinatingBlockIds?.[0] ?? commit.blockIds[0]!,
				};
			}
		}
		for (const operation of record.message.operations) {
			if ('pend' in operation) {
				const pend = operation.pend as PendRequest;
				const blockIds = blockIdsForTransforms(pend.transforms);
				return {
					actionId: pend.actionId,
					rev: pend.rev ?? 0,
					blockIds,
					collectionId: record.coordinatingBlockIds?.[0] ?? blockIds[0]!,
				};
			}
		}
		return undefined;
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
		evidence: ValidationEvidence,
		targetHash: string,
		setHash: string
	): Promise<ArbitrationVote> {
		// Target- and set-bound v3 payload: binds the vote to the specific transaction being reversed (#2)
		// AND the legitimately-selected arbitrator set (#1) so a genuine vote can neither be replayed against
		// an unrelated transaction nor presented under a swapped cohort.
		const payloadBytes = voteSigningPayload(disputeId, vote, evidence.computedHash, targetHash, setHash);
		const sigBytes = await this.privateKey.sign(payloadBytes);

		return {
			version: VOTE_VERSION,
			disputeId,
			arbitratorPeerId: this.peerId.toString(),
			vote,
			evidence,
			signature: uint8ArrayToString(sigBytes, 'base64url'),
		};
	}

	/**
	 * Interim agreed-membership epoch bytes for the dispersed arbitrator draw: SHA-256 of the sorted,
	 * comma-joined responsible peer-id set (the same set the admission gate agrees on). Sorted so the
	 * digest is independent of enumeration order, so every honest node computes the identical epoch — the
	 * property that lets the verify path re-derive the same arbitrator set. Replaced by the real agreed
	 * membership epoch when `design-cluster-membership-agreement` lands.
	 */
	private async computeEpochBytes(peers: string[]): Promise<Uint8Array> {
		const joined = [...peers].sort().join(',');
		const digest = await sha256.digest(new TextEncoder().encode(joined));
		return digest.digest;
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

	/**
	 * Sign the arbitrator-set binding `(disputeId, target, arbitratorSet)` with the challenger's key.
	 * Carried on the proof as {@link DisputeResolutionProof.arbitratorSetSignature}; a verifier validates
	 * it against this peer's embedded key (`challengerPeerId`), so a relay cannot substitute its own cohort.
	 */
	private async signArbitratorSet(disputeId: string, targetHash: string, setHash: string): Promise<string> {
		const sigBytes = await this.privateKey.sign(arbitratorSetSigningPayload(disputeId, targetHash, setHash));
		return uint8ArrayToString(sigBytes, 'base64url');
	}

	private async verifyDisputeSignature(
		disputeId: string,
		signature: string,
		challengerPeerId: string,
		publicKey?: string | Uint8Array
	): Promise<boolean> {
		if (!publicKey?.length) return false;
		try {
			const keyBytes = typeof publicKey === 'string'
				? uint8ArrayFromString(publicKey, 'base64url')
				: publicKey;
			// The key must be the one the challenger's id provably names, else a forged challenge could be
			// attributed to any peer id while signed by a key the relay controls.
			if (!peerIdBindsPublicKey(challengerPeerId, keyBytes)) return false;
			const pubKey = publicKeyFromRaw(keyBytes);
			const payload = new TextEncoder().encode(disputeId);
			const sigBytes = uint8ArrayFromString(signature, 'base64url');
			return pubKey.verify(payload, sigBytes);
		} catch {
			return false;
		}
	}

	/**
	 * Reconstruct the cluster promise-vote hash for `record` — identical to `ClusterMember.computePromiseHash`,
	 * and version-dispatched the same way: a v2 record folds its membership digest into the preimage, a v1 /
	 * unversioned record hashes byte-identically to before. The promise signatures in a disputed record were
	 * produced over this by the cluster path, so re-verifying an approval requires reproducing it here — a v2
	 * originalRecord whose digest we omitted would fail to verify its (honest) approvals.
	 */
	private async computePromiseHash(record: ClusterRecord): Promise<string> {
		return computeClusterPromiseHash(record.messageHash, record.message, recordMembershipDigest(record));
	}

	/**
	 * True iff `signature` on `record` is a binding-valid promise vote from `peerId`: the record's key for
	 * `peerId` must be the one that id provably names AND the signature must verify over the reconstructed
	 * promise-vote preimage. Total: returns `false` (never throws) on a missing/unbound/malformed key or an
	 * undecodable signature. Mirrors `ClusterMember.verifySignature`'s binding-then-verify order.
	 */
	private async verifyPromiseSignature(
		record: ClusterRecord,
		peerId: string,
		promiseHash: string,
		signature: { type: string; signature: string; rejectReason?: string }
	): Promise<boolean> {
		const publicKey = record.peers[peerId]?.publicKey;
		if (!publicKey?.length) return false;
		try {
			const keyBytes = typeof publicKey === 'string'
				? uint8ArrayFromString(publicKey, 'base64url')
				: publicKey;
			if (!peerIdBindsPublicKey(peerId, keyBytes)) return false;
			const pubKey = publicKeyFromRaw(keyBytes);
			const payloadStr = promiseHash + ':' + signature.type + (signature.rejectReason ? ':' + signature.rejectReason : '');
			const payload = new TextEncoder().encode(payloadStr);
			const sigBytes = uint8ArrayFromString(signature.signature, 'base64url');
			return pubKey.verify(payload, sigBytes);
		} catch {
			return false;
		}
	}

	private findChallengeForDispute(disputeId: string): DisputeChallenge | undefined {
		return this.activeDisputes.get(disputeId) ?? this.resolvedChallenges.get(disputeId);
	}
}
