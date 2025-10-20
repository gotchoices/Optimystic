export type FretMode = 'active' | 'passive';

export interface FretConfig {
	k: number;
	m: number;
	capacity: number;
	profile: 'edge' | 'core';
	bootstraps?: string[];
	networkName?: string;
}

export interface NeighborSnapshotV1 {
	v: 1;
	from: string;
	timestamp: number;
	successors: string[];
	predecessors: string[];
	sample?: Array<{ id: string; coord: string; relevance: number }>;
	size_estimate?: number;
	confidence?: number;
	sig: string;
	metadata?: Record<string, any>;
}

export interface RouteAndMaybeActV1 {
	v: 1;
	key: string;
	want_k: number;
	wants?: number;
	ttl: number;
	min_sigs: number;
	digest?: string;
	activity?: string;
	breadcrumbs?: string[];
	correlation_id: string;
	timestamp: number;
	signature: string;
}

export interface NearAnchorV1 {
	v: 1;
	anchors: string[];
	cohort_hint: string[];
	estimated_cluster_size: number;
	confidence: number;
}

export interface ReportEvent {
	peerId: string;
	type: 'good' | 'bad';
	reason?: string;
}

export interface FretService {
	start(): Promise<void>;
	stop(): Promise<void>;
	setMode(mode: FretMode): void;
	ready(): Promise<void>;
	neighborDistance(selfId: string, key: Uint8Array, k: number): number;
	getNeighbors(key: Uint8Array, direction: 'left' | 'right' | 'both', wants: number): string[];
	assembleCohort(key: Uint8Array, wants: number, exclude?: Set<string>): string[];
	expandCohort(current: string[], key: Uint8Array, step: number, exclude?: Set<string>): string[];
	routeAct(msg: RouteAndMaybeActV1): Promise<NearAnchorV1 | { commitCertificate: string }>;
	report(evt: ReportEvent): void;
	setMetadata(metadata: Record<string, any>): void;
	getMetadata(peerId: string): Record<string, any> | undefined;
	listPeers(): Array<{ id: string; metadata?: Record<string, any> }>;

	// Network size estimation
	reportNetworkSize(estimate: number, confidence: number, source?: string): void;
	getNetworkSizeEstimate(): { size_estimate: number; confidence: number; sources: number };
	getNetworkChurn(): number;
	detectPartition(): boolean;
}

export { FretService as FretServiceImpl } from './service/fret-service.js';
import { FretService as FretServiceClass } from './service/fret-service.js';
export { seedDiscovery } from './service/discovery.js';
export { Libp2pFretService, fretService } from './service/libp2p-fret-service.js';
export { hashKey, hashPeerId } from './ring/hash.js';

export function createFret(node: any, cfg?: Partial<FretConfig>): FretService {
	return new FretServiceClass(node, cfg) as FretService;
}
