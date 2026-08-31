import { peerIdFromString } from "@libp2p/peer-id";
import type { ClusterRecord, IKeyNetwork, RepoMessage, BlockId, ClusterPeers, MessageOptions, ClusterConsensusConfig, ICluster, PendResult } from "@optimystic/db-core";
import { CURRENT_MEMBERSHIP_VERSION, computeClusterMessageHash, membershipDigest } from "@optimystic/db-core";
import { Pending } from "@optimystic/db-core";
import type { PeerId } from "@libp2p/interface";
import { createLogger, verbose } from '../logger.js'
import type { ClusterLogPeerOutcome } from './types.js'
import type { FretService } from "p2p-fret";
import type { IPeerReputation } from "../reputation/types.js";
import { PenaltyReason } from "../reputation/types.js";
import type { ITransactionStateStore } from "../cluster/i-transaction-state-store.js";

const log = createLogger('cluster')

/**
 * Consensus refused a transaction: enough members voted reject that super-majority became
 * impossible. A typed error (rather than a bare `Error`) so the repo layer above can distinguish
 * "the cluster voted this down" from transport/availability failures WITHOUT string-matching the
 * rejection reasons — those are free-form text that is part of each member's signed vote payload
 * (see cluster-repo's `computeSigningPayload`), so their wording must never become control flow.
 * `CoordinatorRepo.pend` uses this to decide whether a rejection is a retryable stale-revision
 * loss (confirmed against local storage) or a genuine validation fault.
 */
export class ValidatorRejectionError extends Error {
	constructor(
		message: string,
		/** Per-peer reject reasons, verbatim from the vote signatures (free-form, wire-visible). */
		readonly rejectReasons: Record<string, string>
	) {
		super(message);
		this.name = 'ValidatorRejectionError';
	}
}

/**
 * The transaction lost a conflict race: one or more members answered with a signed `conflict`
 * vote (they hold a rival transaction that won the deterministic race on the same blocks) and
 * approvals fell short of super-majority. Distinct from {@link ValidatorRejectionError} — nobody
 * judged this write invalid; it lost an optimistic-concurrency race and a fresh retry can win.
 * `CoordinatorRepo.pend` converts this into a `StaleFailure` with `conflict: true` so the normal
 * retry machinery (`isConflictFailure`) absorbs it; it should escape as a thrown error only from
 * paths other than pend. The conflicting peers and the winning hashes ride as structured data
 * (from the signed `conflictWith` fields), never parsed out of prose.
 */
export class ConflictRaceLostError extends Error {
	constructor(
		message: string,
		/** peerId → messageHash of the rival transaction that member holds as the race winner. */
		readonly conflicts: Record<string, string>
	) {
		super(message);
		this.name = 'ConflictRaceLostError';
	}
}

/** Cancel handle for an injected timer; cancels a not-yet-fired timer (safe no-op after fire/cancel). */
export type TimerCancel = () => void;

/**
 * Production timer binding: a one-shot `setTimeout` whose handle is **unref'd** so a pending
 * commit-retry (or the deferred transaction cleanup) never keeps an otherwise-idle process alive.
 * The returned handle clears the timeout (idempotent). Mirrors the reactivity rotation
 * re-registration scheduler's `defaultSetTimer` (see reactivity/rotation-rereg-scheduler.ts).
 */
function defaultSetTimer(fn: () => void, delayMs: number): TimerCancel {
	const handle = setTimeout(fn, delayMs);
	// An idle retry/cleanup timer must not pin a process (mirror rotation re-registration + push-state gossip).
	(handle as { unref?: () => void }).unref?.();
	return (): void => clearTimeout(handle);
}

/**
 * Optional injection seam for deterministic time. Production leaves both undefined and gets
 * `Date.now` + an unref'd `setTimeout`; tests inject a fake clock + timer queue so scheduled
 * commit-retries fire in virtual (not wall-clock) time.
 */
export interface ClusterCoordinatorClock {
	/** Clock (Unix ms). Defaults to `Date.now`. */
	now?: () => number;
	/** Schedule a one-shot timer, returning a cancel handle. Defaults to an unref'd `setTimeout`. */
	setTimer?: (fn: () => void, delayMs: number) => TimerCancel;
}

/**
 * Manages the state of cluster transactions for a specific block ID
 */
interface CommitRetryState {
	pendingPeers: Set<string>;
	attempt: number;
	intervalMs: number;
	cancel?: TimerCancel;
}

interface ClusterTransactionState {
	messageHash: string;
	record: ClusterRecord;
	pending: Pending<ClusterRecord>;
	lastUpdate: number;
	promiseTimeout?: NodeJS.Timeout;
	resolutionTimeout?: NodeJS.Timeout;
	retry?: CommitRetryState;
}

