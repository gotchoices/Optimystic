/**
 * Ticket: debug-logs-cannot-say-which-node-they-came-from
 *
 * Debug log lines from routing (`Libp2pKeyPeerNetwork`) and cluster-repair (`CoordinatorRepo`)
 * decisions carried no indication of which node produced them, which made a shared-process
 * integration test's interleaved log stream unusable for anything node-specific. `createLogger`
 * now accepts an optional peer id suffix; these specs pin that two differently-keyed instances
 * end up on distinct `debug` namespaces, and that omitting the peer id (the single-node/test
 * construction `CoordinatorRepo` has always tolerated) degrades to exactly today's namespace
 * rather than something like `…:undefined`.
 */

import { expect } from 'chai';
import debug from 'debug';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import { CID } from 'multiformats/cid';
import type { PeerId, Libp2p } from '@libp2p/interface';
import type { IRepo, IKeyNetwork, ClusterPeers, ClusterRecord, RepoMessage, FindCoordinatorOptions } from '@optimystic/db-core';
import { createLogger, type Logger } from '../src/logger.js';
import { Libp2pKeyPeerNetwork } from '../src/libp2p-key-network.js';
import { CoordinatorRepo } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { createLibp2pNode } from '../src/libp2p-node.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { captureLog, formatCaptured, hasLine, hasTag, hasTagAtRev } from './support/capture-log.js';

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

/** Reach past the private `log` field the same way the rest of this package's specs reach private members. */
const namespaceOf = (instance: unknown): string => (instance as { log: { namespace: string } }).log.namespace;

function createMockLibp2p(peerId: PeerId): Libp2p {
	return {
		peerId,
		getConnections: () => [],
		getDialQueue: () => [],
		getMultiaddrs: () => [],
		addEventListener: () => { },
		removeEventListener: () => { },
		services: {}
	} as unknown as Libp2p;
}

const noopKeyNetwork: IKeyNetwork = {
	async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		throw new Error('not implemented');
	},
	async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
		return {};
	}
};

const noopStorageRepo: IRepo = {
	async get() { return {}; },
	async pend() { return { success: true, pending: [], blockIds: [] }; },
	async cancel() { },
	async commit() { return { success: true }; }
};

const makeClusterClient = (() => ({})) as unknown as (peerId: PeerId) => ClusterClient;

describe('createLogger peer-id namespacing', () => {
	it('degrades to the bare namespace when no peer id is given', () => {
		expect(createLogger('some-namespace').namespace).to.equal('optimystic:db-p2p:some-namespace');
	});

	it('suffixes the namespace with a truncated peer id', async () => {
		const peerId = await makePeerId();
		const log = createLogger('some-namespace', peerId.toString());
		expect(log.namespace).to.equal(`optimystic:db-p2p:some-namespace:${peerId.toString().substring(0, 12)}`);
	});

	it('Libp2pKeyPeerNetwork instances with different peer ids log under different namespaces', async () => {
		const peerA = await makePeerId();
		const peerB = await makePeerId();
		const networkA = new Libp2pKeyPeerNetwork(createMockLibp2p(peerA), 16, undefined, 'forming');
		const networkB = new Libp2pKeyPeerNetwork(createMockLibp2p(peerB), 16, undefined, 'forming');

		expect(namespaceOf(networkA)).to.not.equal(namespaceOf(networkB));
		expect(namespaceOf(networkA)).to.equal(`optimystic:db-p2p:libp2p-key-network:${peerA.toString().substring(0, 12)}`);
		expect(namespaceOf(networkB)).to.equal(`optimystic:db-p2p:libp2p-key-network:${peerB.toString().substring(0, 12)}`);
	});

	it('CoordinatorRepo with a localPeerId logs under a suffixed namespace', async () => {
		const localPeerId = await makePeerId();
		const repo = new CoordinatorRepo(noopKeyNetwork, makeClusterClient, noopStorageRepo, undefined, undefined, localPeerId);
		expect(namespaceOf(repo)).to.equal(`optimystic:db-p2p:coordinator-repo:${localPeerId.toString().substring(0, 12)}`);
	});

	it('CoordinatorRepo with no localPeerId logs under the original un-suffixed namespace', () => {
		const repo = new CoordinatorRepo(noopKeyNetwork, makeClusterClient, noopStorageRepo);
		expect(namespaceOf(repo)).to.equal('optimystic:db-p2p:coordinator-repo');
	});
});

