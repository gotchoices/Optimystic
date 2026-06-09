import type { CohortTopicService, CollectionChangeEvent, CollectionChangeListener, CollectionId, CommitCert, IBlockChangeNotifier } from "@optimystic/db-core";
import { createLogger } from "../logger.js";

const log = createLogger('cohort-change-bridge');

/**
 * The local commit feed the bridge observes: a {@link IBlockChangeNotifier} (the node's
 * `StorageRepo`) extended with the catch-all {@link onAnyCollectionChange} the bridge needs to see
 * EVERY commit — it cannot enumerate collection ids ahead of time to subscribe per-collection, and
 * origination must fire whether or not anyone subscribed to that collection.
 */
export interface ChangeBridgeSource extends IBlockChangeNotifier {
	onAnyCollectionChange(listener: CollectionChangeListener): () => void;
}

export interface CohortTopicChangeNotifierDeps {
	/** The local node's commit feed (its `StorageRepo`). */
	readonly source: ChangeBridgeSource;
	/** The cohort-topic substrate whose `onLocalCommit` origination hook receives member commits. */
	readonly service: CohortTopicService;
	/** True iff this node is a cohort member responsible for `collectionId`'s reactivity-topic fan-out. */
	readonly selfIsCohortMember: (collectionId: CollectionId) => boolean;
	/** Resolve the pass-through commit cert for a change event (e.g. the cluster commit-cert store). */
	readonly extractCommitCert: (event: CollectionChangeEvent) => CommitCert | undefined;
}

/**
 * The reactivity/matchmaking **origination point**: bridge the local single-node change-notifier
 * primitive into the networked cohort-topic substrate.
 *
 * On EVERY commit landing on this node (via the catch-all {@link ChangeBridgeSource.onAnyCollectionChange}
 * feed), if this node is a cohort member for the collection's reactivity topic, the bridge hands the
 * `CollectionChangeEvent` plus the pass-through {@link CommitCert} to `service.onLocalCommit` —
 * reactivity reuses the commit cert's threshold signature directly and never re-signs. A commit on a
 * non-member node (no fan-out responsibility) or one for which no cert is retained (nothing
 * authoritative to forward) is a no-op. A throwing downstream hook is isolated + logged so
 * origination can never break the commit (matching the {@link IBlockChangeNotifier} listener contract).
 *
 * The returned value IS an {@link IBlockChangeNotifier}: it is what `network-transactor` takes as its
 * `localChangeNotifier`, so per-collection {@link IBlockChangeNotifier.onCollectionChange} subscribers
 * (e.g. the Quereus reactive-watch vtab) keep working — those subscriptions delegate straight to
 * `source`. Origination runs independently on the catch-all feed.
 *
 * The catch-all subscription lives for the lifetime of the returned notifier (i.e. the node); it is
 * intentionally not torn down here.
 */
export function makeCohortTopicChangeNotifier(deps: CohortTopicChangeNotifierDeps): IBlockChangeNotifier {
	deps.source.onAnyCollectionChange((event) => originate(deps, event));
	return {
		onCollectionChange: (collectionId, listener): (() => void) => deps.source.onCollectionChange(collectionId, listener),
	};
}

/** Run the membership gate, cert extraction, and origination hook for one change event, isolating throws. */
function originate(deps: CohortTopicChangeNotifierDeps, event: CollectionChangeEvent): void {
	try {
		if (!deps.selfIsCohortMember(event.collectionId)) {
			return; // not responsible for this topic's fan-out
		}
		const hook = deps.service.onLocalCommit;
		if (!hook) {
			return; // no reactivity/matchmaking consumer has attached an origination handler yet
		}
		const commitCert = deps.extractCommitCert(event);
		if (!commitCert) {
			return; // nothing authoritative to forward; never fabricate an unsigned cert (extractor logs why)
		}
		hook(event, commitCert);
	} catch (err) {
		log('origination hook threw for collection=%s rev=%d: %o', event.collectionId, event.rev, err);
	}
}

/**
 * Wire the cohort-topic origination bridge as `node`'s `blockChangeNotifier` (the value the
 * `NetworkTransactor` consumes as its `localChangeNotifier`). Call this from the node assembly once a
 * {@link CohortTopicService} is running on the node, passing the node's `StorageRepo` as `source` and
 * the membership + cert-extraction seams. Returns the installed notifier.
 */
export function attachCohortChangeBridge(node: { blockChangeNotifier?: IBlockChangeNotifier }, deps: CohortTopicChangeNotifierDeps): IBlockChangeNotifier {
	const notifier = makeCohortTopicChangeNotifier(deps);
	node.blockChangeNotifier = notifier;
	return notifier;
}
