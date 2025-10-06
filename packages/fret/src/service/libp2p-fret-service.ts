import type { Startable } from '@libp2p/interface';
import type { Libp2p } from 'libp2p';
import type { FretConfig, FretService, RouteAndMaybeActV1, NearAnchorV1, ReportEvent } from '../index.js';
import { FretService as CoreFretService } from './fret-service.js';
import { seedDiscovery } from './discovery.js';

type Components = { libp2p?: Libp2p };

export class Libp2pFretService implements Startable {
	private inner: FretService | null = null;
	private nodeRef: Libp2p | null = null;

	constructor(private readonly components: Components, private readonly cfg?: Partial<FretConfig>) { }

	get [Symbol.toStringTag](): string {
		return '@optimystic/fret';
	}

	/**
	 * Allows the hosting application to inject the libp2p node reference
	 * prior to start(). This avoids relying on a libp2p-provided "libp2p"
	 * component which may not exist in some environments.
	 */
	public setLibp2p(node: Libp2p): void {
		this.nodeRef = node;
	}

	private ensure(): FretService {
		if (!this.inner) {
			if (!this.nodeRef) {
				throw new Error('Libp2pFretService: libp2p node not injected');
			}
			this.inner = new CoreFretService(this.nodeRef, this.cfg);
		}
		return this.inner;
	}

	async start(): Promise<void> {
		// Ensure inner service is constructed with a valid libp2p instance
		this.ensure();
		// Emit any currently known peers to libp2p discovery
		if (!this.nodeRef) throw new Error('Libp2pFretService.start: libp2p node not injected');
		seedDiscovery(this.nodeRef, (this.inner as any)?.store ?? ({} as any));
		await this.ensure().start();
	}

	async stop(): Promise<void> {
		await this.inner?.stop();
	}

	async routeAct(msg: RouteAndMaybeActV1): Promise<NearAnchorV1 | { commitCertificate: string }> {
		return await this.ensure().routeAct(msg);
	}

	getNeighborsForKey(
		key: Uint8Array,
		direction: 'left' | 'right' | 'both',
		wants: number
	): string[] {
		return this.ensure().getNeighbors(key, direction, wants);
	}

	assembleCohortForKey(key: Uint8Array, wants: number): string[] {
		return this.ensure().assembleCohort(key, wants);
	}

	getDiagnostics(): unknown {
		return (this.ensure() as any).getDiagnostics?.();
	}

	neighborDistance(selfId: string, key: Uint8Array, k: number): number {
		return this.ensure().neighborDistance(selfId, key, k);
	}

	getNeighbors(key: Uint8Array, direction: 'left' | 'right' | 'both', wants: number): string[] {
		return this.ensure().getNeighbors(key, direction, wants);
	}

	assembleCohort(key: Uint8Array, wants: number, exclude?: Set<string>): string[] {
		return this.ensure().assembleCohort(key, wants, exclude);
	}

	expandCohort(current: string[], key: Uint8Array, step: number, exclude?: Set<string>): string[] {
		return this.ensure().expandCohort(current, key, step, exclude);
	}

	async ready(): Promise<void> {
		await this.ensure().ready();
	}

	setMode(mode: 'active' | 'passive'): void {
		this.ensure().setMode(mode);
	}

	// Metadata pass-throughs for Arachnode adapter
	setMetadata(metadata: Record<string, any>): void {
		this.ensure().setMetadata(metadata);
	}

	report(evt: ReportEvent): void {
		this.ensure().report(evt);
	}

	getMetadata(peerId: string): Record<string, any> | undefined {
		return this.ensure().getMetadata(peerId);
	}

	listPeers(): Array<{ id: string; metadata?: Record<string, any> }> {
		return this.ensure().listPeers();
	}
}

export function fretService(cfg?: Partial<FretConfig>) {
	return (components: Components & { fret: Libp2pFretService }) => new Libp2pFretService(components as Components, cfg);
}