/**
 * `captureLog` enables a namespace by name, and `debug.enable` without a wildcard matches EXACTLY —
 * so peer-id suffixing silently emptied every capture until the helper was widened to enable both
 * shapes. These pin that seam directly, rather than leaving it to be re-discovered as a wall of
 * "expected false to equal true" in the read-repair specs.
 */
describe('captureLog vs peer-id-suffixed namespaces', () => {
	it('captures both the bare and the peer-id-suffixed form of the namespace', async () => {
		const peerId = await makePeerId();
		const bare = createLogger('capture-probe');
		const suffixed = createLogger('capture-probe', peerId.toString());

		const captured = await captureLog('capture-probe', async () => {
			bare('bare-tag', { rev: 1 });
			suffixed('suffixed-tag', { rev: 2 });
		});

		expect(hasTag(captured, 'bare-tag')).to.equal(true);
		expect(hasTagAtRev(captured, 'suffixed-tag', 2)).to.equal(true);
	});

	it('does not capture a sibling namespace that merely shares a prefix', async () => {
		const sibling = createLogger('capture-probe-sibling');

		const captured = await captureLog('capture-probe', async () => {
			sibling('sibling-tag', { rev: 1 });
		});

		expect(hasTag(captured, 'sibling-tag')).to.equal(false);
	});
});

/**
 * Ticket: address-book-merge-logs-under-two-namespaces (gotchoices/Optimystic#12).
 *
 * `mergePeerAddresses` (`peer-address-book.ts`) is reached from two unrelated ingress points, each
 * historically wired to a DIFFERENT logger factory — the inbound (`ClusterService`) sink came from
 * libp2p's own `components.logger.forComponent(...)`, landing under a bare `db-p2p:*` namespace
 * that `DEBUG=optimystic:db-p2p:*` (what this package's docs tell people to set) never matches. A
 * reporter armed only the outbound half, saw zero inbound merge lines, and concluded the mechanism
 * never ran. These specs pin both ingress paths under the same `optimystic:db-p2p:*` tree so that
 * regression is structurally impossible to reintroduce one call site at a time.
 */
