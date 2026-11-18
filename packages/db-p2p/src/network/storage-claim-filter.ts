/**
 * Keeps a remote peer's peerStore record from naming this network's storage protocols because of a
 * stream, so that only the peer's own identify can say it serves storage.
 *
 * The key network counts a remote peer as serving this network when its peerStore protocol list
 * names `<prefix>/repo/1.0.0` or `<prefix>/cluster/1.0.0` (`membershipOf` in
 * `libp2p-key-network.ts`). That list has two writers. Identify (and identify-push) `patch`es it with
 * the peer's own complete list on every connection. And libp2p 3.3.11 merges every negotiated
 * stream's protocol into it, on both ends: `peerStore.merge(remotePeer, { protocols: [protocol] })`
 * in `Connection.newStream` and in `onIncomingStream` (`libp2p/dist/src/connection.js`), the latter
 * before the handler is even looked up. On the receiving end that second write says something false:
 * a peer that sends this node a request on its `repo` protocol gets `repo` added to its own record
 * here. A machine that holds nothing but reads and writes through a server was therefore classified
 * serving by every server it sent a request to, remembered as such and persisted, and put in cohorts,
 * where every write waited on a member that refuses the `cluster` protocol (84–105 s per write with
 * one unresponsive browser in a cohort, GitHub sereus#63). The same merge is how a stranger, honest
 * or not, got itself counted as a member by opening a stream (docs/internals.md §Network Membership
 * Predicate).
 *
 * So a merge into a remote peer's record that is exactly one of those two protocols resolves without
 * recording it. The wrapper cannot tell `newStream` from `onIncomingStream`, so the dialer's merge is
 * dropped too; that one was true (the remote accepted the protocol) but adds nothing identify does not
 * already record when the connection opens.
 *
 * What it costs: a serving peer whose identify failed on a connection is no longer rescued into
 * `serves` by the storage streams exchanged with it, and reads as any peer whose identify failed. And
 * a node on a build without this filter still classifies a client by its streams.
 *
 * Not part of `protocol-merge-throttle.ts`, which is deleted once libp2p carries
 * libp2p/js-libp2p#3692: that change merges each protocol once per connection, which still records a
 * dialer's storage protocols on the receiving end, so this filter stays.
 * `test/libp2p-merges-protocol-per-stream.spec.ts` pins the merge shape both wrappers intercept
 * ({@link isProtocolOnlyMerge}).
 *
 * Imports here are type-only or pure: `libp2p-node-base.ts` is reachable from the react-native entry.
 */

import type { AbortOptions, Peer, PeerData, PeerId, PeerStore } from '@libp2p/interface';
import { createLogger } from '../logger.js';
import { storageServingProtocols } from './storage-protocols.js';

const log = createLogger('storage-claim-filter');

/** The data libp2p's per-stream merge passes: one key, `protocols`, naming one protocol. */
export interface ProtocolOnlyMerge extends PeerData {
	protocols: [string];
}

/**
 * Whether `data` is the per-stream merge's shape. Every other merge (identify's, the dial queue's,
 * circuit relay's, `peer-address-book.ts`'s address merges) carries other keys or more protocols.
 */
export function isProtocolOnlyMerge(data: PeerData): data is ProtocolOnlyMerge {
	const keys = Object.keys(data);
	return keys.length === 1 && keys[0] === 'protocols' && data.protocols?.length === 1 && typeof data.protocols[0] === 'string';
}

/** The slice of the peerStore the filter wraps and reads. */
export type StorageClaimFilteredPeerStore = Pick<PeerStore, 'merge' | 'get'>;

/**
 * Wrap `peerStore.merge` so a per-stream merge ({@link isProtocolOnlyMerge}) of one of this network's
 * storage protocols ({@link storageServingProtocols}) into a remote peer's record records nothing.
 * Every other merge passes through unchanged: identify's, address merges, other protocols, and every
 * merge into this node's own record, where libp2p's registrar records each handled protocol in the
 * same one-protocol shape, and which identify advertises.
 *
 * A dropped merge still resolves to the peer's current record (`peerStore.get`), or, when the peer
 * has no record yet, to the record the merge would have made without the protocol. libp2p ignores
 * the value, but a caller of `merge` is owed a `Peer`.
 *
 * Install once, before `node.start()`, on the object libp2p's connections call through, and after
 * `throttleProtocolMerges`, so a dropped merge never reaches the throttle's bookkeeping. No timer,
 * so nothing to tear down.
 */
export function filterStorageClaimMerges(peerStore: StorageClaimFilteredPeerStore, self: PeerId, protocolPrefix: string): void {
	const selfKey = self.toString();
	const storageProtocols: ReadonlySet<string> = new Set(storageServingProtocols(protocolPrefix));
	const merge = peerStore.merge;

	const isStorageClaim = (id: PeerId, data: PeerData): boolean =>
		isProtocolOnlyMerge(data) && storageProtocols.has(data.protocols[0]) && id.toString() !== selfKey;

	// NOTE: each dropped merge costs one peerStore read (a read lock, a datastore read, a decode), where
	// the throttle answered from memory. That is still less than the merge it replaces, which also
	// rebuilds and rewrites the record; if it shows in a phone profile, answer with the last `Peer` read
	// for the peer, as the throttle does.
	const currentRecord = async (id: PeerId, abort?: AbortOptions): Promise<Peer> => {
		try {
			return await peerStore.get(id, abort);
		} catch (err) {
			// By name, as libp2p tests it: a second copy of `@libp2p/interface` would fail `instanceof`.
			if ((err as Error).name !== 'NotFoundError') throw err;
			return await merge.call(peerStore, id, { protocols: [] }, abort);
		}
	};

	peerStore.merge = async (id: PeerId, data: PeerData, abort?: AbortOptions): Promise<Peer> =>
		isStorageClaim(id, data)
			? await currentRecord(id, abort)
			: await merge.call(peerStore, id, data, abort);

	log('installed protocols=%o', [...storageProtocols]);
}
