import type { PeerId, IPeerNetwork, ICluster, ClusterRecord } from '@optimystic/db-core';
import { ProtocolClient } from '../protocol-client.js';
import { peerIdFromString } from '@libp2p/peer-id';
import { isClusterErrorEnvelope, clusterErrorFromEnvelope } from './cluster-error.js';

export class ClusterClient extends ProtocolClient implements ICluster {
	private constructor(peerId: PeerId, peerNetwork: IPeerNetwork, readonly protocolPrefix?: string) {
		super(peerId, peerNetwork);
	}

	/** Create a new client instance */
	public static create(peerId: PeerId, peerNetwork: IPeerNetwork, protocolPrefix?: string): ClusterClient {
		return new ClusterClient(peerId, peerNetwork, protocolPrefix);
	}

	async update(record: ClusterRecord, hop: number = 0): Promise<ClusterRecord> {
		const message = {
			operation: 'update',
			record
		};
		// Every node registers the cluster service under its network-prefixed
		// protocol id (`/optimystic/<network>/cluster/1.0.0`); the bare
		// `/db-p2p/cluster/1.0.0` is never registered, so there is no legacy
		// fallback to attempt — a single dial whose error propagates directly.
		const protocol = (this.protocolPrefix ?? '/db-p2p') + '/cluster/1.0.0';
		const response = await this.processMessage<unknown>(message, protocol);

		// A member that threw inside `update` replies with a structured error
		// envelope rather than aborting the stream; rethrow the server's real
		// error (preserving name/code) so the coordinator sees the true cause.
		if (isClusterErrorEnvelope(response)) {
			throw clusterErrorFromEnvelope(response);
		}

		const redirectResponse = response as { redirect?: { peers?: Array<{ id: string }> } };
		if (redirectResponse?.redirect?.peers?.length) {
			if (hop >= 2) {
				throw new Error('Redirect loop detected in ClusterClient (max hops reached)')
			}
			const currentIdStr = this.peerId.toString()
			const next = redirectResponse.redirect.peers.find((p) => p.id !== currentIdStr) ?? redirectResponse.redirect.peers[0]!
			const nextId = peerIdFromString(next.id)
			if (next.id === currentIdStr) {
				throw new Error('Redirect loop detected in ClusterClient (same peer)')
			}
			this.recordCoordinatorForRecordIfSupported(record, nextId)
			const nextClient = ClusterClient.create(nextId, this.peerNetwork, this.protocolPrefix)
			return await nextClient.update(record, hop + 1)
		}
		return response as ClusterRecord;
	}

  private recordCoordinatorForRecordIfSupported(record: ClusterRecord, peerId: PeerId): void {
    const rmsg: any = (record as any)?.message
    let tailId: string | undefined
    if (rmsg?.commit?.tailId) tailId = rmsg.commit.tailId
    else if (rmsg?.pend?.transforms) {
      const keys = Object.keys(rmsg.pend.transforms)
      if (keys.length > 0) tailId = keys[0]
    }
    if (tailId) {
      const kbytes = new TextEncoder().encode(tailId)
      const pn: any = this.peerNetwork as any
      if (typeof pn?.recordCoordinator === 'function') pn.recordCoordinator(kbytes, peerId)
    }
  }
}