describe('peer-address-book:merge is visible from both ingress paths under one DEBUG filter', () => {
	let node: OptimysticNode | undefined;

	afterEach(async () => {
		const toStop = node;
		node = undefined;
		if (toStop) await toStop.stop();
	});

	/** A bare single node: no relay, no peers — just enough wiring to exercise both ingress points. */
	async function spawnNode(): Promise<OptimysticNode> {
		return await createLibp2pNode({
			port: 0,
			networkName: 'logger-address-book-merge-namespaces',
			bootstrapNodes: [],
			relay: false,
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false }
		});
	}

	/** The record ingress point a cluster service exposes — same narrow cast the relay specs use. */
	interface ClusterIngress {
		processOperation(op: { operation: 'update', record: ClusterRecord }): Promise<unknown>;
	}
	const clusterIngressOf = (n: Libp2p): ClusterIngress =>
		(n as unknown as { services: { cluster: ClusterIngress } }).services.cluster;

	const recordWithPeers = (peers: ClusterPeers): ClusterRecord => ({
		messageHash: 'logger-spec-inbound-merge',
		peers,
		message: { operations: [] } as unknown as RepoMessage,
		promises: {},
		commits: {}
	});

	const ADDR = '/ip4/10.0.0.5/tcp/4001';

	/** One row per ingress point `mergePeerAddresses` is reachable from. */
	const rows: Array<{ what: string, namespace: string, trigger: (n: OptimysticNode, other: PeerId) => Promise<void> }> = [
		{
			what: 'inbound (ClusterService, from the coordinator)',
			namespace: 'optimystic:db-p2p:peer-address-book',
			trigger: async (n, other) => {
				await clusterIngressOf(n).processOperation({
					operation: 'update',
					record: recordWithPeers({ [other.toString()]: { multiaddrs: [ADDR], publicKey: '' } })
				});
			}
		},
		{
			what: 'outbound (Libp2pKeyPeerNetwork.recordPeerAddresses, from ClusterClient/RepoClient)',
			namespace: 'optimystic:db-p2p:libp2p-key-network',
			trigger: async (n, other) => {
				n.keyNetwork.recordPeerAddresses(other, [ADDR]);
			}
		}
	];

	for (const row of rows) {
		it(`${row.what} logs peer-address-book:merge under ${row.namespace}`, async () => {
			node = await spawnNode();
			const other = await makePeerId();

			const captured = await captureLog('*', async () => {
				await row.trigger(node!, other);
			});

			const mergeLine = captured.find(args => hasTag([args], 'peer-address-book:merge'));
			expect(mergeLine, `${row.what} must emit a peer-address-book:merge line`).to.not.equal(undefined);
			// `optimystic:db-p2p:*` is the filter this package's docs tell people to set — asserting the
			// namespace prefix, not merely that SOME line was captured, is what pins the fix: without it
			// this line would sit under the bare `db-p2p:*` tree that filter never matches.
			expect(formatCaptured(mergeLine!), `${row.what} must log under ${row.namespace}`).to.include(row.namespace);
		});
	}

	// The merge line is not the only address-book line the inbound path produces:
	// `mergeRecordPeerAddresses` reports unparseable ids and the per-record cap through the sink
	// `ClusterService` hands it. Those used to go to `this.log.error`, i.e. libp2p's
	// `db-p2p:cluster:error` namespace — same tag family, different tree, same invisibility.
	it('inbound record-traversal warnings log under optimystic:db-p2p:peer-address-book too', async () => {
		node = await spawnNode();

		const captured = await captureLog('*', async () => {
			await clusterIngressOf(node!).processOperation({
				operation: 'update',
				record: recordWithPeers({ 'not-a-peer-id': { multiaddrs: [ADDR], publicKey: '' } })
			});
		});

		const warnLine = captured.find(args => hasTag([args], 'record carried an unparseable peer id'));
		expect(warnLine, 'an unparseable id in record.peers must be reported').to.not.equal(undefined);
		expect(formatCaptured(warnLine!)).to.include('optimystic:db-p2p:peer-address-book');
	});
});

/**
 * Ticket: logger-factory-error-and-formatters.
 *
 * `createLogger` had to grow the two things libp2p's `components.logger.forComponent(...)`
 * provides and it lacked, before any service could be migrated off that second factory: a
 * `.error` sub-channel, and the custom `%p`/`%e`/… format specifiers `@libp2p/logger` registers.
 * Those specifiers live on the `weald` module instance libp2p uses, NOT on the `debug` instance
 * this package uses — so a line reading `'error handling X from %p - %e'` moved onto
 * `createLogger` without this port would print the literal text `%p` and `%e`. These specs pin
 * both halves.
 */
