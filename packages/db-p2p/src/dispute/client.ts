import type { PeerId, IPeerNetwork } from '@optimystic/db-core';
import { ProtocolClient } from '../protocol-client.js';
import { DEFAULT_DIAL_TIMEOUT_MS, withRpcDeadlineDefaults, type RpcDeadlineOptions } from '../rpc-deadline.js';
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
		// Preserve the existing `timeoutMs`→`signal` contract callers rely on. Post the
		// processMessage response-deadline work, this `signal` now tears down the
		// *response read* (not merely the dial) — the desired "give up on a silent
		// arbitrator" behavior. Also apply the default dial cap so a challenge to an
		// unreachable arbitrator fails the dial fast even when no `timeoutMs` is given;
		// this does not alter the response semantics (still bounded only by the signal).
		const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
		const response = await this.processMessage<{ type: 'vote'; vote: ArbitrationVote }>(
			message,
			this.protocol,
			{ signal, dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS }
		);
		return response.vote;
	}

	/** Send a resolution to a peer (broadcast) */
	async sendResolution(resolution: DisputeResolution, options?: RpcDeadlineOptions): Promise<void> {
		const message: DisputeMessage = { type: 'resolution', resolution };
		// This is a broadcast/ack, so the response cap is what matters: a peer that
		// connects but never acks must not hang the broadcast. Absent keys default.
		await this.processMessage<{ type: 'ack' }>(
			message,
			this.protocol,
			withRpcDeadlineDefaults(options),
		);
	}
}
