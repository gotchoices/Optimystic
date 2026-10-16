import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import type { OptimysticWebDBHandle } from './db.js';
import { resolveStrictDurability, transactionDurability, type IndexedDBDurabilityOptions } from './durability.js';

export const DEFAULT_PEER_KEY_NAME = 'peer-private-key';

/**
 * Loads the persisted browser peer's libp2p private key, or generates a fresh
 * Ed25519 key on first call and persists it in one transaction that is strict
 * where the browser supports it, so a power cut right after first start cannot
 * give the node a different peer id next time. An existing key is read as it is.
 *
 * Stores the key as raw protobuf bytes (a `Uint8Array`) under `keyName` in the
 * `kv` object store. IndexedDB stores typed arrays natively — no base64 round-trip.
 *
 * The returned `PrivateKey` can be passed directly to `createLibp2pNode({ privateKey })`,
 * giving a browser peer a stable, reload-surviving identity.
 */
export async function loadOrCreateBrowserPeerKey(
	db: OptimysticWebDBHandle,
	keyName: string = DEFAULT_PEER_KEY_NAME,
	options: IndexedDBDurabilityOptions = {},
): Promise<PrivateKey> {
	const stored = await db.get('kv', keyName);
	if (stored instanceof Uint8Array) {
		return privateKeyFromProtobuf(stored);
	}
	const key = await generateKeyPair('Ed25519');
	const bytes = privateKeyToProtobuf(key);
	const tx = db.transaction('kv', 'readwrite', { durability: transactionDurability(resolveStrictDurability(options)) });
	await Promise.all([tx.store.put(bytes, keyName), tx.done]);
	return key;
}
