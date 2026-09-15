// `crypto` / `node:crypto` shim — exactly the row in the "Node.js built-in module shims" table of
// packages/db-p2p/readme.md § React Native: `createHash()` via @noble/hashes. The caller is the Node
// variant of `multiformats/hashes/sha2`, which does `crypto.createHash(name).update(bytes).digest()`.

import { sha256, sha512 } from '@noble/hashes/sha2.js';

const HASHES = new Map([
	['sha256', sha256],
	['sha-256', sha256],
	['sha512', sha512],
	['sha-512', sha512],
]);

export function createHash(algorithm) {
	const hash = HASHES.get(String(algorithm).toLowerCase());
	if (hash === undefined) throw new Error(`crypto shim: unsupported hash algorithm "${algorithm}"`);

	const state = hash.create();
	const hasher = {
		update(data) {
			state.update(typeof data === 'string' ? new TextEncoder().encode(data) : data);
			return hasher;
		},
		digest() {
			return state.digest();
		},
	};
	return hasher;
}

export default { createHash };
