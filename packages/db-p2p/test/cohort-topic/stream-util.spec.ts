import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { requestResponse, sendOneWay } from '../../src/cohort-topic/stream-util.js';

/**
 * libp2p rejects opening a protocol stream over a *limited* (circuit-relay) connection unless the
 * caller passes `runOnLimitedConnection: true`. A cohort member reachable only through a relay
 * (the normal case for a NAT'd/mobile peer) must still be dialable for cohort-topic exchanges, so
 * both stream helpers must opt in on every dial path — reused connection and fresh dial alike.
 */
describe('cohort-topic: stream-util opts in to limited (relayed) connections', () => {
	function makeStream() {
		return {
			send: () => {},
			close: async () => {},
			[Symbol.asyncIterator]: async function* () {
				/* immediately closed — no frame */
			},
		} as any;
	}

	it('requestResponse passes runOnLimitedConnection:true when reusing an existing connection', async () => {
		const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
		let capturedOptions: any;
		const conn = {
			newStream: (_protocols: string[], options?: any) => {
				capturedOptions = options;
				return Promise.resolve(makeStream());
			},
		};
		const node = {
			getConnections: () => [conn],
			dialProtocol: () => {
				throw new Error('should not dial fresh when a connection is reused');
			},
		} as any;

		await requestResponse(node, peerId, '/test/1.0.0', new Uint8Array([1]));

		expect(capturedOptions).to.deep.include({ runOnLimitedConnection: true });
	});

	it('requestResponse passes runOnLimitedConnection:true when dialing fresh', async () => {
		const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
		let capturedOptions: any;
		const node = {
			getConnections: () => [],
			dialProtocol: (_peer: unknown, _protocols: string[], options?: any) => {
				capturedOptions = options;
				return Promise.resolve(makeStream());
			},
		} as any;

		await requestResponse(node, peerId, '/test/1.0.0', new Uint8Array([1]));

		expect(capturedOptions).to.deep.include({ runOnLimitedConnection: true });
	});

	it('sendOneWay passes runOnLimitedConnection:true on both the reuse and fresh-dial paths', async () => {
		const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

		let reuseOptions: any;
		const conn = {
			newStream: (_protocols: string[], options?: any) => {
				reuseOptions = options;
				return Promise.resolve(makeStream());
			},
		};
		const nodeReuse = { getConnections: () => [conn], dialProtocol: () => { throw new Error('unexpected'); } } as any;
		await sendOneWay(nodeReuse, peerId, '/test/1.0.0', new Uint8Array([1]));
		expect(reuseOptions).to.deep.include({ runOnLimitedConnection: true });

		let dialOptions: any;
		const nodeDial = {
			getConnections: () => [],
			dialProtocol: (_peer: unknown, _protocols: string[], options?: any) => {
				dialOptions = options;
				return Promise.resolve(makeStream());
			},
		} as any;
		await sendOneWay(nodeDial, peerId, '/test/1.0.0', new Uint8Array([1]));
		expect(dialOptions).to.deep.include({ runOnLimitedConnection: true });
	});
});
