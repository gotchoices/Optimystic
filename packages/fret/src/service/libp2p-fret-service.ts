import type { Startable } from '@libp2p/interface';
import type { Libp2p } from 'libp2p';
import type { FretConfig, FretService, RouteAndMaybeActV1, NearAnchorV1, ReportEvent } from '../index.js';
import { FretService as CoreFretService } from './fret-service.js';
import { seedDiscovery } from './discovery.js';

type Components = { libp2p?: Libp2p };

export class Libp2pFretService implements Startable {
	private inner: FretService | null = null;
	private started = false;
	private libp2pRef?: Libp2p;

	constructor(private _components: Components, private readonly cfg?: Partial<FretConfig>) { }

	get [Symbol.toStringTag](): string {
		return '@optimystic/fret';
	}

	setLibp2p(libp2p: Libp2p): void {
		this.libp2pRef = libp2p;
		if (this.started && !this.inner && libp2p) {
			void this.ensureStarted();
		}
	}

	private ensure(): FretService {
		if (!this.libp2pRef) {
			throw new Error('FRET service requires libp2p to be set');
		}
		if (!this.inner) {
			this.inner = new CoreFretService(this.libp2pRef, this.cfg);
		}
		return this.inner;
	}

	async start(): Promise<void> {
		this.started = true;
		await this.ensureStarted();
	}

	private async ensureStarted(): Promise<void> {
		if (!this.libp2pRef) {
			return;
		}
		if (this.inner) {
			seedDiscovery(this.libp2pRef, (this.inner as any)?.store ?? ({} as any));
		}
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