describe('createLogger severity sub-channels', () => {
	it('exposes .error and .trace as child namespaces of the concrete channel', () => {
		const log = createLogger('sub-channel-probe');
		expect(log.namespace).to.equal('optimystic:db-p2p:sub-channel-probe');
		expect(log.error.namespace).to.equal('optimystic:db-p2p:sub-channel-probe:error');
		expect(log.trace.namespace).to.equal('optimystic:db-p2p:sub-channel-probe:trace');
	});

	it('puts the peer-id suffix BEFORE :error, so :error stays a child of the concrete channel', async () => {
		const peerId = await makePeerId();
		const truncated = peerId.toString().substring(0, 12);
		const log = createLogger('sub-channel-probe', peerId.toString());

		expect(log.namespace).to.equal(`optimystic:db-p2p:sub-channel-probe:${truncated}`);
		expect(log.error.namespace).to.equal(`optimystic:db-p2p:sub-channel-probe:${truncated}:error`);
		expect(log.trace.namespace).to.equal(`optimystic:db-p2p:sub-channel-probe:${truncated}:trace`);
	});

	/**
	 * `debug` defines `enabled` as an ACCESSOR on the function object it returns, so it re-reads the
	 * active filter on every access. `createLogger` builds its result with `Object.assign` onto that
	 * object precisely to keep the accessor; a spread into a fresh object would flatten it to a
	 * construction-time snapshot. Nothing in db-p2p gates on `log.enabled` yet, but `db-core` and
	 * `quereus-plugin-optimystic` do use that idiom to skip expensive payload construction, so it
	 * will arrive here — and the regression would be silent.
	 */
	it('keeps `enabled` a live accessor rather than a construction-time snapshot', () => {
		const previousNamespaces = debug.disable();
		try {
			const log = createLogger('enabled-probe');
			expect(log.enabled, 'constructed while nothing is enabled').to.equal(false);

			debug.enable('optimystic:db-p2p:enabled-probe');
			expect(log.enabled, 'the SAME logger object must see the later enable').to.equal(true);
			expect(log.error.enabled, 'an exact-match filter does not reach the :error child').to.equal(false);

			debug.enable('optimystic:db-p2p:enabled-probe:*');
			expect(log.error.enabled, 'a wildcard filter does reach the :error child').to.equal(true);

			debug.disable();
			expect(log.enabled, 'and must see the later disable too').to.equal(false);
		} finally {
			debug.disable();
			if (previousNamespaces) debug.enable(previousNamespaces);
		}
	});

	/**
	 * Step 2 of this work (migrating services off `forComponent`) assumes an existing
	 * `captureLog('<n>', …)` already sees `:error` lines with no helper change — the helper enables
	 * `optimystic:db-p2p:<n>` AND `optimystic:db-p2p:<n>:*`, and `:error` is matched by the latter.
	 * Pinned here rather than left to be re-discovered as empty captures in the migrated specs.
	 */
	it('captureLog(<n>) picks up a line written to the .error child with no helper change', async () => {
		const log = createLogger('error-child-probe');

		const captured = await captureLog('error-child-probe', async () => {
			log('ordinary-tag', { rev: 1 });
			log.error('error-child-tag', { rev: 2 });
		});

		expect(hasTag(captured, 'ordinary-tag')).to.equal(true);
		expect(hasTagAtRev(captured, 'error-child-tag', 2)).to.equal(true);
		expect(hasLine(captured, 'optimystic:db-p2p:error-child-probe:error')).to.equal(true);
	});
});

/**
 * `debug` resolves its OWN formatters and then hands the result to `debug.log`, which is what
 * `captureLog` replaces — so a captured `args[0]` arrives with `%p`/`%e`/`%b` already substituted
 * (unlike `%s`/`%d`, which `console.log` fills in downstream and which is why `formatCaptured`
 * exists). Assertions below therefore read the substituted text directly.
 */
