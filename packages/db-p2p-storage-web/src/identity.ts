import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import type { OptimysticWebDBHandle } from './db.js';

export const DEFAULT_PEER_KEY_NAME = 'peer-private-key';

/**
 * Loads the persisted browser peer's libp2p private key, or generates a fresh
 * Ed25519 key on first call and persists it.
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
): Promise<PrivateKey> {
	const stored = await db.get('kv', keyName);
	if (stored instanceof Uint8Array) {
		return privateKeyFromProtobuf(stored);
	}
	const key = await generateKeyPair('Ed25519');
	const bytes = privateKeyToProtobuf(key);
	await db.put('kv', bytes, keyName);
	return key;
}
