import { peerIdFromString } from "@libp2p/peer-id";
import type { ClusterRecord, IKeyNetwork, RepoMessage, BlockId, ClusterPeers, MessageOptions, Signature } from "@optimystic/db-core";
import { base58btc } from "multiformats/bases/base58";
import { sha256 } from "multiformats/hashes/sha2";
import { ClusterClient } from "../cluster/client.js";
import { Pending } from "@optimystic/db-core";
import type { PeerId } from "@libp2p/interface";
import { createLogger } from '../logger.js'

const log = createLogger('cluster')

/**
 * Manages the state of cluster transactions for a specific block ID
 */
interface ClusterTransactionState {
	messageHash: string;
	record: ClusterRecord;
	pending: Pending<ClusterRecord>;
	lastUpdate: number;
	promiseTimeout?: NodeJS.Timeout;
	resolutionTimeout?: NodeJS.Timeout;
}

/** Manages distributed transactions across clusters */
export class ClusterCoordinator {
	// TODO: move this into a state management interface so that transaction state can be persisted
	private transactions: Map<string, ClusterTransactionState> = new Map();

	constructor(
		private readonly keyNetwork: IKeyNetwork,
		private readonly createClusterClient: (peerId: PeerId) => ClusterClient,
		private readonly cfg: { clusterSize: number; allowClusterDownsize: boolean; clusterSizeTolerance: number }
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
			return await this.keyNetwork.findCluster(blockIdBytes);
		} catch (e) {
			log('WARN findCluster failed for %s: %o', blockId, e)
			return {} as ClusterPeers
		}
	}

	private makeRecord(peers: ClusterPeers, messageHash: string, message: RepoMessage): ClusterRecord {
		const peerCount = Object.keys(peers ?? {}).length;
		return {
			messageHash,
			peers,
			message,
			promises: {},
			commits: {},
			suggestedClusterSize: peerCount || undefined,
			minRequiredSize: this.cfg.allowClusterDownsize ? undefined : this.cfg.clusterSize
		};
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

		// Wait for the transaction to complete
		return await pending.result().finally(() => {
			log('cluster-tx:complete', { messageHash });
		});
	}

	/**
	 * Executes the full transaction process
	 */
	private async executeTransaction(peers: ClusterPeers, record: ClusterRecord): Promise<ClusterRecord> {
		const peerCount = Object.keys(peers).length;
		if (!this.cfg.allowClusterDownsize && peerCount < this.cfg.clusterSize) {
			log('cluster-tx:reject-downsize', { peerCount, required: this.cfg.clusterSize });
			throw new Error(`Cluster size ${peerCount} below configured minimum ${this.cfg.clusterSize}`);
		}
		const promised = await this.collectPromises(peers, record);
		const majority = Math.floor(peerCount / 2) + 1;
		if (peerCount > 1 && Object.keys(promised.record.promises).length < majority) {
			log('cluster-tx:majority-failed', {
				messageHash: record.messageHash,
				peerCount,
				promises: Object.keys(promised.record.promises).length,
				majority
			});
			throw new Error(`Failed to get majority consensus for transaction ${record.messageHash}`);
		}
		return await this.commitTransaction(promised.record);
	}

	async getClusterSize(blockId: BlockId): Promise<number> {
		const peers = await this.getClusterForBlock(blockId);
		return Object.keys(peers ?? {}).length;
	}

	/**
	 * Collects promises from all peers in the cluster
	 */
	private async collectPromises(peers: ClusterPeers, record: ClusterRecord): Promise<{ record: ClusterRecord }> {
		// For each peer, create a client and request a promise
		const promiseRequests = Object.keys(peers).map(peerIdStr => {
			const peerIdObj = peerIdFromString(peerIdStr);
			const client = this.createClusterClient(peerIdObj);
			log('cluster-tx:promise-request', { messageHash: record.messageHash, peerId: peerIdStr });
			const promise = client.update(record);
			return new Pending(promise);
		});

		// Wait for all promises to complete
		const results = await Promise.all(promiseRequests.map((p, idx) => p.result().then(res => {
			const peerIdStr = Object.keys(peers)[idx]!;
			log('cluster-tx:promise-response', { messageHash: record.messageHash, peerId: peerIdStr, success: true });
			return res;
		}).catch(err => {
			const peerIdStr = Object.keys(peers)[idx]!;
			log('cluster-tx:promise-response', { messageHash: record.messageHash, peerId: peerIdStr, success: false, error: err });
			return null;
		})));

		// Merge all promises into the record
		for (const result of results.filter(Boolean) as ClusterRecord[]) {
			if (typeof record.suggestedClusterSize === 'number' && typeof result.suggestedClusterSize === 'number') {
				const expected = result.suggestedClusterSize;
				const actual = Object.keys(peers).length;
				const maxDiff = Math.ceil(Math.max(1, expected * this.cfg.clusterSizeTolerance));
				if (Math.abs(actual - expected) > maxDiff) {
					log('cluster-tx:size-variance', { expected, actual, tolerance: this.cfg.clusterSizeTolerance });
				}
			}
			record.promises = { ...record.promises, ...result.promises };
		}
		return { record };
	}

	/**
	 * Commits the transaction to all peers in the cluster
	 */
	private async commitTransaction(record: ClusterRecord): Promise<ClusterRecord> {
		// For each peer, create a client and send the commit
		const peerIds = Object.keys(record.peers);
		const commitRequests = peerIds.map(peerIdStr => {
			const peerIdObj = peerIdFromString(peerIdStr);
			const client = this.createClusterClient(peerIdObj);
			log('cluster-tx:commit-request', { messageHash: record.messageHash, peerId: peerIdStr });
			const promise = client.update({
				...record,
				// Add our commit signature
				commits: { ...record.commits, self: 'signature' as unknown as Signature }
			});
			return new Pending(promise);
		});

		// Wait for all commits to complete
		const results = await Promise.all(commitRequests.map((p, idx) => p.result().then(res => {
			const peerIdStr = peerIds[idx]!;
			log('cluster-tx:commit-response', { messageHash: record.messageHash, peerId: peerIdStr, success: true });
			return res;
		}).catch(err => {
			const peerIdStr = peerIds[idx]!;
			log('cluster-tx:commit-response', { messageHash: record.messageHash, peerId: peerIdStr, success: false, error: err });
			return null;
		})));

		// Merge all commits into the record
		for (const result of results.filter(Boolean) as ClusterRecord[]) {
			record.commits = { ...record.commits, ...result.commits };
		}
		return record;
	}
}
