import { BLOB_SCOPE_REGISTRY_ID, BlobReferenceTree, BlobScopeRegistry, type BlobListing, type BlobRef, type BlobScope, type BlobScopeListing, type ITransactor } from '@optimystic/db-core';
import { createLogger } from '../logger.js';

const log = createLogger('blob:protocol');

/**
 * What committed state says about one reference.
 *  - `listed`: the reference tree of `scope`, a registered scope, lists the reference.
 *  - `not-listed`: no registered scope that was read lists it, and every read was certain — or the
 *    scope asked about is not in the registry at all, which no read can change.
 *  - `uncertain`: a read could not be trusted (unavailable, possibly stale, below a floor, or it
 *    threw), so absence is not established. `reason` says which.
 */
export type ReferenceVerdict =
	| { kind: 'listed'; scope: BlobScope }
	| { kind: 'not-listed' }
	| { kind: 'uncertain'; reason: string };

export interface BlobReferenceCheckDeps {
	/** The node's own reader of committed state; never staged into. */
	transactor: ITransactor;
}

/**
 * Whether a blob is referenced in committed state, for a node deciding whether it may take a blob on
 * another's behalf (docs/blobs.md §Who may fetch and who may store). The registry is read first, and
 * only a scope it lists has its reference tree read. Both reads open fresh read-only handles
 * (`readCommittedTree`), so nothing this check does can write.
 */
export class BlobReferenceCheck {
	private readonly transactor: ITransactor;

	constructor(deps: BlobReferenceCheckDeps) {
		this.transactor = deps.transactor;
	}

	/**
	 * Registry first: a scope the registry does not list is `not-listed` with no read of that scope's
	 * tree, whether or not the registry read was certain — either way it is not a scope this node may
	 * act on. Then that one tree.
	 */
	async inScope(ref: BlobRef, scope: BlobScope): Promise<ReferenceVerdict> {
		// NOTE: enumerates the whole registry to test one scope; if scopes ever number in the hundreds,
		// read the one registry entry with a point lookup instead.
		const registry = await this.readRegistry(ref);
		if ('failed' in registry) {
			return registry.failed;
		}
		if (!registry.scopes.includes(scope)) {
			return { kind: 'not-listed' };
		}
		return await this.readTree(ref, scope);
	}

	/**
	 * Every registered scope, in the registry's (ascending) order, until one lists `ref`. For a reader
	 * keeping what it fetched. A scope whose read was uncertain is remembered: with no later scope
	 * listing `ref`, the answer is `uncertain`, as it is when the registry read itself was.
	 */
	async anywhere(ref: BlobRef): Promise<ReferenceVerdict> {
		const registry = await this.readRegistry(ref);
		if ('failed' in registry) {
			return registry.failed;
		}
		let doubt: ReferenceVerdict | undefined = registry.certain ? undefined : { kind: 'uncertain', reason: 'registry-uncertain' };
		for (const scope of registry.scopes) {
			const verdict = await this.readTree(ref, scope);
			if (verdict.kind === 'listed') {
				return verdict;
			}
			if (verdict.kind === 'uncertain') {
				doubt ??= verdict;
			}
		}
		return doubt ?? { kind: 'not-listed' };
	}

	private async readRegistry(ref: BlobRef): Promise<BlobScopeListing | { failed: ReferenceVerdict }> {
		try {
			return await BlobScopeRegistry.enumerate(this.transactor);
		} catch (error) {
			return { failed: readFailed(BLOB_SCOPE_REGISTRY_ID, ref, error) };
		}
	}

	private async readTree(ref: BlobRef, scope: BlobScope): Promise<ReferenceVerdict> {
		let listing: BlobListing;
		try {
			listing = await BlobReferenceTree.listed(this.transactor, scope, [ref]);
		} catch (error) {
			return readFailed(scope, ref, error);
		}
		// A listing is evidence of a reference whether or not it is certain; `certain` is about absences.
		if (listing.listed.has(ref)) {
			return { kind: 'listed', scope };
		}
		return listing.certain ? { kind: 'not-listed' } : { kind: 'uncertain', reason: 'tree-uncertain' };
	}
}

/** A read that threw — `readCommittedTree` rethrows everything but the two errors it answers as
 * uncertain — is an uncertain verdict, never a silent one. */
function readFailed(scope: string, ref: BlobRef, error: unknown): ReferenceVerdict {
	const reason = error instanceof Error ? error.message : String(error);
	log('reference:read-failed scope=%s ref=%s err=%s', scope, ref, reason);
	return { kind: 'uncertain', reason };
}
