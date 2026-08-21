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
import { CID } from 'multiformats/cid';
import * as Digest from 'multiformats/hashes/digest';
import { base58btc } from 'multiformats/bases/base58';
import { classifySelfDialability, mergePeerAddresses, mergeRecordPeerAddresses, publishableConnectionAddr, routesThroughRelay, validMultiaddrStrings, MAX_MERGED_ADDRS_PER_PEER, MAX_LEARNED_PEERS_PER_RECORD, type PeerAddressBookHost, type SelfDialability } from '../src/peer-address-book.js';

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

/** Multicodec for `libp2p-key`, the codec a peer id's CIDv1 spelling carries. */
const LIBP2P_KEY_CODEC = 0x72;

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

	/**
	 * Ticket: findcluster-publishes-inbound-source-addresses (gotchoices/Optimystic#13).
	 *
	 * `validMultiaddrStrings` answers "may we CARRY this string"; this answers "may we HAND this
	 * connection's address to a third party". The two differ on exactly one axis — direction —
	 * because an inbound connection's `remoteAddr` is the far side's ephemeral source socket
	 * rather than anything it listens on. Table-driven over the address forms that actually occur,
	 * so a future edit cannot quietly reintroduce a permissive rule for one of them.
	 */
	describe('publishableConnectionAddr', () => {
		// `{RELAY}` / `{DIALER}` are substituted with freshly generated peer ids inside each case:
		// a `/p2p/` component only parses if it is a real peer id, so a placeholder literal would
		// make the circuit rows fail as *unparseable* and silently stop testing direction at all.
		const cases: Array<{ what: string, direction: 'inbound' | 'outbound' | undefined, addr: string | undefined, publishable: boolean }> = [
			{ what: 'a direct address we dialed', direction: 'outbound', addr: '/ip4/10.0.0.5/tcp/4001', publishable: true },
			{ what: 'a circuit address we dialed through a relay', direction: 'outbound', addr: '/ip4/10.0.0.9/tcp/4001/p2p/{RELAY}/p2p-circuit', publishable: true },
			{ what: 'the source socket of a direct connection they dialed', direction: 'inbound', addr: '/ip4/127.0.0.1/tcp/58247/ws', publishable: false },
			// Composed by @libp2p/circuit-relay-v2 as <our own hop to the relay> + /p2p-circuit/p2p/<dialer>,
			// so it is only dialable if OUR hop was outbound. The good version of this address reaches us
			// through identify instead, so keeping it here would buy nothing and reintroduce the same class
			// of bug one hop down.
			{ what: 'the composed address of a relayed connection they dialed', direction: 'inbound', addr: '/ip4/10.0.0.9/tcp/4001/p2p/{RELAY}/p2p-circuit/p2p/{DIALER}', publishable: false },
			{ what: 'an outbound connection with an unparseable address', direction: 'outbound', addr: 'not-a-multiaddr', publishable: false },
			// The empty string parses as the root multiaddr `/` and encodes to zero bytes.
			{ what: 'an outbound connection with an empty address', direction: 'outbound', addr: '', publishable: false },
			{ what: 'an outbound connection with no address at all', direction: 'outbound', addr: undefined, publishable: false },
			// Real libp2p always sets `direction`; a stub that omits it must NOT inherit the old,
			// permissive behavior by default.
			{ what: 'a connection that declares no direction', direction: undefined, addr: '/ip4/10.0.0.5/tcp/4001', publishable: false }
		];

		for (const c of cases) {
			it(`${c.publishable ? 'publishes' : 'refuses'} ${c.what}`, async () => {
				const relay = await makePeerId();
				const dialer = await makePeerId();
				const addr = c.addr?.replace('{RELAY}', relay.toString()).replace('{DIALER}', dialer.toString());
				const { log } = makeLog();
				const conn = {
					direction: c.direction,
					...(addr === undefined ? {} : { remoteAddr: { toString: () => addr } })
				};
				expect(publishableConnectionAddr(conn, log)).to.equal(c.publishable ? addr : undefined);
			});
		}
	});

	/**
	 * Ticket: relay-cannot-dial-its-own-reservation-holders (gotchoices/Optimystic#14).
	 *
	 * The third question about an address, after "may we carry it" and "may we publish it": can
	 * THIS node dial it? A relay learns its reservation holders only by the address they advertise,
	 * `/<relay's transport addr>/p2p/<relay's peer id>/p2p-circuit` — correct for everyone but the
	 * relay itself, which would have to relay to the client through itself.
	 *
	 * Table-driven over the address forms libp2p actually produces, because the tempting
	 * implementation (a substring test for `/p2p/<self>/p2p-circuit`) gets several of them wrong:
	 * the peer id appended after the marker, a circuit with no relay named, and the case that
	 * matters most operationally — a relay-only node of our own, whose peers' addresses route
	 * through SOMEONE ELSE and must not trip the check.
	 */
	describe('routesThroughRelay', () => {
		// `{SELF}` / `{OTHER}` / `{TARGET}` are substituted with freshly generated peer ids: a
		// `/p2p/` component only parses if it holds a real peer id, so a literal placeholder would
		// make every circuit row fail as *unparseable* and stop testing routing at all.
		const cases: Array<{ what: string, addr: string, throughSelf: boolean }> = [
			{ what: "a reservation holder's address on our own relay", addr: '/ip4/10.0.0.1/tcp/4001/p2p/{SELF}/p2p-circuit', throughSelf: true },
			{ what: "the same address with the target peer id appended (libp2p's dial queue does this)", addr: '/ip4/10.0.0.1/tcp/4001/p2p/{SELF}/p2p-circuit/p2p/{TARGET}', throughSelf: true },
			{ what: 'a circuit with no transport prefix at all', addr: '/p2p/{SELF}/p2p-circuit/p2p/{TARGET}', throughSelf: true },
			// The case a relay-only node of ours lives in every day: our peers are reachable
			// through THEIR relay, not ours. Writing the predicate backwards makes this fire and
			// takes the node permanently offline.
			{ what: "a peer reachable through somebody else's relay", addr: '/ip4/10.0.0.9/tcp/4001/p2p/{OTHER}/p2p-circuit/p2p/{TARGET}', throughSelf: false },
			{ what: 'a plain direct address', addr: '/ip4/10.0.0.5/tcp/4001/p2p/{TARGET}', throughSelf: false },
			// Multi-hop: a chain that passes through us at ANY hop is one we cannot open ourselves.
			{ what: 'a two-hop circuit whose FIRST relay is us', addr: '/ip4/10.0.0.1/tcp/4001/p2p/{SELF}/p2p-circuit/p2p/{OTHER}/p2p-circuit/p2p/{TARGET}', throughSelf: true },
			{ what: 'a two-hop circuit whose SECOND relay is us', addr: '/ip4/10.0.0.9/tcp/4001/p2p/{OTHER}/p2p-circuit/p2p/{SELF}/p2p-circuit/p2p/{TARGET}', throughSelf: true },
			{ what: 'a two-hop circuit through two other relays', addr: '/ip4/10.0.0.9/tcp/4001/p2p/{OTHER}/p2p-circuit/p2p/{TARGET}/p2p-circuit/p2p/{TARGET}', throughSelf: false },
			// No `p2p` component precedes the marker, so no relay is named and none can be ours.
			{ what: 'a circuit that names no relay', addr: '/ip4/10.0.0.9/tcp/4001/p2p-circuit', throughSelf: false },
			{ what: 'a bare /p2p-circuit', addr: '/p2p-circuit', throughSelf: false },
			// Our own peer id appearing anywhere OTHER than the relay slot is not a self-relay:
			// this is the address of a peer reached through the relay `{OTHER}`, which happens to
			// be us as the *target*. A substring test on `/p2p/<self>/` would get this wrong.
			{ what: 'our own peer id in the TARGET slot rather than the relay slot', addr: '/ip4/10.0.0.9/tcp/4001/p2p/{OTHER}/p2p-circuit/p2p/{SELF}', throughSelf: false },
			// `{SELF_CID}` is our own peer id written as a CIDv1 libp2p-key string — the other legal
			// spelling of a `/p2p/` value. `@multiformats/multiaddr` keeps it verbatim instead of
			// normalizing to base58btc, so a plain string comparison against `PeerId.toString()`
			// misses it. Addresses reaching the peerStore from the wire (`mergePeerAddresses`) can
			// be spelled either way.
			{ what: 'our own relay written as a CIDv1 peer id', addr: '/ip4/10.0.0.1/tcp/4001/p2p/{SELF_CID}/p2p-circuit/p2p/{TARGET}', throughSelf: true },
			{ what: 'somebody else’s relay written as a CIDv1 peer id', addr: '/ip4/10.0.0.9/tcp/4001/p2p/{OTHER_CID}/p2p-circuit/p2p/{TARGET}', throughSelf: false }
		];

		/** A peer id in its CIDv1 libp2p-key spelling — the same identity, a different string. */
		const asCidV1 = (id: PeerId): string =>
			CID.createV1(LIBP2P_KEY_CODEC, Digest.decode(base58btc.decode(`z${id.toString()}`))).toString();

		for (const c of cases) {
			it(`${c.throughSelf ? 'flags' : 'clears'} ${c.what}`, async () => {
				const self = await makePeerId();
				const other = await makePeerId();
				const target = await makePeerId();
				const addr = c.addr
					.replaceAll('{SELF_CID}', asCidV1(self))
					.replaceAll('{OTHER_CID}', asCidV1(other))
					.replaceAll('{SELF}', self.toString())
					.replaceAll('{OTHER}', other.toString())
					.replaceAll('{TARGET}', target.toString());
				const { log } = makeLog();
				expect(routesThroughRelay(addr, self.toString(), log)).to.equal(c.throughSelf);
			});
		}

		it('fails open (and logs) on an address it cannot parse', async () => {
			// Not evidence of a self-relay loop — and treating it as one would replace a dial
			// libp2p would have rejected on its own with a hard error of ours.
			const self = await makePeerId();
			const { log, lines } = makeLog();
			expect(routesThroughRelay('not-a-multiaddr', self.toString(), log)).to.equal(false);
			expect(lines.filter(l => l.startsWith('WARN: invalid multiaddr'))).to.have.length(1);
		});
	});

	describe('classifySelfDialability', () => {
		const SELF_RELAY = '/ip4/10.0.0.1/tcp/4001/p2p/{SELF}/p2p-circuit';
		const OTHER_RELAY = '/ip4/10.0.0.9/tcp/4001/p2p/{OTHER}/p2p-circuit/p2p/{TARGET}';
		const DIRECT = '/ip4/10.0.0.5/tcp/4001/p2p/{TARGET}';

		const cases: Array<{ what: string, addrs: string[], verdict: SelfDialability }> = [
			{ what: 'no addresses at all', addrs: [], verdict: 'none' },
			{ what: 'only addresses relayed through us', addrs: [SELF_RELAY, SELF_RELAY + '/p2p/{TARGET}'], verdict: 'self-relay-only' },
			// The mixed case is the one that must NOT fail fast: a peer with a direct address is
			// dialable regardless of how many useless circuit addresses sit beside it.
			{ what: 'a direct address alongside a self-relay one', addrs: [SELF_RELAY, DIRECT], verdict: 'dialable' },
			{ what: "an address through somebody else's relay", addrs: [OTHER_RELAY], verdict: 'dialable' },
			{ what: 'only direct addresses', addrs: [DIRECT], verdict: 'dialable' },
			// An address we cannot parse resolves the same way it does one level down, in
			// `routesThroughRelay`: fail open. The verdict must be `dialable`, not
			// `self-relay-only` — otherwise one garbage entry beside a self-relay one would
			// turn a dial libp2p would have rejected on its own into a hard refusal of ours.
			{ what: 'an unparseable address on its own', addrs: ['not-a-multiaddr'], verdict: 'dialable' },
			{ what: 'an unparseable address beside a self-relay one', addrs: [SELF_RELAY, 'not-a-multiaddr'], verdict: 'dialable' }
		];

		for (const c of cases) {
			it(`classifies ${c.what} as ${c.verdict}`, async () => {
				const self = await makePeerId();
				const other = await makePeerId();
				const target = await makePeerId();
				const addrs = c.addrs.map(a => a
					.replaceAll('{SELF}', self.toString())
					.replaceAll('{OTHER}', other.toString())
					.replaceAll('{TARGET}', target.toString()));
				const { log } = makeLog();
				expect(classifySelfDialability(addrs, self.toString(), log)).to.equal(c.verdict);
			});
		}
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

	/**
	 * The record traversal is shared by both ingress points, and it runs on a record NOTHING has
	 * validated: `ClusterService.processOperation` learns before `checkRedirect` and before
	 * `cluster.update` checks a signature, and inbound stream authorization is opt-in. So the
	 * peer map is attacker-authored, and the number of peers it may introduce has to be bounded
	 * here — the per-peer address cap does not bound the number of PEERS.
	 */
	describe('mergeRecordPeerAddresses', () => {
		const ADDR = '/ip4/10.0.0.5/tcp/5001';

		/** Sink recording every (peer, addrs) offer, in order. */
		const makeSink = () => {
			const offers: Array<{ peer: string, addrs: string[] }> = [];
			return { offers, sink: (pid: PeerId, addrs: string[]) => { offers.push({ peer: pid.toString(), addrs }); } };
		};

		it('offers each addressed peer and skips the addressless ones', async () => {
			const withAddrs = await makePeerId();
			const without = await makePeerId();
			const { offers, sink } = makeSink();
			const { log } = makeLog();

			mergeRecordPeerAddresses({
				[withAddrs.toString()]: { multiaddrs: [ADDR] },
				[without.toString()]: { multiaddrs: [] },
			}, sink, log);

			expect(offers).to.deep.equal([{ peer: withAddrs.toString(), addrs: [ADDR] }]);
		});

		it('skips the peer id given as skipId', async () => {
			const self = await makePeerId();
			const other = await makePeerId();
			const { offers, sink } = makeSink();
			const { log } = makeLog();

			mergeRecordPeerAddresses({
				[self.toString()]: { multiaddrs: [ADDR] },
				[other.toString()]: { multiaddrs: [ADDR] },
			}, sink, log, self.toString());

			expect(offers.map(o => o.peer)).to.deep.equal([other.toString()]);
		});

		it('logs and skips an unparseable peer id without throwing', () => {
			const { offers, sink } = makeSink();
			const { log, lines } = makeLog();

			expect(() => mergeRecordPeerAddresses({ 'not-a-peer-id': { multiaddrs: [ADDR] } }, sink, log)).to.not.throw();

			expect(offers).to.have.length(0);
			expect(lines.filter(l => l.startsWith('WARN: record carried an unparseable peer id'))).to.have.length(1);
		});

		it('tolerates a missing peer map and a missing multiaddrs field', () => {
			const { offers, sink } = makeSink();
			const { log } = makeLog();

			mergeRecordPeerAddresses(undefined, sink, log);
			mergeRecordPeerAddresses({ 'x': undefined }, sink, log);

			expect(offers).to.have.length(0);
		});

		it(`caps one record at MAX_LEARNED_PEERS_PER_RECORD (${MAX_LEARNED_PEERS_PER_RECORD}) peers`, async () => {
			const ids = await Promise.all(
				Array.from({ length: MAX_LEARNED_PEERS_PER_RECORD + 5 }, async () => (await makePeerId()).toString())
			);
			const peers = Object.fromEntries(ids.map(id => [id, { multiaddrs: [ADDR] }]));
			const { offers, sink } = makeSink();
			const { log, lines } = makeLog();

			mergeRecordPeerAddresses(peers, sink, log);

			expect(offers, 'an unvalidated record must not be able to introduce unbounded peers')
				.to.have.length(MAX_LEARNED_PEERS_PER_RECORD);
			expect(lines.some(l => l.includes('peer-address-book:record-capped')), 'truncation must be visible').to.equal(true);
		});

		it('counts candidates, not successes, so unparseable ids cannot spend the budget', () => {
			// A record of nothing but garbage ids: the cap must stop the traversal anyway, rather
			// than parsing (and logging) every entry an attacker chose to send.
			const peers = Object.fromEntries(
				Array.from({ length: MAX_LEARNED_PEERS_PER_RECORD + 20 }, (_, i) => [`garbage-${i}`, { multiaddrs: [ADDR] }])
			);
			const { offers, sink } = makeSink();
			const { log, lines } = makeLog();

			mergeRecordPeerAddresses(peers, sink, log);

			expect(offers).to.have.length(0);
			expect(lines.filter(l => l.startsWith('WARN: record carried an unparseable peer id')))
				.to.have.length(MAX_LEARNED_PEERS_PER_RECORD);
		});
	});
});