describe('createLogger format specifiers ported from @libp2p/logger', () => {
	/** The substituted text of the single line `fn` is expected to emit under `namespace`. */
	const captureOneLine = async (namespace: string, fn: (log: Logger) => void): Promise<string> => {
		const log = createLogger(namespace);
		const captured = await captureLog(namespace, async () => { fn(log); });
		expect(captured.length, `expected exactly one captured line under ${namespace}`).to.equal(1);
		return formatCaptured(captured[0]!);
	};

	it('substitutes %p (peer id) and %e (error) on the .error channel', async () => {
		const peerId = await makePeerId();
		const err = new Error('inbound handler blew up');

		const text = await captureOneLine('fmt-probe', log => {
			log.error('error handling something from %p - %e', peerId, err);
		});

		// Not merely "a line was captured": before the port these two read as the literal `%p`/`%e`,
		// which is the whole reason this ticket exists.
		expect(text).to.include(peerId.toString());
		expect(text).to.include('inbound handler blew up');
		expect(text).to.not.include('%p');
		expect(text).to.not.include('%e');
	});

	it('substitutes %a (multiaddr) and %c (CID)', async () => {
		const text = await captureOneLine('fmt-probe-ac', log => {
			log('at %a for %c', multiaddr('/ip4/10.0.0.5/tcp/4001'), CID.parse('bafkqaaa'));
		});

		expect(text).to.include('/ip4/10.0.0.5/tcp/4001');
		expect(text).to.include('bafkqaaa');
	});

	it('encodes %b as base58btc, %t as base32 and %m as base64', async () => {
		const bytes = Uint8Array.from([0, 1, 2, 3, 255, 128, 7]);

		const text = await captureOneLine('fmt-probe-bytes', log => {
			log('b58=%b b32=%t b64=%m', bytes, bytes, bytes);
		});

		expect(text).to.include('b58=1W7N4wCi');
		expect(text).to.include('b32=aaaqea77qadq');
		expect(text).to.include('b64=AAECA/+ABw');
	});

	it('renders a plain Error with its message', async () => {
		const text = await captureOneLine('fmt-probe-e', log => {
			log('boom: %e', new Error('a plain error'));
		});
		expect(text).to.include('a plain error');
	});

	/**
	 * A call site can hand `%e` anything — a caught value is `unknown`. A logger that throws turns a
	 * caught error into an uncaught one at exactly the site that was trying to report it, so each of
	 * these must format rather than raise.
	 */
	it('does not throw on non-Error values handed to %e', async () => {
		expect(await captureOneLine('fmt-probe-e-undef', log => { log('%e', undefined); }))
			.to.include('undefined');
		expect(await captureOneLine('fmt-probe-e-missing', log => { log('%e'); }))
			.to.include('undefined');
		expect(await captureOneLine('fmt-probe-e-str', log => { log('%e', 'a bare string'); }))
			.to.include('a bare string');

		const stackless = new Error('no stack here');
		delete (stackless as { stack?: string }).stack;
		expect(await captureOneLine('fmt-probe-e-nostack', log => { log('%e', stackless); }))
			.to.include('no stack here');
	});

	/**
	 * A null-prototype object has no `toString`, so `formatError`'s `${v.toString()}` last resort
	 * raises on it — upstream `@libp2p/logger` propagates that. `createLogger` catches instead,
	 * because every `%e` site in this package is inside a catch block and `catch (err)` binds
	 * `unknown`: `throw Object.create(null)` is legal JavaScript, and a throwing logger would
	 * convert a caught error into an uncaught one at the exact site trying to report it.
	 *
	 * A symbol is NOT in that class — `Symbol.prototype.toString` exists, so `v.toString()` returns
	 * a string and the surrounding template interpolates it safely. (Interpolating the symbol
	 * itself, `${v}`, would throw; `formatError` does not do that.) Pinned so the distinction is
	 * not re-litigated.
	 */
	it('falls back rather than throwing on a value with no usable string conversion', async () => {
		expect(await captureOneLine('fmt-probe-e-nullproto', log => { log('%e', Object.create(null)); }))
			.to.include('[unformattable error]');
		expect(await captureOneLine('fmt-probe-e-symbol', log => { log('%e', Symbol('nope')); }))
			.to.include('Symbol(nope)');
	});

	it('expands each inner error of an AggregateError', async () => {
		const text = await captureOneLine('fmt-probe-agg', log => {
			log('%e', new AggregateError([new Error('first inner'), new Error('second inner')], 'both legs failed'));
		});

		expect(text).to.include('first inner');
		expect(text).to.include('second inner');
		// Without the port `%e` survives literally and `util.format` appends an inspected
		// AggregateError, whose output ALSO contains both inner messages — so the inner-message
		// assertions above pass either way. This is what makes the case a real guard.
		expect(text).to.not.include('%e');
	});

	/**
	 * The empty case is deliberately distinguishable from "the expansion silently did nothing" —
	 * kept from libp2p's port verbatim.
	 */
	it('marks an AggregateError with no inner errors rather than expanding to nothing', async () => {
		const text = await captureOneLine('fmt-probe-agg-empty', log => {
			log('%e', new AggregateError([], 'nothing underneath'));
		});

		expect(text).to.include('[Error list was empty]');
	});
});
