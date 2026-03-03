import type { PeerId, IPeerNetwork } from '@optimystic/db-core';
import { ProtocolClient } from '../protocol-client.js';
import type { DisputeChallenge, DisputeResolution, ArbitrationVote, DisputeMessage } from './types.js';

/**
 * Client for the dispute protocol. Sends challenges to arbitrators
 * and broadcasts resolutions.
 */
export class DisputeClient extends ProtocolClient {
	private readonly protocol: string;

	constructor(peerId: PeerId, peerNetwork: IPeerNetwork, protocolPrefix?: string) {
		super(peerId, peerNetwork);
		this.protocol = (protocolPrefix ?? '/db-p2p') + '/dispute/1.0.0';
	}

	static create(peerId: PeerId, peerNetwork: IPeerNetwork, protocolPrefix?: string): DisputeClient {
		return new DisputeClient(peerId, peerNetwork, protocolPrefix);
	}

	/** Send a challenge to an arbitrator and get their vote */
	async sendChallenge(challenge: DisputeChallenge, timeoutMs?: number): Promise<ArbitrationVote> {
		const message: DisputeMessage = { type: 'challenge', challenge };
		const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
		const response = await this.processMessage<{ type: 'vote'; vote: ArbitrationVote }>(
			message,
			this.protocol,
			{ signal }
		);
		return response.vote;
	}

	/** Send a resolution to a peer (broadcast) */
	async sendResolution(resolution: DisputeResolution): Promise<void> {
		const message: DisputeMessage = { type: 'resolution', resolution };
		await this.processMessage<{ type: 'ack' }>(
			message,
			this.protocol,
		);
	}
}
