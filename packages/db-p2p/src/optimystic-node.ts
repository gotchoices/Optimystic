import type { Libp2p, PrivateKey } from '@libp2p/interface';
import type { IBlockChangeNotifier, IRepo } from '@optimystic/db-core';
import type { DisputeService } from './dispute/dispute-service.js';
import type { Libp2pKeyPeerNetwork } from './libp2p-key-network.js';
import type { PeerReputationService } from './reputation/peer-reputation.js';
import type { StorageRepo } from './storage/storage-repo.js';

/**
 * The handles `createLibp2pNodeBase` attaches to the libp2p node it returns. This is the
 * sanctioned in-process surface a host reads — declared once here so reaching it does not
 * require a cast, and so a host cannot silently rebuild a component the node already owns.
 *
 * Deliberately NOT the full set of `(node as any).*` attachments made in `libp2p-node-base.ts`:
 * the churn/rebalance/ring-shift monitors, the cohort-topic host and the reactivity registries
 * are node-internal wiring, not a host-facing surface, and typing them is a separate job.
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
}

export type OptimysticNode = Libp2p & OptimysticNodeAttachments;
