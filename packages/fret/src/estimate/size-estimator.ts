import type { DigitreeStore } from '../store/digitree-store.js'

export type SizeEstimate = { n: number; confidence: number };

function bytesToBigInt(u8: Uint8Array): bigint {
	let v = 0n;
	for (let i = 0; i < u8.length; i++) v = (v << 8n) | BigInt(u8[i]!);
	return v;
}

function medianBigInt(values: bigint[]): bigint {
	if (values.length === 0) return 0n;
	const arr = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const mid = Math.floor(arr.length / 2);
	return arr.length % 2 === 0 ? (arr[mid - 1]! + arr[mid]!) / 2n : arr[mid]!;
}

export function estimateSizeAndConfidence(store: DigitreeStore, m: number): SizeEstimate {
	const peers = store.list();
	const count = peers.length;
	if (count === 0) return { n: 0, confidence: 0 };
	if (count === 1) return { n: 1, confidence: 0.2 };

	const ringSize = 1n << 256n;
	const coords = peers.map((p) => bytesToBigInt(p.coord)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

	const gaps: bigint[] = [];
	for (let i = 1; i < coords.length; i++) gaps.push(coords[i]! - coords[i - 1]!);
	gaps.push((coords[0]! + ringSize) - coords[coords.length - 1]!);

	// Use median gap to reduce skew from sparse knowledge
	const medGap = medianBigInt(gaps);
	const safeGap = medGap > 0n ? medGap : ringSize / BigInt(Math.max(1, count));
	const nEstBig = ringSize / safeGap;
	const nEst = Math.max(1, Math.min(Number(nEstBig), 1_000_000_000));

	// Confidence from sample size and gap variance
	let minGap = gaps[0]!;
	let maxGap = gaps[0]!;
	for (const g of gaps) {
		if (g < minGap) minGap = g;
		if (g > maxGap) maxGap = g;
	}
	const sizeFactor = Math.min(1, count / Math.max(1, m * 2));
	const varianceFactor = maxGap === 0n ? 0 : Number(minGap) / Number(maxGap);
	const confidence = Math.max(0.05, Math.min(1, 0.5 * sizeFactor + 0.5 * varianceFactor));
	return { n: nEst, confidence };
}
