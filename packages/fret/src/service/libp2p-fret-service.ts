import type { Startable } from '@libp2p/interface';
import type { Libp2p } from 'libp2p';
import type { FretConfig, FretService, RouteAndMaybeActV1, NearAnchorV1 } from '../index.js';
import { FretService as CoreFretService } from './fret-service.js';
import { seedDiscovery } from './discovery.js';

type Components = { libp2p: Libp2p };

export class Libp2pFretService implements Startable {
	private inner: FretService | null = null;
  private nodeRef: Libp2p | null = null;
  constructor(private readonly components: Components, private readonly cfg?: Partial<FretConfig>) {}
	get [Symbol.toStringTag](): string {
		return '@optimystic/fret';
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
  /**
   * Allows the hosting application to inject the libp2p node reference
   * prior to start(). This avoids relying on a libp2p-provided "libp2p"
   * component which may not exist in some environments.
   */
  public setLibp2p(node: Libp2p): void {
    this.nodeRef = node;
  }
	async start(): Promise<void> {
    // Ensure inner service is constructed with a valid libp2p instance
    this.ensure();
    // Emit any currently known peers to libp2p discovery
    if (!this.nodeRef) throw new Error('Libp2pFretService.start: libp2p node not injected');
    seedDiscovery(this.nodeRef, (this.inner as any)?.store ?? ({} as any));
		await this.ensure().start();
	}

	async ready(): Promise<void> {
		await this.ensure().ready();
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
    return (components: Components & { fret: Libp2pFretService }) => new Libp2pFretService(components as Components, cfg);
}
