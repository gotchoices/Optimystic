import type { Libp2p, PrivateKey } from '@libp2p/interface';
import type { IBlockChangeNotifier, IRepo } from '@optimystic/db-core';
import type { DisputeService } from './dispute/dispute-service.js';
import type { Libp2pKeyPeerNetwork } from './libp2p-key-network.js';
import type { ReactivityCollectionWatch } from './reactivity/collection-watch.js';
import type { PeerReputationService } from './reputation/peer-reputation.js';
import type { ArrivalPushReceiver } from './matchmaking/arrival-push-receiver.js';
import type { LinkDeadlines } from './rpc-deadline.js';
import type { StorageRepo } from './storage/storage-repo.js';

/**
 * The handles `createLibp2pNodeBase` attaches to the libp2p node it returns. This is the
 * sanctioned in-process surface a host reads — declared once here so reaching it does not
 * require a cast, and so a host cannot silently rebuild a component the node already owns.
 *
 * Deliberately NOT the full set of `(node as any).*` attachments made in `libp2p-node-base.ts`:
 * the churn/rebalance/ring-shift monitors, the cohort-topic host and the reactivity registries
 * are node-internal wiring, not a host-facing surface, and typing them is a separate job.
 * `reactivityWatch` is the exception among the reactivity pieces because it IS the surface a
 * host uses; the registry, recover transport and rotation scheduler behind it stay internal.
 * `matchmakingArrivalPush` is the matchmaking counterpart: the one piece a host passes on.
 */
export interface OptimysticNodeAttachments {
	/**
	 * The node's ONE key network — built from its resolved cluster policy, network-namespaced
	 * protocol prefix, reputation tracker and persistence. A host that needs key/coordinator
	 * lookup uses THIS; constructing a second one gives peer selection a different cohort
	 * width and coordinator than the node's own consensus path uses for the same key.
	 */
	keyNetwork: Libp2pKeyPeerNetwork;
	coordinatedRepo: IRepo;
	storageRepo: StorageRepo;
	/** Per-collection change origin. Replaced by the cohort-topic bridge notifier when enabled. */
	blockChangeNotifier: IBlockChangeNotifier;
	reputation: PeerReputationService;
	/** Present only when the dispute subsystem is configured. */
	disputeService?: DisputeService;
	/** The node's libp2p Ed25519 identity key, for hosts binding a client-transaction signer. */
	peerPrivateKey: PrivateKey;
	/**
	 * Every network deadline the node derived from `NodeOptions.linkRoundTripMs` (the undeclared
	 * constants when it was not set). A host that dials through the node — a `NetworkTransactor`'s
	 * `dialTimeoutMs`, and its `timeoutMs` from `transactionTimeoutMs` — reads its deadlines here
	 * rather than restating ones that ignore the declaration.
	 */
	linkDeadlines: LinkDeadlines;
	/**
	 * Wake-on-network-change for a collection: one `watch` call per collection a host wants to be
	 * told about, whichever machine commits to it. Present exactly when the node was built with
	 * `cohortTopic.enabled`; a host on a node without it has only `blockChangeNotifier`, which
	 * reports commits this node itself stores.
	 */
	reactivityWatch?: ReactivityCollectionWatch;
	/**
	 * The node's matchmaking arrival-push receiver: pass it to `createLibp2pMatchmakingSeekerSession` as
	 * `arrivalPush` and that session's walks wait on pushes rather than polling. Present exactly when the node
	 * was built with `cohortTopic.enabled`; without it a seeker session takes the poll path.
	 */
	matchmakingArrivalPush?: ArrivalPushReceiver;
}

export type OptimysticNode = Libp2p & OptimysticNodeAttachments;
