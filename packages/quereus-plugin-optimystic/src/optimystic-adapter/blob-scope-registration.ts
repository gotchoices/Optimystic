/**
 * blob-scope-registration — this process's record of which reference trees it has confirmed in
 * which network's scope registry (docs/blobs.md §Registering references).
 *
 * The registry is one small tree per network listing the collection ids of the network's reference
 * trees, and it is what lets a storage node enumerate every place a reference could be without
 * reading a schema catalog. A table with a `blobref` column adds its tree to it when the table is
 * created or gains its first such column, and takes it out when the table is dropped.
 *
 * No registry handle is held here, and no tree-opening method is added to the collection factory:
 * db-core's three entry points — `BlobScopeRegistry.enumerate`, `.register` and `.unregister`
 * (`packages/db-core/src/blob/scope-registry.ts`) — each open their own handle. They therefore open
 * it WITHOUT the factory's `treeOptions`, which is correct rather than merely tolerable, and is
 * stated here so nobody "fixes" it later:
 *
 * - the sealed-segment refusal callback matters only for a tree that joins an offline queue entry,
 *   and a registration is always synced on its own, at DDL time, which `OfflineMode`'s
 *   `assertNoQueuedEntries` has already gated;
 * - the adopted-commits callback matters only for a materialized view's source collections, which
 *   the registry is never one of.
 */

import { BlobScopeRegistry } from '@optimystic/db-core';
import type { BlobScope, ITransactor } from '@optimystic/db-core';
import type { ParsedOptimysticOptions } from '../types.js';
import { createLogger } from '../logger.js';

/** One line per registration attempt that failed (docs/debugging.md §quereus-plugin sub-namespaces). */
const blobLog = createLogger('blob');

/** One network as the registry needs it: the transactor key and its transactor. */
export interface NetworkBinding {
	/** The transactor key, `${transactor}:${keyNetwork}`. */
	readonly key: string;
	readonly transactor: ITransactor;
}

/**
 * Whether a scope is in its network's registry. `registered: false` carries the failure the
 * caller refuses the statement with, so nothing is swallowed.
 */
export type BlobScopeOutcome =
	| { readonly registered: true }
	| { readonly registered: false; readonly cause: unknown };

const REGISTERED: BlobScopeOutcome = { registered: true };

/**
 * The reference-tree options of a table whose own collection `options` names: its `/blobrefs`
 * child. The one place the sub-collection URI is formed, so the vtab's tree and the DDL paths'
 * scope cannot drift. An index tree can never collide with it: index trees sit one segment
 * deeper, under `/index/`.
 */
export function blobReferenceOptions(options: ParsedOptimysticOptions): ParsedOptimysticOptions {
	return { ...options, collectionUri: `${options.collectionUri}/blobrefs` };
}

/** Which scopes this process has confirmed in which network's registry. */
export class BlobScopeRegistration {
	/**
	 * One promise per (network key, scope), kept only while it answers registered: a failure must
	 * not keep a registration that is genuinely needed from being retried, and a memo for a key
	 * whose transactor has since been replaced would skip one too ({@link clear}).
	 */
	private readonly confirmed = new Map<string, Promise<BlobScopeOutcome>>();

	/**
	 * Confirm `scope` in `network`'s registry: read first (`BlobScopeRegistry.enumerate`, certain
	 * and listing it), otherwise register (`BlobScopeRegistry.register`, which opens, stages and
	 * syncs in one step). Memoized once registered, so the steady state costs nothing, and
	 * concurrent calls for one pair share one attempt.
	 */
	async ensure(network: NetworkBinding, scope: BlobScope): Promise<BlobScopeOutcome> {
		const key = memoKey(network, scope);
		const existing = this.confirmed.get(key);
		if (existing) {
			return await existing;
		}
		const attempt = this.confirm(network, scope);
		this.confirmed.set(key, attempt);
		void attempt.then(outcome => {
			if (!outcome.registered && this.confirmed.get(key) === attempt) this.confirmed.delete(key);
		});
		return await attempt;
	}

	/** `BlobScopeRegistry.unregister`; idempotent. Forgets the memo for the pair. */
	async unregister(network: NetworkBinding, scope: BlobScope): Promise<void> {
		this.confirmed.delete(memoKey(network, scope));
		await BlobScopeRegistry.unregister(network.transactor, scope);
	}

	/** Forget every memo, for a factory clearing its transactors. */
	clear(): void {
		this.confirmed.clear();
	}

	/**
	 * Reading before writing is what keeps a re-declare of an existing table from re-writing an
	 * entry whose value is already exactly right: the read costs one request the first time in a
	 * process and nothing after. An UNCERTAIN read falls through to the register rather than
	 * trusting its absence, since the entry is an idempotent upsert and writing one that is
	 * already there changes nothing.
	 */
	private async confirm(network: NetworkBinding, scope: BlobScope): Promise<BlobScopeOutcome> {
		try {
			const listing = await BlobScopeRegistry.enumerate(network.transactor);
			if (listing.certain && listing.scopes.includes(scope)) {
				return REGISTERED;
			}
			await BlobScopeRegistry.register(network.transactor, scope);
			return REGISTERED;
		} catch (cause) {
			blobLog('blob:scope-register-failed key=%s scope=%s %o', network.key, scope, cause);
			return { registered: false, cause };
		}
	}
}

function memoKey(network: NetworkBinding, scope: BlobScope): string {
	return JSON.stringify([network.key, scope]);
}
