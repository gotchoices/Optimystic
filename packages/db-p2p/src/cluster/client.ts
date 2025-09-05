import { type PeerId } from '@libp2p/interface';
import type { IPeerNetwork, ICluster, ClusterRecord } from '@optimystic/db-core';
import { ProtocolClient } from '../protocol-client.js';
import { peerIdFromString } from '@libp2p/peer-id';

export class ClusterClient extends ProtocolClient implements ICluster {
	private constructor(peerId: PeerId, peerNetwork: IPeerNetwork, readonly protocolPrefix?: string) {
		super(peerId, peerNetwork);
	}

	/** Create a new client instance */
	public static create(peerId: PeerId, peerNetwork: IPeerNetwork): ClusterClient {
		return new ClusterClient(peerId, peerNetwork);
	}

  async update(record: ClusterRecord, hop: number = 0): Promise<ClusterRecord> {
		const message = {
			operation: 'update',
			record
		};
    const response = await this.processMessage<any>(
      message,
      (this.protocolPrefix ?? '/db-p2p') + '/cluster/1.0.0'
    );
    if (response?.redirect?.peers?.length) {
      if (hop >= 2) {
        throw new Error('Redirect loop detected in ClusterClient (max hops reached)')
      }
      const currentIdStr = this.peerId.toString()
      const next = response.redirect.peers.find((p: any) => p.id !== currentIdStr) ?? response.redirect.peers[0]
      const nextId = peerIdFromString(next.id)
      if (next.id === currentIdStr) {
        throw new Error('Redirect loop detected in ClusterClient (same peer)')
      }
      this.recordCoordinatorForRecordIfSupported(record, nextId)
      const nextClient = ClusterClient.create(nextId, this.peerNetwork)
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
