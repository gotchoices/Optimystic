import type { Startable } from '@libp2p/interface';
import type { Libp2p } from 'libp2p';
import type { FretConfig, FretService, RouteAndMaybeActV1, NearAnchorV1 } from '../index.js';
import { FretService as CoreFretService } from './fret-service.js';
import { seedDiscovery } from './discovery.js';

type Components = { libp2p: Libp2p };

export class Libp2pFretService implements Startable {
	private inner: FretService | null = null;
	constructor(private readonly components: Components, private readonly cfg?: Partial<FretConfig>) {}
	get [Symbol.toStringTag](): string {
		return '@optimystic/fret';
	}
	private ensure(): FretService {
		if (!this.inner) this.inner = new CoreFretService(this.components.libp2p, this.cfg);
		return this.inner;
	}
	async start(): Promise<void> {
		// Emit any currently known peers to libp2p discovery
		seedDiscovery(this.components.libp2p, (this.inner as any)?.store ?? ({} as any));
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
}

export function fretService(cfg?: Partial<FretConfig>) {
	return (components: Components) => new Libp2pFretService(components, cfg);
}
