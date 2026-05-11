import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import type { SqliteDb } from './db.js';

export const DEFAULT_PEER_KEY_NAME = 'peer-private-key';

/**
 * Loads the persisted NativeScript peer's libp2p private key, or generates a
 * fresh Ed25519 key on first call and persists it.
 *
 * The key is stored as raw protobuf bytes in the `kv` table's `b_val` column
 * under `keyName`. SQLite stores BLOB natively, so there is no base64
 * round-trip — unlike text-only key/value stores.
 *
 * The returned `PrivateKey` can be passed directly to
 * `createLibp2pNode({ privateKey })`, giving a NativeScript peer a stable,
 * restart-surviving identity.
 */
export async function loadOrCreateNSPeerKey(
	db: SqliteDb,
	keyName: string = DEFAULT_PEER_KEY_NAME,
): Promise<PrivateKey> {
	const row = await db.prepare('SELECT b_val FROM kv WHERE key = ?').get(keyName);
	const stored = row?.b_val;
	if (stored instanceof Uint8Array && stored.length > 0) {
		return privateKeyFromProtobuf(stored);
	}
	const key = await generateKeyPair('Ed25519');
	const bytes = privateKeyToProtobuf(key);
	await db
		.prepare('INSERT INTO kv (key, s_val, b_val) VALUES (?, NULL, ?) ON CONFLICT(key) DO UPDATE SET b_val = excluded.b_val')
		.run(keyName, bytes);
	return key;
}
