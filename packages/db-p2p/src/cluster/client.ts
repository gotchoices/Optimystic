import type { PeerId, IPeerNetwork, ICluster, ClusterRecord } from '@optimystic/db-core';
import { blockIdToBytes, blockIdsForTransforms } from '@optimystic/db-core';
import { ProtocolClient } from '../protocol-client.js';
import { peerIdFromString } from '@libp2p/peer-id';
import { isClusterErrorEnvelope, clusterErrorFromEnvelope } from './cluster-error.js';
import type { RedirectPayload } from '../repo/redirect.js';
import { withRpcDeadlineDefaults, type RpcDeadlineOptions } from '../rpc-deadline.js';
import { MAX_CONTROL_MESSAGE_BYTES } from '../protocol-limits.js';

export class ClusterClient extends ProtocolClient implements ICluster {
	private constructor(peerId: PeerId, peerNetwork: IPeerNetwork, readonly protocolPrefix?: string) {
		super(peerId, peerNetwork);
	}

	/** Create a new client instance */
	public static create(peerId: PeerId, peerNetwork: IPeerNetwork, protocolPrefix?: string): ClusterClient {
		return new ClusterClient(peerId, peerNetwork, protocolPrefix);
	}

	async update(record: ClusterRecord, hop: number = 0, options?: RpcDeadlineOptions): Promise<ClusterRecord> {
		const message = {
			operation: 'update',
			record
		};
		// Every node registers the cluster service under its network-prefixed
		// protocol id (`/optimystic/<network>/cluster/1.0.0`); the bare
		// `/db-p2p/cluster/1.0.0` is never registered, so there is no legacy
		// fallback to attempt — a single dial whose error propagates directly.
		const protocol = (this.protocolPrefix ?? '/db-p2p') + '/cluster/1.0.0';
		// Apply the client-level dial/response deadline so a silent cluster peer
		// can't hang the coordinator forever; an explicit caller override wins.
		// Response is a ClusterRecord (peer set + signatures + small metadata) → control cap.
		const response = await this.processMessage<unknown>(message, protocol, { ...withRpcDeadlineDefaults(options), maxDataLength: MAX_CONTROL_MESSAGE_BYTES });

		// A member that threw inside `update` replies with a structured error
		// envelope rather than aborting the stream; rethrow the server's real
		// error (preserving name/code) so the coordinator sees the true cause.
		if (isClusterErrorEnvelope(response)) {
			throw clusterErrorFromEnvelope(response);
		}

		// Type the redirect branch against the payload the service actually produces
		// (`RedirectPayload`), not a hand-written narrower shape — the old `{ id: string }`
		// literal is what structurally discarded the `addrs` the sender took the trouble to embed.
		const redirectResponse = response as Partial<RedirectPayload>;
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
			// Learn the redirect target's addresses BEFORE dialing it: the redirect is the only
			// notice we get that this peer matters, and if it is relay-only we have no address
			// for it at all. Merging after the dial would help only some later hop.
			this.peerNetwork.recordPeerAddresses?.(nextId, next.addrs ?? [])
			await this.recordCoordinatorForRecordIfSupported(record, nextId)
			const nextClient = ClusterClient.create(nextId, this.peerNetwork, this.protocolPrefix)
			// Thread the caller's *original* options through the redirect hop (the
			// recursive call re-applies its own defaults) so the deadline survives a redirect.
			return await nextClient.update(record, hop + 1, options)
		}
		const updated = response as ClusterRecord;
		// The member's reply carries the cohort's peer map too, and it may name addresses this
		// node lacks — the coordinator's own half of the same exchange the service handles inbound.
		this.recordRecordPeerAddresses(updated)
		return updated;
	}

	/**
	 * Offer every address a cluster record carries for its cohort to the dialer's address book.
	 * Self and unparseable ids are dropped here; validation, the per-peer cap, and the trust
	 * boundary live in the implementation behind `recordPeerAddresses`.
	 */
	private recordRecordPeerAddresses(record: ClusterRecord): void {
		const sink = this.peerNetwork.recordPeerAddresses
		if (!sink) return
		// No self-filter here: `this.peerId` is the peer we DIALED, not this node. The sink owns
		// the self-skip, since only it knows the local node's identity.
		for (const [idStr, peer] of Object.entries(record?.peers ?? {})) {
			const addrs = peer?.multiaddrs ?? []
			if (addrs.length === 0) continue
			let pid: PeerId
			try {
				pid = peerIdFromString(idStr)
			} catch {
				// A cohort id we cannot parse is not dialable by any route; the consensus path
				// below already surfaces the resulting membership failure, so skip it here.
				continue
			}
			sink.call(this.peerNetwork, pid, addrs)
		}
	}

  /**
   * Record a coordinator-affinity hint for the block this record's op is
   * coordinated on, so a follow-up op can dial `peerId` directly.
   *
   * The op lives at `record.message.operations[0]` — `record.message` is a
   * RepoMessage `{ operations: [...] }`, NOT a bare `{ commit }`/`{ pend }`.
   * Reading `record.message.commit`/`.pend` (the old code) always saw
   * `undefined`, so this hint was dead code and never recorded anything.
   *
   * The key is `blockIdToBytes(<the coordinated block id>)` — the sha256 digest
   * findCoordinator/recordCoordinator key the cache on — NOT raw utf8 of the id
   * (which would never be retrieved). Commit anchors on blockIds[0] (where
   * CoordinatorRepo runs consensus + verifyResponsibility), not tailId. Pend
   * anchors on a real block id (blockIdsForTransforms), not a structural
   * transforms field name. ClusterClient only ever carries commit/pend.
   */
  private async recordCoordinatorForRecordIfSupported(record: ClusterRecord, peerId: PeerId): Promise<void> {
    const op = record.message.operations[0]
    if (!op) return
    let id: string | undefined
    if ('commit' in op) id = op.commit.blockIds[0]
    else if ('pend' in op) id = blockIdsForTransforms(op.pend.transforms)[0]
    if (id == null) return
    const kbytes = await blockIdToBytes(id)
    const pn: any = this.peerNetwork as any
    if (typeof pn?.recordCoordinator === 'function') pn.recordCoordinator(kbytes, peerId)
  }
}
