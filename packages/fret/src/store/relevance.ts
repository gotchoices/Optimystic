import type { PeerEntry } from './digitree-store.js';
import { xorDistance } from '../ring/distance.js';

export interface SparsityModel {
	centers: number[];
	occupancy: Float64Array;
	alpha: number;
	sigma: number;
	beta: number;
	sMin: number;
	sMax: number;
	eps: number;
}

export function createSparsityModel(
	m = 12,
	sigma = 0.08,
	alpha = 0.03,
	beta = 0.6,
	sMin = 0.7,
	sMax = 1.8,
	eps = 1e-6
): SparsityModel {
	const centers: number[] = [];
	for (let i = 0; i < m; i++) centers.push((i + 0.5) / m);
	return { centers, occupancy: new Float64Array(m), alpha, sigma, beta, sMin, sMax, eps };
}

export function normalizedLogDistance(selfCoord: Uint8Array, otherCoord: Uint8Array): number {
	const d = xorDistance(selfCoord, otherCoord);
	let lz = 0;
	for (let i = 0; i < d.length; i++) {
		const v = d[i] ?? 0;
		if (v === 0) { lz += 8; continue; }
		// leading zeros in a byte: 7 - floor(log2(v))
		const leading = 7 - Math.floor(Math.log2(v));
		lz += leading;
		break;
	}
	const x = 1 - Math.min(256, lz) / 256;
	return x;
}

function gaussianKernel(dx: number, sigma: number): number {
	const z = dx / Math.max(1e-9, sigma);
	return Math.exp(-0.5 * z * z);
}

export function observeDistance(model: SparsityModel, x: number): void {
	for (let i = 0; i < model.centers.length; i++) {
		const k = gaussianKernel(Math.abs(x - model.centers[i]!), model.sigma);
		model.occupancy[i] = (1 - model.alpha) * model.occupancy[i]! + model.alpha * k;
	}
}

export function sparsityBonus(model: SparsityModel, x: number): number {
	let dens = 0;
	let ideal = 0;
	for (let i = 0; i < model.centers.length; i++) {
		const k = gaussianKernel(Math.abs(x - model.centers[i]!), model.sigma);
		dens += model.occupancy[i]! * k;
		ideal += 1 * k; // uniform target
	}
	const ratio = (ideal + model.eps) / (dens + model.eps);
	const s = Math.pow(ratio, model.beta);
	return Math.max(model.sMin, Math.min(model.sMax, s));
}

function recencyScore(entry: PeerEntry, now: number): number {
	const dt = Math.max(0, now - entry.lastAccess);
	const halfLifeMs = 60_000; // 1 minute half-life
	const lambda = Math.log(2) / Math.max(1, halfLifeMs);
	return Math.exp(-lambda * dt);
}

function frequencyScore(entry: PeerEntry): number {
	return Math.log1p(entry.accessCount) / 5; // saturates slowly
}

function healthScore(entry: PeerEntry): number {
	const total = entry.successCount + entry.failureCount;
	const successRate = total > 0 ? entry.successCount / total : 0.5;
	const latencyPenalty = entry.avgLatencyMs > 0 ? Math.min(1, entry.avgLatencyMs / 1000) : 0.5;
	const health = 0.5 * successRate + 0.5 * (1 - latencyPenalty);
	return Math.max(0, health);
}

function baseRelevance(entry: PeerEntry, now: number): number {
	const wRecency = 0.4;
	const wFreq = 0.2;
	const wHealth = 0.4;
	return (
		wRecency * recencyScore(entry, now) +
		wFreq * frequencyScore(entry) +
		wHealth * healthScore(entry)
	);
}

function withCounters(entry: PeerEntry, patch: Partial<PeerEntry>): PeerEntry {
	return { ...entry, ...patch };
}

export function touch(entry: PeerEntry, x: number, model: SparsityModel, now = Date.now()): PeerEntry {
	observeDistance(model, x);
	const base = baseRelevance(entry, now);
	const bonus = sparsityBonus(model, x);
	const relevance = base * bonus;
	return withCounters(entry, {
		lastAccess: now,
		relevance,
		accessCount: entry.accessCount + 1
	});
}

export function recordSuccess(entry: PeerEntry, latencyMs: number, x: number, model: SparsityModel, now = Date.now()): PeerEntry {
	observeDistance(model, x);
	const alpha = 0.2; // EMA for latency
	const avgLatencyMs = entry.avgLatencyMs > 0 ? (1 - alpha) * entry.avgLatencyMs + alpha * latencyMs : latencyMs;
	const base = baseRelevance({ ...entry, avgLatencyMs, successCount: entry.successCount + 1 }, now);
	const bonus = sparsityBonus(model, x);
	const relevance = base * bonus;
	return withCounters(entry, {
		lastAccess: now,
		relevance,
		successCount: entry.successCount + 1,
		avgLatencyMs
	});
}

export function recordFailure(entry: PeerEntry, x: number, model: SparsityModel, now = Date.now()): PeerEntry {
	observeDistance(model, x);
	// degrade relevance softly
	const base = baseRelevance({ ...entry, failureCount: entry.failureCount + 1 }, now) * 0.7;
	const bonus = sparsityBonus(model, x);
	const relevance = base * bonus;
	return withCounters(entry, {
		lastAccess: now,
		relevance,
		failureCount: entry.failureCount + 1
	});
}
