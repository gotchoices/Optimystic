import type { PeerId } from '@libp2p/interface';
import { NetworkTransactor, type HlcClock, type IBlockChangeNotifier, type IKeyNetwork, type IPeerNetwork, type IRepo, type PeerId as CorePeerId } from '@optimystic/db-core';
import { RepoClient } from './repo/client.js';
import { stateHoldingsOnReads } from './repo/stated-holdings.js';
import { resolveLinkDeadlines, type LinkDeadlines } from './rpc-deadline.js';
import type { StorageRepo } from './storage/storage-repo.js';

export interface NodeNetworkTransactorInit {
	/** The libp2p peer id of the node the transactor runs on. */
	peerId: PeerId;
	/** The node's key network: it places blocks, and `RepoClient` dials through it. */
	keyNetwork: IKeyNetwork & IPeerNetwork;
	/** This node's coordinated repo; absent on a client, which coordinates nothing. */
	coordinatedRepo?: IRepo;
	/** This node's StorageRepo, so remote reads state what this node holds (`stateHoldingsOnReads`); absent on a client. */
	storageRepo?: StorageRepo;
	/** The node's network-namespaced protocol prefix (`/optimystic/<networkName>`), which every repo dial negotiates under. */
	protocolPrefix: string;
	/** Absent: `resolveLinkDeadlines()`, the undeclared ones (a host-injected node built without `createLibp2pNode`). */
	linkDeadlines?: LinkDeadlines;
	/** Commits this node's storage applies; absent for a transactor that only reads, which watches nothing. */
	localChangeNotifier?: IBlockChangeNotifier;
	/** The node's own HLC clock; absent, writes mint from the process-wide clock. */
	clock?: HlcClock;
}

/**
 * The `NetworkTransactor` a node reads and writes through: this node's own coordinated repo for
 * itself, a `RepoClient` for every other peer. The one construction, used by the node for its own
 * reads of committed state (`createLibp2pNodeBase`) and by the Quereus plugin's collection factory.
 */
export function createNodeNetworkTransactor(init: NodeNetworkTransactorInit): NetworkTransactor {
	const { peerId, keyNetwork, coordinatedRepo, protocolPrefix } = init;
	// A node a host injected may carry no store, and a client has none; its reads then state nothing.
	const localStore = init.storageRepo;
	const getRepo = (target: CorePeerId): IRepo => {
		// This node itself: its coordinated repo. A client has none, and no transactor ever picks it, since
		// a client is in no cohort and never coordinates; the throw is that assertion.
		if (target.toString() === peerId.toString()) {
			if (!coordinatedRepo) {
				throw new Error(`node ${peerId.toString()} stores no blocks (servesBlocks: false) yet was picked to coordinate; a client is in no cohort`);
			}
			return coordinatedRepo;
		}
		// For remote peers, create a RepoClient. Its reads say what this node holds of each block, so a
		// coordinator whose cohort includes this node need not ask it back over the network.
		const remote = RepoClient.create(target, keyNetwork, protocolPrefix);
		return localStore ? stateHoldingsOnReads(remote, localStore) : remote;
	};

	// The node's own derived deadlines, so a declared link round trip reaches every repo dial and
	// the budget around them. A node a host injected without building it through `createLibp2pNode`
	// carries none; it gets the undeclared ones.
	const { dialTimeoutMs, transactionTimeoutMs, retryBackoffBaseMs } = init.linkDeadlines ?? resolveLinkDeadlines();

	return new NetworkTransactor({
		// Four dial deadlines (30 s when undeclared): a dial to a dead coordinator that runs out its
		// deadline, the cold relayed dial to the one picked next, that coordinator's own cold dial to a
		// cohort member, and the warm round trips of the consensus rounds. At a 3 s round trip, 132 s.
		// NOTE: a write against an unreachable cohort takes that long to fail, and a cluster member keeps
		// the record's consensus state until the expiration it stamps; if either matters more than a
		// re-picked coordinator, give this budget fewer dials and accept that a dead coordinator then
		// cannot be re-picked over cold relayed links.
		timeoutMs: transactionTimeoutMs,
		// A cancel is a stream negotiation and a request to the coordinator, which then runs a
		// consensus round with the block's cohort: about six round trips on warm connections, so a
		// fixed 5 s fails every cancel once the round trip passes about 800 ms. The derived dial
		// deadline is eleven round trips, and 3 s when undeclared, so the 5 s floor keeps an undeclared
		// node where it was.
		// NOTE: holds a warm-connection cancel with five round trips to spare, but not one that must
		// first open a cold relayed connection (up to ten more). A cancel usually reuses the connection
		// its pend just opened; if cancels on slow links run out of time anyway (a failed cancel leaves
		// its pending records standing until a re-send lands; see `NetworkTransactor.dischargeCancel`),
		// give this budget its own number of round trips.
		abortOrCancelTimeoutMs: Math.max(5_000, dialTimeoutMs),
		dialTimeoutMs,
		// One declared round trip before a retry, doubling; 0 (no wait) on an undeclared link.
		retryBackoffBaseMs,
		keyNetwork,
		getRepo,
		localChangeNotifier: init.localChangeNotifier,
		// `getRepo` serves this node from its coordinated repo, so ties among a block's responsible
		// peers go to this node and its own writes skip the network hop. A client has nothing co-located.
		localPeerId: coordinatedRepo ? peerId : undefined,
		// The node's own HLC clock, which its storage raises to every write it stores, so the writes
		// this transactor mints never sit below one the node holds. A node a host injected without
		// building it through `createLibp2pNode` carries none; its writes mint from the process-wide clock.
		clock: init.clock,
	});
}
