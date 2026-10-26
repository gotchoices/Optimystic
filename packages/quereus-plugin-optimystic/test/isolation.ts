/**
 * Test helper: a node's transactor wrapped so its reads can be made to meet an unreachable cohort.
 * The mesh's own failure switches cut a node off from cluster (write) rounds but leave it reading its
 * own replica, so unreachability on the READ side is driven here instead: registered under the key the
 * factory resolves (`shared:test`), the wrapper's `get` answers every block `unavailable:
 * 'cohort-unreachable'` while {@link Isolation.armed} is set — what a refresh meets on a node that
 * cannot reach its cohort. Writes and every other call pass through untouched.
 */

import { BlockUnavailableError } from '@optimystic/db-core';
import type { BlockGets, BlockId, GetBlockResults, ITransactor } from '@optimystic/db-core';

/** The `BlockUnavailableError` somewhere along `error`'s `cause` chain, if there is one: the plugin
 * wraps a read's or an initialization's failure, and the typed cause survives underneath. */
export function unavailableIn(error: unknown): BlockUnavailableError | undefined {
	for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
		if (cause instanceof BlockUnavailableError) return cause;
	}
	return undefined;
}

export class Isolation {
	/** While set, every block `get` the predicate admits answers `unavailable: 'cohort-unreachable'`. */
	armed = false;
	/** Every `get` the wrapped transactor received, armed or not. */
	gets = 0;

	/**
	 * @param unreachable Which blocks are unreachable while armed; every block by default. A spec that
	 * needs one collection unreachable and the rest readable (the plugin's catalog, say) names the
	 * collection's blocks — its header block is its collection id, and the first read of a collection
	 * is of that block alone, so a predicate on the id prefix catches the open.
	 */
	constructor(private readonly unreachable: (blockId: BlockId) => boolean = () => true) {}

	wrap(inner: ITransactor): ITransactor {
		return new Proxy(inner, {
			get: (target, property) => {
				if (property === 'get') return (blockGets: BlockGets) => this.get(target, blockGets);
				const value: unknown = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	}

	private async get(inner: ITransactor, blockGets: BlockGets): Promise<GetBlockResults> {
		this.gets++;
		if (!this.armed || !blockGets.blockIds.some(this.unreachable)) return inner.get(blockGets);
		return Object.fromEntries(blockGets.blockIds.map(id => [id, { state: {}, unavailable: 'cohort-unreachable' as const }]));
	}
}
