import type { IRepo, ClusterRecord, Signature, RepoMessage } from "@optimystic/db-core";
import type { ICluster } from "@optimystic/db-core";
import type { IPeerNetwork } from "@optimystic/db-core";
import { blockIdsForTransforms } from "@optimystic/db-core";
import { ClusterClient } from "./client.js";
import type { PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { sha256 } from "multiformats/hashes/sha2";
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import { createLogger } from '../logger.js'
import type { PartitionDetector } from "./partition-detector.js";
import type { FretService } from "@optimystic/fret";

const log = createLogger('cluster-member')

/** State of a transaction in the cluster */
enum TransactionPhase {
	Promising,       // Collecting promises from peers
	OurPromiseNeeded, // We need to provide our promise
	OurCommitNeeded, // We need to provide our commit
	Consensus,       // Transaction has reached consensus
	Rejected,        // Transaction was rejected
	Propagating     // Transaction is being propagated
}

interface TransactionState {
	record: ClusterRecord;
	promiseTimeout?: NodeJS.Timeout;
	resolutionTimeout?: NodeJS.Timeout;
	lastUpdate: number;
}

interface ClusterMemberComponents {
	storageRepo: IRepo;
	peerNetwork: IPeerNetwork;
	peerId: PeerId;
	protocolPrefix?: string;
	partitionDetector?: PartitionDetector;
	fretService?: FretService;
}

export function clusterMember(components: ClusterMemberComponents): ClusterMember {
	return new ClusterMember(components.storageRepo, components.peerNetwork, components.peerId, components.protocolPrefix, components.partitionDetector, components.fretService);
}

/**
 * Handles cluster-side operations, managing promises and commits for cluster updates
 * and coordinating with the local storage repo.
 */
export class ClusterMember implements ICluster {
	// Track active transactions by their message hash
	private activeTransactions: Map<string, TransactionState> = new Map();
	// Queue of transactions to clean up
	private cleanupQueue: string[] = [];
	// Serialize concurrent updates for the same transaction
	private pendingUpdates: Map<string, Promise<ClusterRecord>> = new Map();

	constructor(
		private readonly storageRepo: IRepo,
		private readonly peerNetwork: IPeerNetwork,
		private readonly peerId: PeerId,
		private readonly protocolPrefix?: string,
		private readonly partitionDetector?: PartitionDetector,
		private readonly fretService?: FretService
	) {
		// Periodically clean up expired transactions
		setInterval(() => this.queueExpiredTransactions(), 60000);
		// Process cleanup queue
		setInterval(() => this.processCleanupQueue(), 1000);
	}

	/**
	 * Handles an incoming cluster update, managing the two-phase commit process
	 * and coordinating with the local storage repo
	 */
	async update(record: ClusterRecord): Promise<ClusterRecord> {
		// Serialize concurrent updates for the same transaction
		const existingUpdate = this.pendingUpdates.get(record.messageHash);
		if (existingUpdate) {
			log('cluster-member:concurrent-update-wait', { messageHash: record.messageHash });
			await existingUpdate;
			// After waiting, continue processing with the new incoming record
			// to ensure proper merging of promises/commits from coordinator
		}

		// Create a promise for this update operation
		const updatePromise = this.processUpdate(record);
		this.pendingUpdates.set(record.messageHash, updatePromise);

		try {
			const result = await updatePromise;
			return result;
		} finally {
			// Remove from pending updates after a short delay to allow concurrent calls to see it
			setTimeout(() => {
				this.pendingUpdates.delete(record.messageHash);
			}, 100);
		}
	}

	private async processUpdate(record: ClusterRecord): Promise<ClusterRecord> {
		const ourId = this.peerId.toString();
		const inboundPhase = record.commits[ourId] ? 'commit' : record.promises[ourId] ? 'promise' : 'initial';
		log('cluster-member:incoming', {
			messageHash: record.messageHash,
			phase: inboundPhase,
			peerCount: Object.keys(record.peers).length,
			promiseCount: Object.keys(record.promises).length,
			commitCount: Object.keys(record.commits).length,
			existingTransaction: this.activeTransactions.has(record.messageHash)
		});

		// Report network size hint to FRET if provided
		if (this.fretService && record.networkSizeHint && record.networkSizeConfidence) {
			try {
				this.fretService.reportNetworkSize(
					record.networkSizeHint,
					record.networkSizeConfidence,
					'cluster'
				);
			} catch (err) {
				// Ignore errors reporting to FRET
			}
		}

		// Validate the incoming record
		await this.validateRecord(record);

		const existingState = this.activeTransactions.get(record.messageHash);
		let currentRecord = existingState?.record || record;
		if (existingState) {
			log('cluster-member:merge-start', {
				messageHash: record.messageHash,
				existingPromises: Object.keys(existingState.record.promises ?? {}),
				existingCommits: Object.keys(existingState.record.commits ?? {}),
				incomingPromises: Object.keys(record.promises ?? {}),
				incomingCommits: Object.keys(record.commits ?? {})
			});
		}

		// If we have an existing record, merge the signatures
		if (existingState) {
			currentRecord = await this.mergeRecords(existingState.record, record);
			log('cluster-member:merge-complete', {
				messageHash: record.messageHash,
				mergedPromises: Object.keys(currentRecord.promises ?? {}),
				mergedCommits: Object.keys(currentRecord.commits ?? {})
			});
		}

		// Get the current transaction state
		const phase = await this.getTransactionPhase(currentRecord);
		log('cluster-member:phase', {
			messageHash: record.messageHash,
			phase,
			promises: Object.keys(currentRecord.promises ?? {}),
			commits: Object.keys(currentRecord.commits ?? {})
		});
		let shouldPersist = true;

		// Handle the transaction based on its state
		switch (phase) {
			case TransactionPhase.OurPromiseNeeded:
				log('cluster-member:action-promise', {
					messageHash: record.messageHash
				});
				currentRecord = await this.handlePromiseNeeded(currentRecord);
				log('cluster-member:action-promise-complete', {
					messageHash: record.messageHash,
					promises: Object.keys(currentRecord.promises ?? {})
				});
				break;
			case TransactionPhase.OurCommitNeeded:
				log('cluster-member:action-commit', {
					messageHash: record.messageHash
				});
				currentRecord = await this.handleCommitNeeded(currentRecord);
				log('cluster-member:action-commit-complete', {
					messageHash: record.messageHash,
					commits: Object.keys(currentRecord.commits ?? {})
				});
				// After adding our commit, clear the transaction - the coordinator will handle consensus
				shouldPersist = false;
				break;
			case TransactionPhase.Consensus:
				log('cluster-member:action-consensus', {
					messageHash: record.messageHash
				});
				await this.handleConsensus(currentRecord);
				// Don't call clearTransaction here - it happens in handleConsensus
				shouldPersist = false;
				break;
			case TransactionPhase.Rejected:
				log('cluster-member:action-rejected', {
					messageHash: record.messageHash
				});
				// Don't call clearTransaction here - it happens in handleRejection
				await this.handleRejection(currentRecord);
				shouldPersist = false;
				break;
			case TransactionPhase.Propagating:
				// Transaction is complete and propagating - clean it up
				log('cluster-member:phase-propagating', {
					messageHash: record.messageHash
				});
				shouldPersist = false;
				break;
			case TransactionPhase.Promising:
				// Still collecting promises from peers - if we haven't added ours and there's no conflict, add it
				// This state shouldn't normally be reached since OurPromiseNeeded is checked first
				log('cluster-member:phase-promising-blocked', {
					messageHash: record.messageHash
				});
				break;
		}

		if (shouldPersist) {
			// Update transaction state
			const timeouts = this.setupTimeouts(currentRecord);
			this.activeTransactions.set(record.messageHash, {
				record: currentRecord,
				lastUpdate: Date.now(),
				promiseTimeout: timeouts.promiseTimeout,
				resolutionTimeout: timeouts.resolutionTimeout
			});
			log('cluster-member:state-persist', {
				messageHash: record.messageHash,
				storedPromises: Object.keys(currentRecord.promises ?? {}),
				storedCommits: Object.keys(currentRecord.commits ?? {})
			});
		} else {
			log('cluster-member:state-clear', {
				messageHash: record.messageHash
			});
			this.clearTransaction(record.messageHash);
		}

		// Skip propagation - the coordinator manages distribution
		// await this.propagateIfNeeded(currentRecord);

		log('cluster-member:update-complete', {
			messageHash: record.messageHash,
			promiseCount: Object.keys(currentRecord.promises).length,
			commitCount: Object.keys(currentRecord.commits).length
		});
		return currentRecord;
	}

	/**
	 * Merges two records, validating that non-signature fields match
	 */
	private async mergeRecords(existing: ClusterRecord, incoming: ClusterRecord): Promise<ClusterRecord> {
		log('cluster-member:merge-records', {
			messageHash: existing.messageHash,
			existingPromises: Object.keys(existing.promises ?? {}),
			existingCommits: Object.keys(existing.commits ?? {}),
			incomingPromises: Object.keys(incoming.promises ?? {}),
			incomingCommits: Object.keys(incoming.commits ?? {})
		});
		// Verify that immutable fields match
		if (existing.messageHash !== incoming.messageHash) {
			throw new Error('Message hash mismatch');
		}
		if (JSON.stringify(existing.message) !== JSON.stringify(incoming.message)) {
			throw new Error('Message content mismatch');
		}
		if (JSON.stringify(existing.peers) !== JSON.stringify(incoming.peers)) {
			throw new Error('Peers mismatch');
		}

		// Merge signatures, keeping the most recent valid ones
		return {
			...existing,
			promises: { ...existing.promises, ...incoming.promises },
			commits: { ...existing.commits, ...incoming.commits }
		};
	}

	private async validateRecord(record: ClusterRecord): Promise<void> {
		// TODO: Fix hash validation logic to match coordinator's hash generation
		// The coordinator creates the hash from the message, but this tries to re-hash the hash itself

		// Validate signatures
		await this.validateSignatures(record);

		// Validate expiration
		if (record.message.expiration && record.message.expiration < Date.now()) {
			throw new Error('Transaction expired');
		}
	}

	private async computeMessageHash(record: ClusterRecord): Promise<string> {
		const msgBytes = new TextEncoder().encode(record.messageHash + JSON.stringify(record.message));
		const hashBytes = await sha256.digest(msgBytes);
		return uint8ArrayToString(hashBytes.digest, 'base64url');
	}

	private async validateSignatures(record: ClusterRecord): Promise<void> {
		// Validate promise signatures
		const promiseHash = await this.computePromiseHash(record);
		for (const [peerId, signature] of Object.entries(record.promises)) {
			if (!await this.verifySignature(peerId, promiseHash, signature)) {
				throw new Error(`Invalid promise signature from ${peerId}`);
			}
		}

		// Validate commit signatures
		const commitHash = await this.computeCommitHash(record);
		for (const [peerId, signature] of Object.entries(record.commits)) {
			if (!await this.verifySignature(peerId, commitHash, signature)) {
				throw new Error(`Invalid commit signature from ${peerId}`);
			}
		}
	}

	private async computePromiseHash(record: ClusterRecord): Promise<string> {
		const msgBytes = new TextEncoder().encode(record.messageHash + JSON.stringify(record.message));
		const hashBytes = await sha256.digest(msgBytes);
		return uint8ArrayToString(hashBytes.digest, 'base64url');
	}

	private async computeCommitHash(record: ClusterRecord): Promise<string> {
		const msgBytes = new TextEncoder().encode(record.messageHash + JSON.stringify(record.message) + JSON.stringify(record.promises));
		const hashBytes = await sha256.digest(msgBytes);
		return uint8ArrayToString(hashBytes.digest, 'base64url');
	}

	private async verifySignature(peerId: string, hash: string, signature: Signature): Promise<boolean> {
		// TODO: Implement actual signature verification
		return true;
	}

	private async getTransactionPhase(record: ClusterRecord): Promise<TransactionPhase> {
		const peerCount = Object.keys(record.peers).length;
		const promiseCount = Object.keys(record.promises).length;
		const commitCount = Object.keys(record.commits).length;
		const ourId = this.peerId.toString();

		// Check for rejections
		const rejectedPromises = Object.values(record.promises).filter(s => s.type === 'reject');
		const rejectedCommits = Object.values(record.commits).filter(s => s.type === 'reject');
		if (rejectedPromises.length > 0 || this.hasMajority(rejectedCommits.length, peerCount)) {
			return TransactionPhase.Rejected;
		}

		// Check if we need to promise
		if (!record.promises[ourId] && !this.hasConflict(record)) {
			return TransactionPhase.OurPromiseNeeded;
		}

		// Check if still collecting promises
		if (promiseCount < peerCount) {
			return TransactionPhase.Promising;
		}

		// Check if we need to commit
		if (promiseCount === peerCount && !record.commits[ourId]) {
			return TransactionPhase.OurCommitNeeded;
		}

		// Check for consensus
		const approvedCommits = Object.values(record.commits).filter(s => s.type === 'approve');
		if (this.hasMajority(approvedCommits.length, peerCount)) {
			return TransactionPhase.Consensus;
		}

		return TransactionPhase.Propagating;
	}

	private hasMajority(count: number, total: number): boolean {
		return count > total / 2;
	}

	private async handlePromiseNeeded(record: ClusterRecord): Promise<ClusterRecord> {
		const signature: Signature = {
			type: 'approve',
			signature: 'approved' // TODO: Actually sign the promise hash
		};

		return {
			...record,
			promises: {
				...record.promises,
				[this.peerId.toString()]: signature
			}
		};
	}

	private async handleCommitNeeded(record: ClusterRecord): Promise<ClusterRecord> {
		if (this.hasLocalCommit(record)) {
			return record;
		}
		const signature: Signature = {
			type: 'approve',
			signature: 'committed' // TODO: Actually sign the commit hash
		};

		return {
			...record,
			commits: {
				...record.commits,
				[this.peerId.toString()]: signature
			}
		};
	}

	private async handleConsensus(record: ClusterRecord): Promise<void> {
		// Execute the operations only if we haven't already
		const state = this.activeTransactions.get(record.messageHash);
		if (!this.hasLocalCommit(state?.record ?? record)) {
			for (const operation of record.message.operations) {
				if ('get' in operation) {
					await this.storageRepo.get(operation.get);
				} else if ('pend' in operation) {
					await this.storageRepo.pend(operation.pend);
				} else if ('commit' in operation) {
					await this.storageRepo.commit(operation.commit);
				} else if ('cancel' in operation) {
					await this.storageRepo.cancel(operation.cancel.actionRef);
				}
			}
		}
		// Don't clear here - will be cleared by shouldPersist = false in the main flow
	}

	private async handleRejection(record: ClusterRecord): Promise<void> {
		// Clean up any resources - will be cleared by shouldPersist = false in the main flow
	}

	private setupTimeouts(record: ClusterRecord): { promiseTimeout?: NodeJS.Timeout; resolutionTimeout?: NodeJS.Timeout } {
		if (!record.message.expiration) {
			return {};
		}

		return {
			promiseTimeout: setTimeout(
				() => this.handleExpiration(record.messageHash),
				record.message.expiration - Date.now()
			),
			resolutionTimeout: setTimeout(
				() => this.resolveWithPeers(record.messageHash),
				record.message.expiration + 5000 - Date.now()
			)
		};
	}

	private hasConflict(record: ClusterRecord): boolean {
		const now = Date.now();
		const staleThresholdMs = 2000; // 2 seconds - allow more time for distributed consensus

		for (const [existingHash, state] of Array.from(this.activeTransactions.entries())) {
			if (existingHash === record.messageHash) {
				continue;
			}

			// Clean up stale transactions that have been around too long
			if (now - state.lastUpdate > staleThresholdMs) {
				log('cluster-member:stale-cleanup', {
					messageHash: existingHash,
					age: now - state.lastUpdate
				});
				this.clearTransaction(existingHash);
				continue;
			}

			if (this.operationsConflict(state.record.message.operations, record.message.operations)) {
				// Use race resolution to determine winner
				const resolution = this.resolveRace(state.record, record);

				if (resolution === 'keep-existing') {
					log('cluster-member:race-keep-existing', {
						existing: existingHash,
						incoming: record.messageHash
					});
					return true; // Reject incoming
				} else {
					// Accept incoming, abort existing
					log('cluster-member:race-accept-incoming', {
						existing: existingHash,
						incoming: record.messageHash
					});
					this.clearTransaction(existingHash);
					continue; // Check other conflicts
				}
			}
		}

		return false; // No blocking conflicts
	}

	/**
	 * Resolve race between two conflicting transactions.
	 * Transaction with more promises wins. If tied, higher hash wins.
	 */
	private resolveRace(existing: ClusterRecord, incoming: ClusterRecord): 'keep-existing' | 'accept-incoming' {
		const existingCount = Object.keys(existing.promises).length;
		const incomingCount = Object.keys(incoming.promises).length;

		// Transaction with more promises wins
		if (existingCount > incomingCount) {
			return 'keep-existing';
		}
		if (incomingCount > existingCount) {
			return 'accept-incoming';
		}

		// Tie-breaker: higher message hash wins (deterministic)
		return existing.messageHash > incoming.messageHash ? 'keep-existing' : 'accept-incoming';
	}

	private operationsConflict(ops1: RepoMessage['operations'], ops2: RepoMessage['operations']): boolean {
		// Check if one is a commit for the same action as a pend - these don't conflict
		const actionId1 = this.getActionId(ops1);
		const actionId2 = this.getActionId(ops2);
		if (actionId1 && actionId2 && actionId1 === actionId2) {
			// Same action - commit is resolving the pend, not conflicting
			return false;
		}

		const blocks1 = new Set(this.getAffectedBlockIds(ops1));
		const blocks2 = new Set(this.getAffectedBlockIds(ops2));

		for (const block of Array.from(blocks1)) {
			if (blocks2.has(block)) {
				log('cluster-member:conflict-detected', {
					blocks1: Array.from(blocks1),
					blocks2: Array.from(blocks2),
					conflictingBlock: block
				});
				return true;
			}
		}

		return false;
	}

	private getActionId(operations: RepoMessage['operations']): string | undefined {
		for (const operation of operations) {
			if ('pend' in operation) {
				return operation.pend.actionId;
			} else if ('commit' in operation) {
				return operation.commit.actionId;
			} else if ('cancel' in operation) {
				return operation.cancel.actionRef.actionId;
			}
		}
		return undefined;
	}

	private getAffectedBlockIds(operations: RepoMessage['operations']): string[] {
		const blockIds = new Set<string>();

		for (const operation of operations) {
			if ('get' in operation) {
				operation.get.blockIds.forEach(id => blockIds.add(id));
			} else if ('pend' in operation) {
				// Use blockIdsForTransforms to correctly extract block IDs from Transforms structure
				blockIdsForTransforms(operation.pend.transforms).forEach(id => blockIds.add(id));
			} else if ('commit' in operation) {
				operation.commit.blockIds.forEach(id => blockIds.add(id));
			} else if ('cancel' in operation) {
				operation.cancel.actionRef.blockIds.forEach(id => blockIds.add(id));
			}
		}

		return Array.from(blockIds);
	}

	private async propagateIfNeeded(record: ClusterRecord): Promise<void> {
		const promises = [];
		for (const [peerId, peer] of Object.entries(record.peers)) {
			if (peerId === this.peerId.toString()) continue;

			try {
				const client = ClusterClient.create(peerIdFromString(peerId), this.peerNetwork, this.protocolPrefix);
				promises.push(client.update(record));
			} catch (error) {
				console.error(`Failed to propagate to peer ${peerId}:`, error);
			}
		}
		await Promise.allSettled(promises);
	}

	private async handleExpiration(messageHash: string): Promise<void> {
		const state = this.activeTransactions.get(messageHash);
		if (!state) return;

		if (!state.record.promises[this.peerId.toString()]) {
			const signature: Signature = {
				type: 'reject',
				signature: 'rejected',
				rejectReason: 'Transaction expired'
			};

			const updatedRecord = {
				...state.record,
				promises: {
					...state.record.promises,
					[this.peerId.toString()]: signature
				}
			};

			this.activeTransactions.set(messageHash, {
				...state,
				record: updatedRecord
			});

			await this.propagateIfNeeded(updatedRecord);
		}
	}

	private async resolveWithPeers(messageHash: string): Promise<void> {
		// This method is disabled - the coordinator handles all retry logic
		// Keeping the skeleton in case we need peer-initiated recovery in the future
		log('cluster-member:resolve-skipped', { messageHash, reason: 'coordinator-handles-retry' });
	}

	private queueExpiredTransactions(): void {
		const now = Date.now();
		for (const [messageHash, state] of Array.from(this.activeTransactions.entries())) {
			if (state.record.message.expiration && state.record.message.expiration < now) {
				this.cleanupQueue.push(messageHash);
			}
		}
	}

	private async processCleanupQueue(): Promise<void> {
		while (this.cleanupQueue.length > 0) {
			const messageHash = this.cleanupQueue.shift();
			if (!messageHash) continue;

			const state = this.activeTransactions.get(messageHash);
			if (!state) continue;

			const phase = await this.getTransactionPhase(state.record);
			if (phase !== TransactionPhase.Consensus && phase !== TransactionPhase.Rejected) {
				this.activeTransactions.delete(messageHash);
			}
		}
	}

	private hasLocalCommit(record: ClusterRecord): boolean {
		const ourId = this.peerId.toString();
		return Boolean(record.commits[ourId]);
	}

	private clearTransaction(messageHash: string): void {
		const state = this.activeTransactions.get(messageHash);
		if (!state) {
			log('cluster-member:clear-miss', { messageHash });
			return;
		}
		if (state.promiseTimeout) {
			clearTimeout(state.promiseTimeout);
		}
		if (state.resolutionTimeout) {
			clearTimeout(state.resolutionTimeout);
		}
		this.activeTransactions.delete(messageHash);
		log('cluster-member:clear-done', {
			messageHash,
			remaining: Array.from(this.activeTransactions.keys())
		});
	}
}

