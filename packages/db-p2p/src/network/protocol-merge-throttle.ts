/**
 * Lets at most one per-stream protocol merge per (peer, protocol) reach the libp2p peerStore per
 * interval.
 *
 * libp2p (3.3.11) records the protocol of every stream it negotiates in the remote peer's peerStore
 * record, on both ends: `peerStore.merge(remotePeer, { protocols: [protocol] })` in
 * `Connection.newStream` and in `onIncomingStream` (`libp2p/dist/src/connection.js`). The merge in
 * `@libp2p/peer-store` always takes the peer's write lock, decodes the record, rebuilds it twice,
 * re-sorts its addresses and writes it back, even when the protocol is already recorded: 59 µs per
 * merge with 2 addresses and 246 µs with 8 (desktop, in-memory datastore), and about 7% of the
 * JavaScript thread on a Galaxy S7 (GitHub #40). The connection monitor alone opens a
 * `/ipfs/ping/1.0.0` stream every 10 s per connection, so that is six merges a minute per connection
 * on each end before any request of ours.
 *
 * What those merges keep fresh. Each merge that reaches the store stamps the record's `updated`, and
 * the store evicts a record on read once `updated` is over `maxPeerAge` (6 h) old and no address was
 * observed within `maxAddressAge` (1 h). On a long-lived connection the per-stream merges, chiefly
 * the monitor's pings, are what refresh `updated`. Under the throttle a pair that keeps opening
 * streams still reaches the store once per interval, so `updated` is never more than one interval
 * staler than it was, far inside the 6 h.
 *
 * Behaviour change: a protocol that identify removes from a record within the interval is put back by
 * a later stream up to one interval later instead of at once. That re-add is also the path by which a
 * stranger puts this network's protocols into its own record (docs/internals.md §Network Membership
 * Predicate), so delaying it loses nothing.
 *
 * Remove on upgrade. libp2p/js-libp2p#3692 merges each protocol once per connection and keeps
 * `updated` fresh from the connection itself. On the libp2p release that carries it,
 * `test/libp2p-merges-protocol-per-stream.spec.ts` fails, which is the signal to delete this module
 * and its installation in `createLibp2pNodeBase`. The same spec fails if libp2p stops making this
 * call through `peerStore.merge` in this shape, which would otherwise bypass the throttle silently.
 *
 * Imports here are type-only or pure: `libp2p-node-base.ts` is reachable from the react-native entry.
 */

import type { AbortOptions, Peer, PeerData, PeerId, PeerStore } from '@libp2p/interface';
import { LruMap } from '@optimystic/db-core';
import { createLogger } from '../logger.js';

const log = createLogger('protocol-merge-throttle');

/** How often one (peer, protocol) pair's per-stream merge may reach the peerStore. */
export const PROTOCOL_MERGE_INTERVAL_MS = 60_000;

/** How many peers' merge times are remembered; a forgotten peer's next merge reaches the store. */
export const PROTOCOL_MERGE_TRACKED_PEERS = 256;

/** The data libp2p's per-stream merge passes: one key, `protocols`, naming one protocol. */
export interface ProtocolOnlyMerge extends PeerData {
	protocols: [string];
}

/**
 * Whether `data` is the per-stream merge's shape. Every other merge (identify's, the dial queue's,
 * circuit relay's, `peer-address-book.ts`'s address merges) carries other keys or more protocols and
 * goes straight through.
 */
export function isProtocolOnlyMerge(data: PeerData): data is ProtocolOnlyMerge {
	const keys = Object.keys(data);
	return keys.length === 1 && keys[0] === 'protocols' && data.protocols?.length === 1 && typeof data.protocols[0] === 'string';
}

export interface ProtocolMergeThrottleOptions {
	/** Default {@link PROTOCOL_MERGE_INTERVAL_MS}. */
	intervalMs?: number;
	/** Default {@link PROTOCOL_MERGE_TRACKED_PEERS}. */
	maxPeers?: number;
	/** The clock; `Date.now` when omitted. */
	now?: () => number;
}

/** The slice of the peerStore the throttle wraps. */
export type ThrottledPeerStore = Pick<PeerStore, 'merge' | 'delete'>;

interface PeerMerges {
	/** Per protocol, when its last merge that reached the store resolved. */
	readonly reachedAt: Map<string, number>;
	/** What the most recent of those merges returned. */
	peer: Peer;
}

/**
 * Wrap `peerStore.merge` so a per-stream protocol merge ({@link isProtocolOnlyMerge}) reaches the
 * store at most once per interval per (peer, protocol). The first merge for a pair always reaches
 * it, so a protocol is recorded at its first stream as before. A merge inside the interval resolves
 * without touching the store, to the `Peer` the peer's most recent real merge returned; libp2p's
 * callers ignore the value. A merge that rejects records nothing, so the next stream retries.
 *
 * `peerStore.delete` is wrapped too, to forget the peer, so a deleted record is re-created by the
 * next stream. libp2p 3 dispatches no event for a deletion, and FRET deletes records. A record the
 * store evicts on read needs nothing: eviction needs `updated` over 6 h old, and the last real merge
 * stamped it, so the interval has long run out.
 *
 * Install once, before `node.start()`, on the object libp2p's connections call through:
 * `node.peerStore` is `components.peerStore` (`configureComponent` assigns and returns it). No timer,
 * so nothing to tear down.
 */
export function throttleProtocolMerges(peerStore: ThrottledPeerStore, options: ProtocolMergeThrottleOptions = {}): void {
	const intervalMs = options.intervalMs ?? PROTOCOL_MERGE_INTERVAL_MS;
	const now = options.now ?? Date.now;
	const peers = new LruMap<string, PeerMerges>(options.maxPeers ?? PROTOCOL_MERGE_TRACKED_PEERS);
	const merge = peerStore.merge;
	const remove = peerStore.delete;

	const recentMerge = (key: string, protocol: string): Peer | undefined => {
		const merges = peers.get(key);
		const reachedAt = merges?.reachedAt.get(protocol);
		return reachedAt !== undefined && now() - reachedAt < intervalMs ? merges!.peer : undefined;
	};

	const recordMerge = (key: string, protocol: string, peer: Peer): void => {
		const merges = peers.get(key);
		if (merges === undefined) {
			peers.set(key, { reachedAt: new Map([[protocol, now()]]), peer });
		} else {
			merges.reachedAt.set(protocol, now());
			merges.peer = peer;
		}
	};

	peerStore.merge = async (id: PeerId, data: PeerData, abort?: AbortOptions): Promise<Peer> => {
		if (!isProtocolOnlyMerge(data)) return await merge.call(peerStore, id, data, abort);
		const key = id.toString();
		const protocol = data.protocols[0];
		const recent = recentMerge(key, protocol);
		if (recent !== undefined) {
			// The real merge would have rejected at its lock; keep that for a caller that gave up.
			abort?.signal?.throwIfAborted();
			return recent;
		}
		const peer = await merge.call(peerStore, id, data, abort);
		recordMerge(key, protocol, peer);
		return peer;
	};

	peerStore.delete = async (id: PeerId, abort?: AbortOptions): Promise<void> => {
		try {
			await remove.call(peerStore, id, abort);
		} finally {
			peers.delete(id.toString());
		}
	};

	log('installed intervalMs=%d maxPeers=%d', intervalMs, options.maxPeers ?? PROTOCOL_MERGE_TRACKED_PEERS);
}
