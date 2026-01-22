/**
 * Simple djb2 string hash function.
 * 
 * This is a non-cryptographic hash suitable for generating short identifiers.
 * For security-critical hashing, use SHA-256 from multiformats/hashes/sha2.
 * 
 * @param str - The string to hash
 * @returns A base-36 encoded hash string
 */
export function hashString(str: string): string {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
	}
	return Math.abs(hash).toString(36);
}

