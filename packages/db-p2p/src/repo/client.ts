import type {
	IRepo, GetBlockResults, PendSuccess, StaleFailure, ActionBlocks, MessageOptions, CommitResult,
	PendRequest, CommitRequest, BlockGets, IPeerNetwork, PeerId
} from "@optimystic/db-core";
import type { RepoMessage } from "@optimystic/db-core";
import { blockIdsForTransforms, blockIdToBytes } from "@optimystic/db-core";
import { ProtocolClient } from "../protocol-client.js";
import { MAX_BLOCK_MESSAGE_BYTES } from "../protocol-limits.js";
import { peerIdFromString } from "@libp2p/peer-id";

export class RepoClient extends ProtocolClient implements IRepo {
	private constructor(peerId: PeerId, peerNetwork: IPeerNetwork, readonly protocolPrefix?: string) {
		super(peerId, peerNetwork);
	}

	/** Create a new client instance */
	public static create(peerId: PeerId, peerNetwork: IPeerNetwork, protocolPrefix?: string): RepoClient {
		return new RepoClient(peerId, peerNetwork, protocolPrefix);
	}

	async get(blockGets: BlockGets, options: MessageOptions): Promise<GetBlockResults> {
		return this.processRepoMessage<GetBlockResults>(
			[{ get: blockGets }],
			options
		);
	}

	async pend(request: PendRequest, options: MessageOptions): Promise<PendSuccess | StaleFailure> {
		return this.processRepoMessage<PendSuccess | StaleFailure>(
			[{ pend: request }],
			options
		);
	}

	async cancel(actionRef: ActionBlocks, options: MessageOptions): Promise<void> {
		return this.processRepoMessage<void>(
			[{ cancel: { actionRef } }],
			options
		);
	}

	async commit(request: CommitRequest, options: MessageOptions): Promise<CommitResult> {
		return this.processRepoMessage<CommitResult>(
			[{ commit: request }],
			options
		);
	}

	private extractCorrelationId(operations: RepoMessage['operations']): string | undefined {
		const op = operations[0];
		if (!op) return undefined;
		if ('pend' in op) return op.pend.actionId;
		if ('commit' in op) return op.commit.actionId;
		if ('cancel' in op) return op.cancel.actionRef.actionId;
		return undefined;
	}

	private async processRepoMessage<T>(
		operations: RepoMessage['operations'],
		options: MessageOptions,
		hop: number = 0
	): Promise<T> {
		const message: RepoMessage = {
			operations,
			expiration: options.expiration,
		};
		const correlationId = this.extractCorrelationId(operations);
		const deadline = options.expiration ?? (Date.now() + 30_000)
		const deadlineMs = Math.max(1, deadline - Date.now())
		const preferred = (this.protocolPrefix ?? '/db-p2p') + '/repo/1.0.0'

		// Drive the remaining `expiration` budget through an AbortController whose
		// abort *reason* is the caller-facing `'RepoClient timeout'` Error, combined
		// with any caller signal. processMessage forwards `signal` to both the dial
		// and the response-read and calls `stream.abort(signal.reason)` on abort, so —
		// unlike the old `Promise.race`, whose losing branch left the inner read
		// running and leaked a pending read + stream on every timed-out RPC to a silent
		// peer — the deadline now genuinely cancels the inner read while the caller
		// still observes an error whose `.message === 'RepoClient timeout'`.
		//
		// Intentionally no `responseTimeoutMs`: the combined signal already bounds the
		// read at `deadlineMs`. A second, shorter cap would surface as
		// ResponseTimeoutError and mask the caller-facing 'RepoClient timeout' message.
		const deadlineController = new AbortController()
		const timer = setTimeout(
			() => deadlineController.abort(new Error('RepoClient timeout')),
			deadlineMs
		)
		const combinedSignal = options?.signal
			? AbortSignal.any([options.signal, deadlineController.signal])
			: deadlineController.signal
		let response: any
		try {
			response = await super.processMessage<any>(message, preferred, {
				signal: combinedSignal,
				correlationId,
				dialTimeoutMs: options?.dialTimeoutMs,
				// A get response carries block data → block cap (not control).
				maxDataLength: MAX_BLOCK_MESSAGE_BYTES,
			})
		} finally {
			clearTimeout(timer)
		}

		if (response?.redirect?.peers?.length) {
			if (hop >= 2) {
				throw new Error('Redirect loop detected in RepoClient (max hops reached)')
			}
			const currentIdStr = this.peerId.toString()
			const next = response.redirect.peers.find((p: any) => p.id !== currentIdStr) ?? response.redirect.peers[0]
			const nextId = peerIdFromString(next.id)
			if (next.id === currentIdStr) {
				throw new Error('Redirect loop detected in RepoClient (same peer)')
			}
			// cache hint — await so the recorded key bytes match what findCoordinator
			// later looks up (blockIdToBytes is async); deterministic ordering also
			// keeps the hint testable. The redirect retry below is async anyway.
			await this.recordCoordinatorForOpsIfSupported(operations, nextId)
			// single-hop retry against target peer using repo protocol
			const nextClient = RepoClient.create(nextId, this.peerNetwork, this.protocolPrefix)
			return await nextClient.processRepoMessage<T>(operations, options, hop + 1)
		}
		return response as T;
	}

	private async extractKeyFromOperations(ops: RepoMessage['operations']): Promise<Uint8Array | undefined> {
		const op = ops[0];
		// The recorded key MUST be the sha256 digest produced by blockIdToBytes — the
		// exact bytes findCoordinator/recordCoordinator key the coordinator cache on
		// (NetworkTransactor passes blockIdToBytes(blockId)). Raw utf8 of the id would
		// never match, so the hint would silently never be retrieved.
		if ('get' in op) {
			const id = op.get.blockIds[0];
			return id ? await blockIdToBytes(id) : undefined;
		}
		if ('pend' in op) {
			// Key on a real block id the pend touches, NOT a structural transforms field
			// name ('inserts'/'updates'/'deletes'); see RepoService.deriveBlockKey.
			const id = blockIdsForTransforms(op.pend.transforms)[0];
			return id ? await blockIdToBytes(id) : undefined;
		}
		if ('commit' in op) {
			// Anchor on blockIds[0] (where CoordinatorRepo.commit runs consensus +
			// verifyResponsibility), NOT tailId — they differ for a non-tail batch.
			const id = op.commit.blockIds[0];
			return id ? await blockIdToBytes(id) : undefined;
		}
		if ('cancel' in op) {
			const id = op.cancel.actionRef.blockIds[0];
			return id ? await blockIdToBytes(id) : undefined;
		}
		return undefined;
	}

	private async recordCoordinatorForOpsIfSupported(ops: RepoMessage['operations'], peerId: PeerId): Promise<void> {
		const keyBytes = await this.extractKeyFromOperations(ops)
		const pn: any = this.peerNetwork as any
		if (keyBytes != null && typeof pn?.recordCoordinator === 'function') {
			pn.recordCoordinator(keyBytes, peerId)
		}
	}

}
