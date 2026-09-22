/**
 * Node-level wiring for `NodeOptions.noiseCrypto`.
 *
 * Two real nodes over loopback TCP. A is given crypto primitives with call counters wrapped around
 * the handshake hash and the per-frame cipher; B is given none, so it runs Noise's default. One ping
 * from B to A must succeed — that is the interoperability claim, since the option swaps local
 * primitives and leaves the wire protocol alone — and A's counters must have moved, which is what
 * proves the supplied primitives are the ones Noise actually ran.
 */
import { expect } from 'chai';
import type { Ping } from '@libp2p/ping';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode } from '../src/libp2p-node.js';
import { noisePureJsCrypto, type NoiseCryptoInterface } from '../src/noise-crypto.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { pickLocalTcpMultiaddr } from './util/multiaddrs.js';

/** Distinct per-spec so concurrent specs on network-scoped protocol ids cannot cross-talk. */
const NETWORK = 'noise-crypto-node-wiring';

type Counts = { hashSHA256: number; chaCha20Poly1305Encrypt: number };

function countingCrypto(): { crypto: NoiseCryptoInterface; counts: Counts } {
	const counts: Counts = { hashSHA256: 0, chaCha20Poly1305Encrypt: 0 };
	const crypto: NoiseCryptoInterface = {
		...noisePureJsCrypto,
		hashSHA256: data => {
			counts.hashSHA256++;
			return noisePureJsCrypto.hashSHA256(data);
		},
		chaCha20Poly1305Encrypt: (plaintext, nonce, ad, k) => {
			counts.chaCha20Poly1305Encrypt++;
			return noisePureJsCrypto.chaCha20Poly1305Encrypt(plaintext, nonce, ad, k);
		}
	};
	return { crypto, counts };
}

describe('noiseCrypto — node-level wiring', function () {
	// Two real libp2p boots dominate.
	this.timeout(60_000);

	const nodes: OptimysticNode[] = [];

	async function spawn(extra: { noiseCrypto?: NoiseCryptoInterface } = {}): Promise<OptimysticNode> {
		const node = await createLibp2pNode({
			port: 0,
			networkName: NETWORK,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false },
			...extra
		});
		nodes.push(node);
		return node;
	}

	afterEach(async () => {
		await Promise.allSettled(nodes.splice(0).map(node => node.stop()));
	});

	it('runs the supplied primitives and interoperates with a node on the default', async () => {
		const { crypto, counts } = countingCrypto();
		const a = await spawn({ noiseCrypto: crypto });
		const b = await spawn();

		const rtt = await (b.services.ping as Ping).ping(multiaddr(pickLocalTcpMultiaddr(a)));

		expect(rtt, 'B completed a ping over the Noise session with A').to.be.a('number');
		expect(counts.hashSHA256, "A's handshake hashed through the supplied crypto").to.be.greaterThan(0);
		expect(counts.chaCha20Poly1305Encrypt, "A's frames were encrypted through the supplied crypto")
			.to.be.greaterThan(0);
	});
});
