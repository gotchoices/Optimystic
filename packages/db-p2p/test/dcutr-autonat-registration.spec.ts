/**
 * Always-run smoke spec for the DCUtR + AutoNAT service registration added to
 * `createLibp2pNodeBase` (see `libp2p-node-base.ts`). These services are
 * additive and always-on; this spec proves they wire up on a spawned node and
 * that the browser-shaped (custom-transports, WS-only) spawn path still builds.
 *
 * The behavioral hole-punch scenario is exercised by the slow, gated
 * `dcutr-direct-upgrade.spec.ts`; this one only asserts presence.
 */
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { createLibp2pNode, type Libp2pTransports } from '../src/libp2p-node.js';

describe('DCUtR + AutoNAT registration', () => {

	it('a default (TCP) node exposes services.dcutr and services.autoNAT', async () => {
		const node = await createLibp2pNode({
			bootstrapNodes: [],
			networkName: 'test-dcutr-autonat',
			arachnode: { enableRingZulu: false }
		});
		try {
			const services = (node as Libp2p & { services: Record<string, unknown> }).services;
			expect(services.dcutr, 'services.dcutr should be registered').to.not.equal(undefined);
			expect(services.autoNAT, 'services.autoNAT should be registered').to.not.equal(undefined);
		} finally {
			await node.stop();
		}
	});

	it('a browser-shaped (WS-only custom transports) node still builds with the services', async () => {
		const transports: Libp2pTransports = [webSockets(), circuitRelayTransport()];
		const node = await createLibp2pNode({
			bootstrapNodes: [],
			networkName: 'test-dcutr-autonat-browser',
			transports,
			listenAddrs: [],
			arachnode: { enableRingZulu: false }
		});
		try {
			const services = (node as Libp2p & { services: Record<string, unknown> }).services;
			expect(services.dcutr, 'services.dcutr should be registered on browser-shaped node').to.not.equal(undefined);
			expect(services.autoNAT, 'services.autoNAT should be registered on browser-shaped node').to.not.equal(undefined);
		} finally {
			await node.stop();
		}
	});
});
