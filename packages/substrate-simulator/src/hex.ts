/** Lowercase hex of a byte array. Synchronous — safe in the no-async engine core. */
export function bytesToHex(bytes: Uint8Array): string {
	let hex = '';
	for (const b of bytes) {
		hex += b.toString(16).padStart(2, '0');
	}
	return hex;
}
