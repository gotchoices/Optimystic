import type { PeerId } from '@libp2p/interface';
import type { IPeerNetwork } from '@optimystic/db-core';
import { ProtocolClient } from '../protocol-client.js';
import { buildSyncProtocol, type SyncRequest, type SyncResponse } from './protocol.js';
import { withRpcDeadlineDefaults, type RpcDeadlineOptions } from '../rpc-deadline.js';

/**
 * Client for sending sync requests to remote peers.
 *
 * Used by storage tiers to request missing blocks from other nodes in the network.
 * Extends ProtocolClient for consistent error handling and timeout behavior.
 */
export class SyncClient extends ProtocolClient {
	private readonly protocol: string;

	constructor(
		peerId: PeerId,
		peerNetwork: IPeerNetwork,
		protocolPrefix: string = ''
	) {
		super(peerId, peerNetwork);
		this.protocol = buildSyncProtocol(protocolPrefix);
	}

	/**
	 * Request a block from the remote peer.
	 *
	 * @param request - Sync request specifying block and options
	 * @param options - Optional per-call deadlines/cancellation. Absent keys fall
	 *   back to the client-level defaults so a silent peer can't hang the caller.
	 * @returns Response with archive if successful
	 * @throws Error if request fails or times out
	 */
	async requestBlock(request: SyncRequest, options?: RpcDeadlineOptions): Promise<SyncResponse> {
		return await this.processMessage<SyncResponse>(request, this.protocol, withRpcDeadlineDefaults(options));
	}

	/**
	 * Get the protocol string used by this client.
	 */
	getProtocol(): string {
		return this.protocol;
	}
}

