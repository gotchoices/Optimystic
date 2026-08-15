/**
 * Unit rules for the ONE place in this package that writes the libp2p address book.
 *
 * The mechanism it serves is pinned end-to-end elsewhere: `relay-third-party-address-gap.spec.ts`
 * proves a peerStore merge of a carried circuit address is what makes a relay-only cohort sibling
 * dialable at all. These tests pin the guardrails around that merge — self, garbage, volume, and
 * a failing peerStore.
 */
import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import { mergePeerAddresses, validMultiaddrStrings, MAX_MERGED_ADDRS_PER_PEER, type PeerAddressBookHost } from '../src/peer-address-book.js';

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

/** A recording peerStore host. `mergeResult` lets a test make the store reject. */
function makeHost(self: PeerId, mergeResult: () => Promise<unknown> = async () => undefined) {
	const merged: Array<{ id: PeerId, multiaddrs: Multiaddr[] }> = [];
	const host: PeerAddressBookHost = {
		peerId: self,
		peerStore: {
			merge: async (id: PeerId, data: { multiaddrs: Multiaddr[] }) => {
				merged.push({ id, multiaddrs: data.multiaddrs });
				return await mergeResult();
			}
		}
	};
	return { host, merged };
}

/** Collect log lines as formatted-ish strings so a test can assert one was emitted. */
function makeLog() {
	const lines: string[] = [];
	return { log: (fmt: string, ...args: unknown[]) => { lines.push([fmt, ...args.map(String)].join(' ')); }, lines };
}

/** N distinct, valid multiaddrs. */
const addrs = (n: number): string[] =>
	Array.from({ length: n }, (_, i) => `/ip4/127.0.0.1/tcp/${4001 + i}`);

/** Let the `void`-ed merge promise and its `.catch` settle. */
const flush = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)); };

describe('peer-address-book', () => {
	describe('validMultiaddrStrings', () => {
		it('keeps parseable addresses and drops (with a WARN) the rest', () => {
			const { log, lines } = makeLog();
			const kept = validMultiaddrStrings(['/ip4/127.0.0.1/tcp/4001', 'not-a-multiaddr', '/dns4/example.com/tcp/443/wss'], log);
			expect(kept).to.deep.equal(['/ip4/127.0.0.1/tcp/4001', '/dns4/example.com/tcp/443/wss']);
			expect(lines.filter(l => l.startsWith('WARN: invalid multiaddr'))).to.have.length(1);
		});
	});

	describe('mergePeerAddresses', () => {
		it('merges a relay-qualified circuit address for another peer', async () => {
			const self = await makePeerId();
			const relay = await makePeerId();
			const other = await makePeerId();
			const { host, merged } = makeHost(self);
			const { log } = makeLog();

			// The exact address shape a relay-only cohort member carries in `ClusterRecord.peers`.
			const circuit = `/ip4/127.0.0.1/tcp/60609/ws/p2p/${relay.toString()}/p2p-circuit`;
			mergePeerAddresses(host, other, [circuit], log);

			expect(merged).to.have.length(1);
			expect(merged[0]!.id.toString()).to.equal(other.toString());
			expect(merged[0]!.multiaddrs.map(m => m.toString())).to.deep.equal([circuit]);
		});

		it('never merges for self', async () => {
			const self = await makePeerId();
			const { host, merged } = makeHost(self);
			const { log } = makeLog();

			mergePeerAddresses(host, self, addrs(2), log);

			expect(merged, 'a self entry is meaningless to our own dialer').to.have.length(0);
		});

		it('drops unparseable addresses (and logs them) rather than throwing', async () => {
			const self = await makePeerId();
			const other = await makePeerId();
			const { host, merged } = makeHost(self);
			const { log, lines } = makeLog();

			// '' parses as the root multiaddr `/` — syntactically valid, addresses nothing.
			mergePeerAddresses(host, other, ['/ip4/127.0.0.1/tcp/4001', 'garbage', ''], log);

			expect(merged).to.have.length(1);
			expect(merged[0]!.multiaddrs.map(m => m.toString())).to.deep.equal(['/ip4/127.0.0.1/tcp/4001']);
			expect(lines.filter(l => l.startsWith('WARN: invalid multiaddr'))).to.have.length(1);
			expect(lines.filter(l => l.startsWith('WARN: multiaddr addresses nothing'))).to.have.length(1);
		});

		it('does not touch the peerStore when every address is unparseable', async () => {
			const self = await makePeerId();
			const other = await makePeerId();
			const { host, merged } = makeHost(self);
			const { log } = makeLog();

			mergePeerAddresses(host, other, ['garbage', 'also-garbage'], log);

			expect(merged).to.have.length(0);
		});

		it(`caps a single message's addresses at MAX_MERGED_ADDRS_PER_PEER (${MAX_MERGED_ADDRS_PER_PEER})`, async () => {
			const self = await makePeerId();
			const other = await makePeerId();
			const { host, merged } = makeHost(self);
			const { log, lines } = makeLog();

			mergePeerAddresses(host, other, addrs(MAX_MERGED_ADDRS_PER_PEER + 5), log);

			expect(merged).to.have.length(1);
			expect(merged[0]!.multiaddrs).to.have.length(MAX_MERGED_ADDRS_PER_PEER);
			expect(lines.some(l => l.includes('peer-address-book:capped')), 'a truncation must be visible, not silent').to.equal(true);
		});

		it('logs a rejected peerStore.merge and does not rethrow', async () => {
			const self = await makePeerId();
			const other = await makePeerId();
			const { host } = makeHost(self, async () => { throw new Error('peerStore is broken'); });
			const { log, lines } = makeLog();

			// Synchronous by contract: nothing downstream awaits the address book.
			expect(() => mergePeerAddresses(host, other, addrs(1), log)).to.not.throw();
			await flush();

			expect(lines.some(l => l.startsWith('WARN: peerStore.merge failed')), 'a persistently failing peerStore is exactly what would make this mechanism silently inert').to.equal(true);
		});

		it('is a no-op on a host with no peerStore.merge', async () => {
			const self = await makePeerId();
			const other = await makePeerId();
			const { log } = makeLog();

			expect(() => mergePeerAddresses({ peerId: self }, other, addrs(1), log)).to.not.throw();
		});

		it('is a no-op for an empty address list', async () => {
			const self = await makePeerId();
			const other = await makePeerId();
			const { host, merged } = makeHost(self);
			const { log } = makeLog();

			mergePeerAddresses(host, other, [], log);

			expect(merged).to.have.length(0);
		});
	});
});
