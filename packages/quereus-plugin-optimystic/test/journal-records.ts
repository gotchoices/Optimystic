/**
 * Test helpers over the offline journal's key-value records (`offline-journal.ts`): list one
 * sub-namespace of a label, and read one record back as the shape this build writes.
 */

import { expect } from 'chai';
import type { IKVStore } from '@optimystic/db-p2p';

/** The keys of one journal sub-namespace (`entries`, `drives`, `outcomes`) under `label`, sorted. */
export async function keysOf(store: IKVStore, kind: 'entries' | 'drives' | 'outcomes', label = 'default'): Promise<string[]> {
	return (await store.list(`optimystic-offline/${label}/${kind}/`)).sort();
}

/** The parsed record at `key`, which must exist. */
export async function record<T>(store: IKVStore, key: string): Promise<T> {
	const value = await store.get(key);
	expect(value, `a record at ${key}`).to.be.a('string');
	return JSON.parse(value!) as T;
}
