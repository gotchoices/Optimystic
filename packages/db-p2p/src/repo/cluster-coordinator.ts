import { peerIdFromString } from "@libp2p/peer-id";
import type { ClusterRecord, IKeyNetwork, RepoMessage, BlockId, ClusterPeers, MessageOptions, Signature, ClusterConsensusConfig } from "@optimystic/db-core";
import { base58btc } from "multiformats/bases/base58";
import { sha256 } from "multiformats/hashes/sha2";
import { ClusterClient } from "../cluster/client.js";
import { Pending } from "@optimystic/db-core";
import type { PeerId } from "@libp2p/interface";
import { createLogger } from '../logger.js'
import type { ClusterLogPeerOutcome } from './types.js'
import type { FretService } from "@optimystic/fret";

const log = createLogger('cluster')

/**
 * Manages the state of cluster transactions for a specific block ID
 */
interface CommitRetryState {
	pendingPeers: Set<string>;
	attempt: number;
	intervalMs: number;
	timer?: NodeJS.Timeout;
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
	// TODO: move this into a state management interface so that transaction state can be persisted
	private transactions: Map<string, ClusterTransactionState> = new Map();
	private readonly retryInitialIntervalMs = 2000;
	private readonly retryBackoffFactor = 2;
	private readonly retryMaxIntervalMs = 30000;
	private readonly retryMaxAttempts = 5;

	constructor(
		private readonly keyNetwork: IKeyNetwork,
		private readonly createClusterClient: (peerId: PeerId) => ClusterClient,
		private readonly cfg: ClusterConsensusConfig & { clusterSize: number },
		private readonly localCluster?: { update: (record: ClusterRecord) => Promise<ClusterRecord>; peerId: PeerId },
		private readonly fretService?: FretService
	) { }

	/**
	 * Creates a base 58 BTC string hash for a message to uniquely identify a transaction
	 */
	private async createMessageHash(message: RepoMessage): Promise<string> {
		const msgBytes = new TextEncoder().encode(JSON.stringify(message));
		const hashBytes = await sha256.digest(msgBytes);
		return base58btc.encode(hashBytes.digest);
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

	private makeRecord(peers: ClusterPeers, messageHash: string, message: RepoMessage): ClusterRecord {
		const peerCount = Object.keys(peers ?? {}).length;
		const record: ClusterRecord = {
			messageHash,
			peers,
			message,
			coordinatingBlockIds: message.coordinatingBlockIds,
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
	 * Initiates a 2-phase transaction for a specific block ID
	 */
	async executeClusterTransaction(blockId: BlockId, message: RepoMessage, options?: MessageOptions): Promise<any> {
		// Get the cluster peers for this block
		const peers = await this.getClusterForBlock(blockId);

		// Create a unique hash for this transaction
		const messageHash = await this.createMessageHash(message);

		// Create a cluster record for this transaction
		const record = this.makeRecord(peers, messageHash, message);
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
			lastUpdate: Date.now()
		};
		this.transactions.set(messageHash, state);
		log('cluster-tx:transaction-store', {
			messageHash,
			transactionKeys: Array.from(this.transactions.keys())
		});

		// Wait for the transaction to complete
		try {
			const result = await pending.result();
			return result;
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
				setTimeout(() => {
					this.transactions.delete(messageHash);
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

		// Count approvals and rejections separately
		const promises = promised.record.promises;
		const approvalCount = Object.values(promises).filter(sig => sig.type === 'approve').length;
		const rejectionCount = Object.values(promises).filter(sig => sig.type === 'reject').length;

		// Check if rejections make super-majority impossible
		// If more than (peerCount - superMajority) nodes reject, we can never reach super-majority
		const maxAllowedRejections = peerCount - superMajority;
		if (rejectionCount > maxAllowedRejections) {
			const rejectReasons = Object.entries(promises)
				.filter(([_, sig]) => sig.type === 'reject')
				.map(([peerId, sig]) => `${peerId}: ${sig.rejectReason ?? 'unknown'}`)
				.join('; ');
			log('cluster-tx:rejected-by-validators', {
				messageHash: record.messageHash,
				peerCount,
				rejections: rejectionCount,
				maxAllowed: maxAllowedRejections,
				reasons: rejectReasons
			});
			this.updateTransactionRecord(promised.record, 'rejected-by-validators');
			throw new Error(`Transaction rejected by validators (${rejectionCount}/${peerCount} rejected): ${rejectReasons}`);
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
			throw new Error(`Failed to get super-majority: ${approvalCount}/${peerCount} approvals (needed ${superMajority}, ${rejectionCount} rejections)`);
		}

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
	private async validateSmallCluster(localSize: number, peers: ClusterPeers): Promise<boolean> {
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

		// Fallback: accept small clusters in development/testing scenarios
		// In production, FRET should provide validation
		log('cluster-tx:small-cluster-accepted-without-validation', {
			localSize,
			reason: 'no-confident-network-size-estimate'
		});
		return true;
	}

	/**
	 * Collects promises from all peers in the cluster
	 */
	private async collectPromises(peers: ClusterPeers, record: ClusterRecord): Promise<{ record: ClusterRecord }> {
		const peerIds = Object.keys(peers);
		const summary: ClusterLogPeerOutcome[] = [];
		// For each peer, create a client and request a promise
		const promiseRequests = peerIds.map(peerIdStr => {
			const isLocal = this.localCluster && peerIdStr === this.localCluster.peerId.toString();
			log('cluster-tx:promise-request', { messageHash: record.messageHash, peerId: peerIdStr, isLocal });
			const promise = isLocal
				? this.localCluster!.update(record)
				: this.createClusterClient(peerIdFromString(peerIdStr)).update(record);
			return new Pending(promise);
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
		// Send the record with promises to all peers
		// Each peer will add its own commit signature
		const commitPayload = {
			...record
		};
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
			// Simple majority proves commitment - we can return success
			// Background propagation to remaining peers will continue
		}

		const missingPeers = commitFailures.map(entry => entry.peerId);
		if (missingPeers.length > 0) {
			this.scheduleCommitRetry(record.messageHash, record, missingPeers);
		} else {
			this.clearRetry(record.messageHash);
		}
		return record;
	}

	private updateTransactionRecord(record: ClusterRecord, stage: string): void {
		const state = this.transactions.get(record.messageHash);
		if (!state) {
			log('cluster-tx:transaction-update-miss', { messageHash: record.messageHash, stage });
			return;
		}
		state.record = { ...record };
		state.lastUpdate = Date.now();
		log('cluster-tx:transaction-update', {
			messageHash: record.messageHash,
			stage,
			promises: Object.keys(record.promises ?? {}),
			commits: Object.keys(record.commits ?? {})
		});
	}

	private scheduleCommitRetry(messageHash: string, record: ClusterRecord, missingPeers: string[]): void {
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
		if (existing?.timer) {
			clearTimeout(existing.timer);
		}
		const timer = setTimeout(() => {
			void this.retryCommits(messageHash);
		}, baseInterval);
		state.retry = {
			pendingPeers,
			attempt: nextAttempt,
			intervalMs: baseInterval,
			timer
		};
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
		if (state.retry.timer) {
			clearTimeout(state.retry.timer);
		}
		state.retry = undefined;
		// Clean up the transaction after retry is complete
		setTimeout(() => {
			this.transactions.delete(messageHash);
			log('cluster-tx:transaction-remove', {
				messageHash,
				remaining: Array.from(this.transactions.keys())
			});
		}, 100);
	}
}
