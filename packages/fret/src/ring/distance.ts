export function xorDistance(a: Uint8Array, b: Uint8Array): Uint8Array {
	const len = Math.max(a.length, b.length);
	const out = new Uint8Array(len);
	for (let i = 0; i < len; i++) {
		const ai = a[a.length - 1 - i] ?? 0;
		const bi = b[b.length - 1 - i] ?? 0;
		out[len - 1 - i] = ai ^ bi;
	}
	return out;
}

export function lexLess(a: Uint8Array, b: Uint8Array): boolean {
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		if (av < bv) return true;
		if (av > bv) return false;
	}
	return false;
}

export function clockwiseDistance(a: Uint8Array, b: Uint8Array): Uint8Array {
	// distance from a to b moving forward (a < b ? b-a : 2^n - (a-b))
	const len = Math.max(a.length, b.length);
	const out = new Uint8Array(len);
	let borrow = 0;
	// Compute b - a mod 2^n
	for (let i = 0; i < len; i++) {
		const ai = a[a.length - 1 - i] ?? 0;
		const bi = b[b.length - 1 - i] ?? 0;
		let v = bi - ai - borrow;
		if (v < 0) {
			v += 256;
			borrow = 1;
		} else {
			borrow = 0;
		}
		out[len - 1 - i] = v;
	}
	return out;
}

export function minDistance(a: Uint8Array, b: Uint8Array): Uint8Array {
	// For routing we use absolute ring distance via XOR by default
	return xorDistance(a, b);
}