/** Manages distributed transactions across clusters */
export class ClusterCoordinator {
	private transactions: Map<string, ClusterTransactionState> = new Map();
	private readonly retryInitialIntervalMs: number;
	private readonly retryBackoffFactor: number;
	private readonly retryMaxIntervalMs: number;
	private readonly retryMaxAttempts: number;
	private readonly commitBroadcastImmediateRetries: number;
	private readonly promiseImmediateRetries: number;
	/** Injected clock/timer seam; production defaults to `Date.now` + unref'd `setTimeout`. */
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, delayMs: number) => TimerCancel;

	constructor(
		private readonly keyNetwork: IKeyNetwork,
		/** Factory for a per-peer cluster RPC handle; only `update` is ever called, hence `ICluster`. */
		private readonly createClusterClient: (peerId: PeerId) => ICluster,
		private readonly cfg: ClusterConsensusConfig & { clusterSize: number },
		private readonly localCluster?: {
			update: (record: ClusterRecord) => Promise<ClusterRecord>;
			peerId: PeerId;
			wasTransactionExecuted?: (messageHash: string) => boolean;
			/** Local storage's verdict for a pend applied during consensus; see ClusterMember.getExecutedPendResult. */
			getExecutedPendResult?: (messageHash: string) => PendResult | undefined;
		},
		private readonly fretService?: FretService,
		private readonly reputation?: IPeerReputation,
		private readonly stateStore?: ITransactionStateStore,
		clock?: ClusterCoordinatorClock
	) {
		this.retryInitialIntervalMs = cfg.commitBroadcastRetryInitialMs ?? 250;
		this.retryBackoffFactor = cfg.commitBroadcastRetryBackoffFactor ?? 2;
		this.retryMaxIntervalMs = cfg.commitBroadcastRetryMaxIntervalMs ?? 8000;
		this.retryMaxAttempts = cfg.commitBroadcastRetryMaxAttempts ?? 5;
		this.commitBroadcastImmediateRetries = cfg.commitBroadcastImmediateRetries ?? 1;
		this.promiseImmediateRetries = cfg.promiseImmediateRetries ?? 1;
		this.now = clock?.now ?? ((): number => Date.now());
		this.setTimer = clock?.setTimer ?? defaultSetTimer;
	}

	/**
	 * Invoke one cluster member's `update`, retrying transient REMOTE failures up to
	 * `immediateRetries` times before surfacing the error. The local cluster is invoked
	 * exactly once — a local throw is a real fault (validation / merge / consensus), not a
	 * transient transport blip. A remote call rides a libp2p stream that a circuit-relay
	 * ("limited") connection can reset once a per-circuit cap or reservation lapses, which
	 * surfaces as a StreamResetError; an immediate retry on the (usually still-warm)
	 * connection recovers most of those without escalating the peer to a failure. Shared by
	 * the promise-collection, commit-collection, and commit-broadcast phases so all three
	 * react to a relayed reset the same way.
	 */
	private async updateMember(peerIdStr: string, record: ClusterRecord, immediateRetries: number, phase: string): Promise<ClusterRecord> {
		const isLocal = this.localCluster && peerIdStr === this.localCluster.peerId.toString();
		if (isLocal) {
			return await this.localCluster!.update(record);
		}
		const maxAttempts = 1 + Math.max(0, immediateRetries);
		let lastError: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return await this.createClusterClient(peerIdFromString(peerIdStr)).update(record);
			} catch (err) {
				lastError = err;
				if (attempt < maxAttempts) {
					log('cluster-tx:member-update-retry', {
						messageHash: record.messageHash,
						peerId: peerIdStr,
						phase,
						attempt,
						error: err instanceof Error ? err.message : String(err)
					});
				}
			}
		}
		throw lastError;
	}

	/**
	 * Creates a base58btc string hash uniquely identifying a transaction. For a v2 record the caller
	 * threads in the {@link membershipDigest} of the peer set so the responsible membership is bound into
	 * the identity (two different peer sets ⇒ two different hashes). Omitting `membershipDigestValue`
	 * reproduces the legacy v1 hash byte-for-byte.
	 *
	 * NOTE: the whole `message` is hashed (canonicalJson), so a transaction's advisory aged priority —
	 * which rides inside the pend operation as `pend.transaction.priority` (multi-collection) or
	 * `pend.priority` (single-collection) — is automatically covered here and by the derived
	 * promise/commit hashes. That is what makes priority integrity-protected in transit: a relaying peer
	 * cannot strip or inflate it without invalidating the message hash the members verify. No separate
	 * priority-hashing step is needed.
	 */
	private async createMessageHash(message: RepoMessage, membershipDigestValue?: string): Promise<string> {
		return computeClusterMessageHash(message, membershipDigestValue);
	}

	/**
	 * Gets all peers in the cluster for a specific block ID
	 */
	private async getClusterForBlock(blockId: BlockId): Promise<ClusterPeers> {
		const blockIdBytes = new TextEncoder().encode(blockId);
		try {
			const peers = await this.keyNetwork.findCluster(blockIdBytes);
			const peerIds = Object.keys(peers ?? {});
			log('cluster-tx:cluster-members', { blockId, peerIds });
			return peers;
		} catch (e) {
			log('WARN findCluster failed for %s: %o', blockId, e)
			return {} as ClusterPeers
		}
	}

	private makeRecord(peers: ClusterPeers, messageHash: string, message: RepoMessage, membershipDigestValue: string): ClusterRecord {
		const peerCount = Object.keys(peers ?? {}).length;
		const record: ClusterRecord = {
			messageHash,
			peers,
			// v2: bind the responsible membership into the signed identity. messageHash was computed over
			// this same digest, so a different peer set would have produced a different messageHash.
			membershipVersion: CURRENT_MEMBERSHIP_VERSION,
			membershipDigest: membershipDigestValue,
			message,
			promises: {},
			commits: {},
			suggestedClusterSize: peerCount || undefined,
			minRequiredSize: this.cfg.allowClusterDownsize ? undefined : this.cfg.clusterSize
		};

		// Add network size hint if available
		if (this.fretService) {
			try {
				const estimate = this.fretService.getNetworkSizeEstimate();
				if (estimate.size_estimate > 0) {
					record.networkSizeHint = estimate.size_estimate;
					record.networkSizeConfidence = estimate.confidence;
				}
			} catch (err) {
				// Ignore errors getting size estimate
			}
		}

		return record;
	}

	/**
	 * Initiates a 2-phase transaction for a specific block ID.
	 * Returns the cluster record and whether the local cluster already executed the operations.
	 */
	async executeClusterTransaction(blockId: BlockId, message: RepoMessage, _options?: MessageOptions): Promise<{
		record: ClusterRecord;
		localExecuted: boolean;
		/**
		 * Local storage's verdict for a pend operation this node's own cluster member applied during
		 * consensus, when the member retained one. Meaningful only when `localExecuted` is true;
		 * absent for non-pend messages, for a member that predates the retention, or after the
		 * retention TTL. `CoordinatorRepo.pend` returns this instead of fabricating a success.
		 */
		localPendResult?: PendResult;
	}> {
		// The coordinating block id is derived HERE, from the key this method is already handed, rather
		// than being set by each caller's message builder: a member's membership admission gate derives
		// its own cohort view from this field, and a builder that forgets it silently downgrades the gate
		// to its fallback floor on that path (which is how `commit` and `cancel` used to strand writes —
		// admitted at pend, refused at commit). Doing it at the single choke point means a future message
		// builder cannot reintroduce the gap.
		//
		// Two constraints this shape exists to satisfy:
		//  - COPY, never mutate: `CoordinatorRepo.cancel` builds ONE message and hands the same object to
		//    N concurrent calls, one per block. In-place mutation would leak one block's id into another
		//    block's transaction.
		//  - Preserve an already-present list: `pend` deliberately declares the whole consolidated batch,
		//    not just its first block, so this must not overwrite it. Tested on `length`, not on the
		//    field: an empty list carries no id for a member to derive from, so preserving one would be
		//    the same silent downgrade to the fallback floor this choke point exists to prevent.
		const coordinated: RepoMessage = message.coordinatingBlockIds?.length
			? message
			: { ...message, coordinatingBlockIds: [blockId] };

		// Get the cluster peers for this block
		const peers = await this.getClusterForBlock(blockId);

		// Bind the responsible membership into the transaction identity (v2): the digest is folded into
		// the messageHash below, so two different peer sets produce two different messageHashes rather
		// than one hash with a silent internal disagreement about who is responsible.
		const membershipDigestValue = await membershipDigest(peers);

		// Create a unique hash for this transaction (over message + membership digest). Hashing the
		// coordinating-block-bearing copy is what makes the field tamper-evident in transit — and it also
		// makes a multi-block `cancel` produce a distinct hash per block, where before two blocks with
		// identical cohorts collided on one `messageHash` in `this.transactions` / `wasTransactionExecuted`.
		const messageHash = await this.createMessageHash(coordinated, membershipDigestValue);

		// Create a cluster record for this transaction
		const record = this.makeRecord(peers, messageHash, coordinated, membershipDigestValue);
		log('cluster-tx:start', {
			messageHash,
			blockId,
			peerCount: Object.keys(peers ?? {}).length,
			allowDownsize: this.cfg.allowClusterDownsize,
			configuredSize: this.cfg.clusterSize,
			suggestedSize: record.suggestedClusterSize,
			minRequiredSize: record.minRequiredSize
		});

		// Create a new pending transaction
		const transactionPromise = this.executeTransaction(peers, record);
		const pending = new Pending(transactionPromise);

		// Store the transaction state
		const state: ClusterTransactionState = {
			messageHash,
			record,
			pending,
			lastUpdate: this.now()
		};
		this.transactions.set(messageHash, state);
		this.persistCoordinatorState(messageHash, record, 'promising');
		log('cluster-tx:transaction-store', {
			messageHash,
			transactionKeys: Array.from(this.transactions.keys())
		});

		// Wait for the transaction to complete
		try {
			const result = await pending.result();
			// Check if the local cluster already executed the operations during consensus
			const localExecuted = this.localCluster?.wasTransactionExecuted?.(messageHash) ?? false;
			const localPendResult = localExecuted ? this.localCluster?.getExecutedPendResult?.(messageHash) : undefined;
			return { record: result, localExecuted, ...(localPendResult === undefined ? {} : { localPendResult }) };
		} finally {
			const stored = this.transactions.get(messageHash);
			const retrySnapshot = stored?.retry ? {
				attempt: stored.retry.attempt,
				pending: Array.from(stored.retry.pendingPeers ?? [])
			} : undefined;
			log('cluster-tx:complete', {
				messageHash,
				finalPromises: stored ? Object.keys(stored.record.promises ?? {}) : undefined,
				finalCommits: stored ? Object.keys(stored.record.commits ?? {}) : undefined,
				retry: retrySnapshot
			});
			// Don't remove transaction immediately if retries are scheduled
			// Let the retry completion or abort handle cleanup
			if (!stored?.retry) {
				// Wait a bit before cleanup to allow any in-flight responses to arrive
				this.setTimer(() => {
					this.transactions.delete(messageHash);
					this.deleteCoordinatorState(messageHash);
					log('cluster-tx:transaction-remove', {
						messageHash,
						remaining: Array.from(this.transactions.keys())
					});
				}, 100);
			}
		}
	}

	/**
	 * Executes the full transaction process
	 */
	private async executeTransaction(peers: ClusterPeers, record: ClusterRecord): Promise<ClusterRecord> {
		const peerCount = Object.keys(peers).length;

		// Validate against minimum cluster size
		if (peerCount < this.cfg.minAbsoluteClusterSize) {
			const validated = await this.validateSmallCluster(peerCount, peers);
			if (!validated) {
				log('cluster-tx:reject-too-small', {
					peerCount,
					minRequired: this.cfg.minAbsoluteClusterSize
				});
				throw new Error(`Cluster size ${peerCount} below minimum ${this.cfg.minAbsoluteClusterSize} and not validated`);
			}
			log('cluster-tx:small-cluster-validated', { peerCount });
		}

		// Check configured cluster size
		if (!this.cfg.allowClusterDownsize && peerCount < this.cfg.clusterSize) {
			log('cluster-tx:reject-downsize', { peerCount, required: this.cfg.clusterSize });
			throw new Error(`Cluster size ${peerCount} below configured minimum ${this.cfg.clusterSize}`);
		}

		// Collect promises with super-majority requirement
		const promised = await this.collectPromises(peers, record);
		const superMajority = Math.ceil(peerCount * this.cfg.superMajorityThreshold);

		// Count approvals, rejections and conflict votes separately. A `conflict` vote is a member
		// saying "not now — I hold the race winner": it must count toward NEITHER approvals NOR
		// rejections, or a lost race would masquerade as a validator rejection (permanent) or as
		// silence (indistinguishable from an unreachable cohort) — both wrong.
		const promises = promised.record.promises;
		const approvalCount = Object.values(promises).filter(sig => sig.type === 'approve').length;
		const rejectionCount = Object.values(promises).filter(sig => sig.type === 'reject').length;
		const conflictCount = Object.values(promises).filter(sig => sig.type === 'conflict').length;

		// Check if rejections make super-majority impossible
		// If more than (peerCount - superMajority) nodes reject, we can never reach super-majority
		const maxAllowedRejections = peerCount - superMajority;
		if (rejectionCount > maxAllowedRejections) {
			const rejectReasonsByPeer = Object.fromEntries(Object.entries(promises)
				.flatMap(([peerId, sig]) => sig.type === 'reject' ? [[peerId, sig.rejectReason ?? 'unknown'] as const] : []));
			const rejectReasons = Object.entries(rejectReasonsByPeer)
				.map(([peerId, reason]) => `${peerId}: ${reason}`)
				.join('; ');
			log('cluster-tx:rejected-by-validators', {
				messageHash: record.messageHash,
				peerCount,
				rejections: rejectionCount,
				maxAllowed: maxAllowedRejections,
				reasons: rejectReasons
			});
			this.updateTransactionRecord(promised.record, 'rejected-by-validators');
			// Abandoning here without telling anyone leaves every member that voted holding this
			// transaction in its own reservation table, blocking its blocks until that member's
			// staleness sweep fires — and each retry we throw back to the caller plants a fresh
			// reservation, so the block never frees. The merged record carries enough signed
			// rejections to *prove* the transaction is dead, so replaying it to the cohort makes
			// every member recompute `Rejected` and clear immediately. Proof-carrying, so a member
			// need not trust us: it verifies the signatures it is shown.
			this.broadcastAbandonment(promised.record, 'rejected-by-validators');
			throw new ValidatorRejectionError(
				`Transaction rejected by validators (${rejectionCount}/${peerCount} rejected): ${rejectReasons}`,
				rejectReasonsByPeer);
		}

		// A conflict-answered shortfall is a LOST RACE, not a validator verdict and not silence.
		// Checked after the rejection threshold (a genuine validator rejection still wins) and
		// before the generic shortfall (which must stay reserved for the genuinely-silent cohort).
		if (conflictCount > 0 && approvalCount < superMajority) {
			const conflicts = Object.fromEntries(Object.entries(promises)
				.flatMap(([peerId, sig]) => sig.type === 'conflict' ? [[peerId, sig.conflictWith] as const] : []));
			log('cluster-tx:conflict-race-lost', {
				messageHash: record.messageHash,
				peerCount,
				approvals: approvalCount,
				rejections: rejectionCount,
				conflicts,
				superMajority
			});
			this.updateTransactionRecord(promised.record, 'conflict-race-lost');
			// Broadcast only when the merged record itself PROVES the transaction can no longer reach
			// super-majority (members re-derive ConflictSuperseded/Rejected from the signed votes and
			// clear their reservations immediately). Below that bar the record proves nothing and a
			// broadcast would be the unauthenticated "forget this" the shortfall NOTE below refuses.
			if (rejectionCount + conflictCount > maxAllowedRejections) {
				this.broadcastAbandonment(promised.record, 'conflict-race-lost');
			}
			throw new ConflictRaceLostError(
				`Conflict race lost: ${conflictCount}/${peerCount} member(s) hold a conflicting winner (${approvalCount}/${superMajority} approvals)`,
				conflicts);
		}

		if (peerCount > 1 && approvalCount < superMajority) {
			log('cluster-tx:supermajority-failed', {
				messageHash: record.messageHash,
				peerCount,
				approvals: approvalCount,
				rejections: rejectionCount,
				superMajority,
				threshold: this.cfg.superMajorityThreshold
			});
			this.updateTransactionRecord(promised.record, 'supermajority-failed');
			// NOTE: deliberately NOT broadcast, unlike the rejected-by-validators branch above. With
			// conflict-answered shortfalls peeled off above, we get here only because peers did not
			// answer at all, so the record carries no signed evidence that the transaction is dead — a
			// broadcast would be an unauthenticated "forget this" that any caller could use to clear a
			// live transaction out of a member's reservation table. Members that DID vote are freed by
			// their own staleness sweep instead.
			// NOTE: the message below is load-bearing wire text — the consuming repo
			// (sereus cadre-core control-write-retry) matches it verbatim to retry a genuinely-silent
			// cohort. Keep it byte-identical, and never fold conflict votes into its rejection count.
			throw new Error(`Failed to get super-majority: ${approvalCount}/${peerCount} approvals (needed ${superMajority}, ${rejectionCount} rejections)`);
		}

		// Mark as disputed when minority rejections exist but super-majority approves
		if (rejectionCount > 0 && approvalCount >= superMajority) {
			const rejectingPeers: string[] = [];
			const rejectReasons: { [peerId: string]: string } = {};
			for (const [peerId, sig] of Object.entries(promises)) {
				if (sig.type === 'reject') {
					rejectingPeers.push(peerId);
					rejectReasons[peerId] = sig.rejectReason ?? 'unknown';
				}
			}
			promised.record.disputed = true;
			promised.record.disputeEvidence = { rejectingPeers, rejectReasons };
			log('cluster-tx:disputed', {
				messageHash: record.messageHash,
				rejectingPeers,
				rejectReasons,
				approvalCount,
				rejectionCount,
				peerCount
			});
			// [dispute-subsystem-dormant] Evidence is computed and persisted but initiateDispute() is
			// intentionally NOT called here. Dispute origination stays dormant pending arbitrator-set
			// anchoring — without it a forged synthetic cohort passes resolution.
			// Gate: tickets/backlog/hardening/invalidation-live-wiring-requires-arbitrator-set-anchoring
			// Wiring plan: tickets/backlog/feat-dispute-subsystem-live-activation
		}

		this.persistCoordinatorState(promised.record.messageHash, promised.record, 'committing');
		return await this.commitTransaction(promised.record);
	}

	async getClusterSize(blockId: BlockId): Promise<number> {
		const peers = await this.getClusterForBlock(blockId);
		return Object.keys(peers ?? {}).length;
	}

	/**
	 * Validate that a small cluster size is legitimate by querying remote peers
	 * for their network size estimates. Returns true if estimates roughly agree.
	 */
	private async validateSmallCluster(localSize: number, _peers: ClusterPeers): Promise<boolean> {
		// If we have FRET and it shows confident estimate
		if (this.fretService) {
			try {
				const estimate = this.fretService.getNetworkSizeEstimate();
				if (estimate.confidence > 0.5) {
					// Check if FRET estimate roughly matches observed cluster size
					const orderOfMagnitude = Math.floor(Math.log10(estimate.size_estimate + 1));
					const localOrderOfMagnitude = Math.floor(Math.log10(localSize + 1));

					// If within same order of magnitude, accept it
					if (Math.abs(orderOfMagnitude - localOrderOfMagnitude) <= 1) {
						log('cluster-tx:small-cluster-validated-by-fret', {
							localSize,
							fretEstimate: estimate.size_estimate,
							confidence: estimate.confidence,
							sources: estimate.sources
						});
						return true;
					}
				}
			} catch (err) {
				// Ignore errors
			}
		}

		// Fallback: with no confident network-size estimate, fail CLOSED by default.
		// An undersized cluster with no way to justify its size is unsafe (a lone/
		// near-lone node could rubber-stamp its own writes), so reject unless the
		// operator has explicitly opted in via allowUnvalidatedSmallCluster (e.g.
		// single-node / local dev knowingly running below the floor).
		const admit = this.cfg.allowUnvalidatedSmallCluster ?? false;
		log('cluster-tx:small-cluster-no-confident-estimate', {
			localSize,
			reason: 'no-confident-network-size-estimate',
			admit
		});
		return admit;
	}

	/**
	 * Collects promises from all peers in the cluster
	 */
	private async collectPromises(peers: ClusterPeers, record: ClusterRecord): Promise<{ record: ClusterRecord }> {
		const peerIds = Object.keys(peers);
		const summary: ClusterLogPeerOutcome[] = [];
		if (verbose) {
			const peerDetail = peerIds.map(id => ({
				id: id.substring(0, 12),
				addrs: peers[id]?.multiaddrs?.length ?? 0
			}));
			log('cluster-tx:promise-peers', { messageHash: record.messageHash, peers: peerDetail });
		}
		// For each peer, create a client and request a promise. A remote promise rides
		// a libp2p stream that a relayed (limited) connection can reset transiently, so
		// each remote request gets `promiseImmediateRetries` in-line re-attempts before
		// it counts as a failure — without this a single relayed reset drops the peer and
		// sinks super-majority (the commit broadcast already has the same guard).
		const promiseRequests = peerIds.map(peerIdStr => {
			const isLocal = this.localCluster && peerIdStr === this.localCluster.peerId.toString();
			log('cluster-tx:promise-request', { messageHash: record.messageHash, peerId: peerIdStr, isLocal });
			return new Pending(this.updateMember(peerIdStr, record, this.promiseImmediateRetries, 'promise'));
		});

		// Wait for all promises to complete
		const results = await Promise.all(promiseRequests.map((p, idx) => p.result().then(res => {
			const peerIdStr = peerIds[idx]!;
			log('cluster-tx:promise-response', {
				messageHash: record.messageHash,
				peerId: peerIdStr,
				success: true,
				returnedPromises: Object.keys(res.promises ?? {}),
				returnedCommits: Object.keys(res.commits ?? {})
			});
			summary.push({ peerId: peerIdStr, success: true });
			return res;
		}).catch(err => {
			const peerIdStr = peerIds[idx]!;
			log('cluster-tx:promise-response', { messageHash: record.messageHash, peerId: peerIdStr, success: false, error: err });
			summary.push({ peerId: peerIdStr, success: false, error: err instanceof Error ? err.message : String(err) });
			this.reputation?.reportPeer(peerIdStr, PenaltyReason.ConsensusTimeout, `promise:${record.messageHash}`);
			return null;
		})));
		const successes = summary.filter(entry => entry.success).map(entry => entry.peerId);
		const failures = summary.filter(entry => !entry.success);
		log('cluster-tx:promise-summary', {
			messageHash: record.messageHash,
			successes,
			failures
		});

		log('cluster-tx:promise-merge-begin', {
			messageHash: record.messageHash,
			initialPromises: Object.keys(record.promises ?? {}),
			transactionsKeys: Array.from(this.transactions.keys()),
			hasTransaction: this.transactions.has(record.messageHash)
		});

		// Merge all promises into the record
		for (const result of results.filter(Boolean) as ClusterRecord[]) {
			log('cluster-tx:promise-merge-input', {
				messageHash: record.messageHash,
				resultFrom: Object.keys(result.promises ?? {}),
				recordBefore: Object.keys(record.promises ?? {})
			});
			const resultPromises = Object.keys(result.promises ?? {});
			log('cluster-tx:promise-merge-result', {
				messageHash: record.messageHash,
				peerPromises: resultPromises
			});
			if (typeof record.suggestedClusterSize === 'number' && typeof result.suggestedClusterSize === 'number') {
				const expected = result.suggestedClusterSize;
				const actual = Object.keys(peers).length;
				const maxDiff = Math.ceil(Math.max(1, expected * this.cfg.clusterSizeTolerance));
				if (Math.abs(actual - expected) > maxDiff) {
					log('cluster-tx:size-variance', { expected, actual, tolerance: this.cfg.clusterSizeTolerance });
				}
			}
			record.promises = { ...record.promises, ...result.promises };
			log('cluster-tx:promise-merge-after', {
				messageHash: record.messageHash,
				mergedPromises: Object.keys(record.promises ?? {})
			});
		}
		log('cluster-tx:promise-merge', {
			messageHash: record.messageHash,
			mergedPromises: Object.keys(record.promises ?? {})
		});
		log('cluster-tx:promise-merge-end', {
			messageHash: record.messageHash,
			finalPromises: Object.keys(record.promises ?? {}),
			transactionsEntry: this.transactions.get(record.messageHash)
		});
		this.updateTransactionRecord(record, 'after-promises');
		return { record };
	}

	/**
	 * Commits the transaction to all peers in the cluster
	 */
	private async commitTransaction(record: ClusterRecord): Promise<ClusterRecord> {
		// For each peer, create a client and send the commit
		const peerIds = Object.keys(record.peers);
		const summary: ClusterLogPeerOutcome[] = [];
		if (verbose) {
			const peerDetail = peerIds.map(id => ({
				id: id.substring(0, 12),
				addrs: record.peers[id]?.multiaddrs?.length ?? 0
			}));
			log('cluster-tx:commit-peers', { messageHash: record.messageHash, peers: peerDetail });
		}
		// Send the record with promises to all peers
		// Each peer will add its own commit signature
		const commitPayload = {
			...record
		};
		// No per-peer immediate retry here: a commit-collection failure is recovered
		// downstream by broadcastMergedRecord's in-line retry and the scheduled
		// commit-retry timer. (The promise phase has no such backstop, which is why
		// collectPromises gets the immediate retry instead.)
		const commitRequests = peerIds.map(peerIdStr => {
			const isLocal = this.localCluster && peerIdStr === this.localCluster.peerId.toString();
			log('cluster-tx:commit-request', { messageHash: record.messageHash, peerId: peerIdStr, isLocal });
			const promise = isLocal
				? this.localCluster!.update(commitPayload)
				: this.createClusterClient(peerIdFromString(peerIdStr)).update(commitPayload);
			return new Pending(promise);
		});

		// Wait for all commits to complete
		const results = await Promise.all(commitRequests.map((p, idx) => p.result().then(res => {
			const peerIdStr = peerIds[idx]!;
			log('cluster-tx:commit-response', { messageHash: record.messageHash, peerId: peerIdStr, success: true });
			summary.push({ peerId: peerIdStr, success: true });
			return res;
		}).catch(err => {
			const peerIdStr = peerIds[idx]!;
			log('cluster-tx:commit-response', { messageHash: record.messageHash, peerId: peerIdStr, success: false, error: err });
			summary.push({ peerId: peerIdStr, success: false, error: err instanceof Error ? err.message : String(err) });
			this.reputation?.reportPeer(peerIdStr, PenaltyReason.ConsensusTimeout, `commit:${record.messageHash}`);
			return null;
		})));
		const commitSuccesses = summary.filter(entry => entry.success).map(entry => entry.peerId);
		const commitFailures = summary.filter(entry => !entry.success);
		log('cluster-tx:commit-summary', {
			messageHash: record.messageHash,
			successes: commitSuccesses,
			failures: commitFailures
		});
		log('cluster-tx:commit-merge-begin', {
			messageHash: record.messageHash,
			initialCommits: Object.keys(record.commits ?? {}),
			transactionsEntry: this.transactions.get(record.messageHash)
		});

		// Merge all commits into the record
		for (const result of results.filter(Boolean) as ClusterRecord[]) {
			log('cluster-tx:commit-merge-input', {
				messageHash: record.messageHash,
				resultFrom: Object.keys(result.commits ?? {}),
				recordBefore: Object.keys(record.commits ?? {})
			});
			log('cluster-tx:commit-merge-result', {
				messageHash: record.messageHash,
				peerCommits: Object.keys(result.commits ?? {})
			});
			record.commits = { ...record.commits, ...result.commits };
			log('cluster-tx:commit-merge-after', {
				messageHash: record.messageHash,
				mergedCommits: Object.keys(record.commits ?? {})
			});
		}
		log('cluster-tx:commit-merge', {
			messageHash: record.messageHash,
			mergedCommits: Object.keys(record.commits ?? {})
		});
		log('cluster-tx:commit-merge-end', {
			messageHash: record.messageHash,
			finalCommits: Object.keys(record.commits ?? {}),
			transactionsEntry: this.transactions.get(record.messageHash)
		});
		this.updateTransactionRecord(record, 'after-commit');

		// Check for simple majority (>50%) - this proves commitment
		const peerCount = Object.keys(record.peers).length;
		const simpleMajority = Math.floor(peerCount * this.cfg.simpleMajorityThreshold) + 1;
		const commitCount = Object.keys(record.commits).length;

		if (commitCount >= simpleMajority) {
			log('cluster-tx:commit-majority-reached', {
				messageHash: record.messageHash,
				commitCount,
				simpleMajority,
				peerCount,
				threshold: this.cfg.simpleMajorityThreshold
			});
			// Broadcast the merged record (with all commit signatures) to ALL peers
			// so each peer can independently reach consensus and execute the operations.
			// Without this, only the coordinator's local cluster executes — remote peers
			// never see enough commits to reach consensus on their own.
			const { failures: broadcastFailures } = await this.broadcastMergedRecord(record, peerIds);
			if (broadcastFailures.length > 0) {
				this.scheduleCommitRetry(record.messageHash, record, broadcastFailures);
			} else {
				this.clearRetry(record.messageHash);
			}
		} else {
			const missingPeers = commitFailures.map(entry => entry.peerId);
			if (missingPeers.length > 0) {
				this.scheduleCommitRetry(record.messageHash, record, missingPeers);
			} else {
				this.clearRetry(record.messageHash);
			}
		}
		return record;
	}

	/**
	 * Broadcast the merged commit record to every peer, with `commitBroadcastImmediateRetries`
	 * in-line re-attempts per peer before giving up. The libp2p connection used during
	 * the prior commit phase is typically still warm, so a single immediate retry recovers
	 * most transient stream errors without falling back to the scheduled retry timer.
	 * Local cluster is invoked exactly once — local failures are fatal, not transient.
	 */
	private async broadcastMergedRecord(record: ClusterRecord, peerIds: string[]): Promise<{ failures: string[] }> {
		const results = await Promise.all(peerIds.map(async peerIdStr => {
			try {
				await this.updateMember(peerIdStr, record, this.commitBroadcastImmediateRetries, 'commit-broadcast');
				return { peerId: peerIdStr, success: true as const };
			} catch (err) {
				log('cluster-tx:consensus-broadcast-error', {
					messageHash: record.messageHash,
					peerId: peerIdStr,
					error: err instanceof Error ? err.message : String(err)
				});
				return { peerId: peerIdStr, success: false as const };
			}
		}));
		const failures = results.filter(r => !r.success).map(r => r.peerId);
		return { failures };
	}

	/**
	 * Fire-and-forget replay of an abandoned transaction's record to every peer in its cohort.
	 *
	 * Called only where the record itself proves the transaction is dead (enough signed rejections that
	 * super-majority is unreachable). Each member re-derives `TransactionPhase.Rejected` from the votes
	 * it verifies and drops the entry from its own reservation table, freeing the blocks immediately
	 * instead of after its 2 s staleness window. No new message type and no wire-format change — this is
	 * the same `update()` every other phase uses.
	 *
	 * Never awaited into the caller's throw and never rethrows: an abandonment must not turn into a
	 * *different* failure, and the staleness sweep remains the backstop if delivery fails.
	 */
	private broadcastAbandonment(record: ClusterRecord, reason: string): void {
		const peerIds = Object.keys(record.peers);
		log('cluster-tx:abandon-broadcast', { messageHash: record.messageHash, reason, peerIds });
		void Promise.all(peerIds.map(async peerIdStr => {
			try {
				await this.updateMember(peerIdStr, record, 0, 'abandon-broadcast');
			} catch (err) {
				log('cluster-tx:abandon-broadcast-error', {
					messageHash: record.messageHash,
					peerId: peerIdStr,
					error: err instanceof Error ? err.message : String(err)
				});
			}
		}));
	}

	private updateTransactionRecord(record: ClusterRecord, stage: string): void {
		const state = this.transactions.get(record.messageHash);
		if (!state) {
			log('cluster-tx:transaction-update-miss', { messageHash: record.messageHash, stage });
			return;
		}
		state.record = { ...record };
		state.lastUpdate = this.now();
		log('cluster-tx:transaction-update', {
			messageHash: record.messageHash,
			stage,
			promises: Object.keys(record.promises ?? {}),
			commits: Object.keys(record.commits ?? {})
		});
	}

	private scheduleCommitRetry(messageHash: string, _record: ClusterRecord, missingPeers: string[]): void {
		const state = this.transactions.get(messageHash);
		if (!state) {
			return;
		}
		const existing = state.retry;
		const nextAttempt = (existing?.attempt ?? 0) + 1;
		if (nextAttempt > this.retryMaxAttempts) {
			log('cluster-tx:retry-abort', { messageHash, missingPeers });
			return;
		}
		if (missingPeers.length === 0) {
			this.clearRetry(messageHash);
			return;
		}
		const pendingPeers = new Set(missingPeers);
		const baseInterval = existing ? Math.min(existing.intervalMs * this.retryBackoffFactor, this.retryMaxIntervalMs) : this.retryInitialIntervalMs;
		existing?.cancel?.();
		const cancel = this.setTimer(() => {
			void this.retryCommits(messageHash);
		}, baseInterval);
		state.retry = {
			pendingPeers,
			attempt: nextAttempt,
			intervalMs: baseInterval,
			cancel
		};
		this.persistCoordinatorState(messageHash, state.record, 'broadcasting', {
			pendingPeers: Array.from(pendingPeers),
			attempt: nextAttempt,
			intervalMs: baseInterval
		});
		log('cluster-tx:retry-scheduled', { messageHash, attempt: nextAttempt, missingPeers, delayMs: baseInterval });
	}

	private async retryCommits(messageHash: string): Promise<void> {
		const state = this.transactions.get(messageHash);
		if (!state?.retry) {
			return;
		}
		const { pendingPeers, attempt } = state.retry;
		if (pendingPeers.size === 0) {
			this.clearRetry(messageHash);
			return;
		}
		const peerIds = Array.from(pendingPeers);
		const record = state.record;
		log('cluster-tx:retry-start', { messageHash, attempt, peerIds });
		const results = await Promise.all(peerIds.map(async peerIdStr => {
			const isLocal = this.localCluster && peerIdStr === this.localCluster.peerId.toString();
			const payload: ClusterRecord = {
				...record,
				commits: record.commits
			};
			try {
				const res = isLocal
					? await this.localCluster!.update(payload)
					: await this.createClusterClient(peerIdFromString(peerIdStr)).update(payload);
				state.record.commits = { ...state.record.commits, ...res.commits };
				return { peerId: peerIdStr, success: true as const };
			} catch (err) {
				return {
					peerId: peerIdStr,
					success: false as const,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		}));
		const successes = results.filter(r => r.success).map(r => r.peerId);
		const failures = results.filter(r => !r.success);
		for (const peerId of successes) {
			pendingPeers.delete(peerId);
		}
		log('cluster-tx:retry-complete', { messageHash, attempt, successes, failures });
		if (pendingPeers.size === 0) {
			log('cluster-tx:retry-finished', { messageHash });
			this.clearRetry(messageHash);
			return;
		}
		if (!this.transactions.has(messageHash)) {
			return;
		}
		this.scheduleCommitRetry(messageHash, state.record, Array.from(pendingPeers));
	}

	private clearRetry(messageHash: string): void {
		const state = this.transactions.get(messageHash);
		if (!state?.retry) {
			return;
		}
		state.retry.cancel?.();
		state.retry = undefined;
		// Clean up the transaction after retry is complete
		this.setTimer(() => {
			this.transactions.delete(messageHash);
			this.deleteCoordinatorState(messageHash);
			log('cluster-tx:transaction-remove', {
				messageHash,
				remaining: Array.from(this.transactions.keys())
			});
		}, 100);
	}

	/** Fire-and-forget persist — errors are logged, never thrown. */
	private persistCoordinatorState(
		messageHash: string,
		record: ClusterRecord,
		phase: 'promising' | 'committing' | 'broadcasting',
		retryState?: { pendingPeers: string[]; attempt: number; intervalMs: number }
	): void {
		if (!this.stateStore) return;
		this.stateStore.saveCoordinatorState(messageHash, {
			messageHash,
			record,
			lastUpdate: this.now(),
			phase,
			retryState
		}).catch(err => log('cluster-tx:persist-error', { messageHash, error: (err as Error).message }));
	}

	/** Fire-and-forget delete — errors are logged, never thrown. */
	private deleteCoordinatorState(messageHash: string): void {
		if (!this.stateStore) return;
		this.stateStore.deleteCoordinatorState(messageHash)
			.catch(err => log('cluster-tx:persist-delete-error', { messageHash, error: (err as Error).message }));
	}

	/**
	 * Recover coordinator transactions from persistent store after a restart.
	 * Called during node startup, before accepting new requests.
	 */
	async recoverTransactions(): Promise<void> {
		if (!this.stateStore) return;
		const states = await this.stateStore.getAllCoordinatorStates();
		for (const state of states) {
			const { messageHash } = state;
			// Expired — clean up
			if (state.record.message.expiration && state.record.message.expiration < this.now()) {
				log('cluster-tx:recovery-expired', { messageHash });
				await this.stateStore.deleteCoordinatorState(messageHash);
				continue;
			}
			// Broadcasting phase with retry state — resume retries
			if (state.phase === 'broadcasting' && state.retryState) {
				log('cluster-tx:recovery-resume-broadcast', { messageHash, attempt: state.retryState.attempt });
				const pending = new Pending(Promise.resolve(state.record));
				const txState: ClusterTransactionState = {
					messageHash,
					record: state.record,
					pending,
					lastUpdate: state.lastUpdate
				};
				this.transactions.set(messageHash, txState);
				// Schedule retry from where we left off
				this.scheduleCommitRetry(messageHash, state.record, state.retryState.pendingPeers);
				continue;
			}
			// Promising or committing — cannot resume (caller context is gone)
			log('cluster-tx:recovery-stale', { messageHash, phase: state.phase });
			await this.stateStore.deleteCoordinatorState(messageHash);
		}
	}
}
