/**
 * Post-start rollback: a failure anywhere between `node.start()` and the successful return of
 * `createLibp2pNodeBase` must leave nothing running.
 *
 * `createLibp2pNodeBase` starts the libp2p node early and then does ~930 lines of async wiring
 * against the already-started node. A rejection out of that span hands the caller an error and NO
 * node handle, so if the node is still running the caller cannot stop it: the TCP listener stays
 * bound, and the leaked timers/handles keep the process alive. The factory therefore wraps its
 * whole post-start body in a rollback `catch` that stops the node before rethrowing.
 *
 * These are class tests, not one-offs: they pin "a post-start failure releases the port" for ANY
 * setup step added to this factory later, wherever in the span it lands.
 *
 * NOTE (operational hazard): when the port assertion below FAILS, the leaked node's open handles
 * keep the mocha process alive, so `yarn test` hangs at exit instead of returning a failure. Debug
 * such a run with `--exit`. Do NOT add `--exit` to the package's `test` script — that would mask
 * unrelated handle leaks across the whole suite.
 */
import { expect } from 'chai';
import net from 'node:net';
import { createLibp2pNode } from '../src/libp2p-node.js';
import { DEFAULT_COHORT_TOPIC_PROTOCOLS } from '../src/cohort-topic/protocols.js';

/** Bind an ephemeral port, read what the OS chose, release it. */
async function freePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (address === null || typeof address === 'string') {
				server.close(() => reject(new Error('no ephemeral port assigned')));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

/**
 * True when `port` can be bound again. Binds 0.0.0.0 (the same wildcard the node listens on) so a
 * node still holding `/ip4/0.0.0.0/tcp/<port>` is detected as EADDRINUSE.
 */
async function portIsFree(port: number): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.listen(port, '0.0.0.0', () => {
			server.close(() => resolve(true));
		});
	});
}

describe('createLibp2pNode post-start rollback', function () {
	this.timeout(40_000);

	it('a failure after node.start() rejects AND stops the node (listener port released)', async () => {
		const port = await freePort();

		let rejected: unknown;
		try {
			await createLibp2pNode({
				bootstrapNodes: [],
				networkName: 'test-startup-rollback',
				port,
				arachnode: { enableRingZulu: false },
				// Libp2pKeyPeerNetwork.initFromPersistedState() awaits persistence.load() AFTER
				// node.start() — the first throwable step of the post-start span, and the site that
				// originally leaked the started node.
				persistence: {
					load: async () => { throw new Error('corrupt persisted state'); },
					save: async () => { /* never reached */ },
				},
			});
		} catch (err) {
			rejected = err;
		}

		expect(rejected, 'node creation rejected').to.be.instanceOf(Error);
		// The ORIGINAL error, never a rollback error.
		expect((rejected as Error).message).to.equal('corrupt persisted state');
		expect(await portIsFree(port), 'listener port released (the node was stopped)').to.equal(true);
	});

	it('a cohort-topic host construction failure also rolls back (listener port released)', async () => {
		const port = await freePort();

		let rejected: unknown;
		try {
			await createLibp2pNode({
				bootstrapNodes: [],
				networkName: 'test-startup-rollback-cohort',
				port,
				arachnode: { enableRingZulu: false },
				cohortTopic: {
					enabled: true,
					host: {
						// Two cohort protocols sharing one ID: `createCohortTopicHost` registers its five
						// handlers with `node.handle`, and libp2p's registrar rejects a duplicate protocol
						// (DuplicateProtocolHandlerError). That makes host construction fail deep inside the
						// cohort-topic activation block — the far end of the post-start span, well past the
						// point where earlier rollback wrappers were installed.
						protocols: {
							...DEFAULT_COHORT_TOPIC_PROTOCOLS,
							gossip: DEFAULT_COHORT_TOPIC_PROTOCOLS.register,
						},
					},
				},
			});
		} catch (err) {
			rejected = err;
		}

		expect(rejected, 'node creation rejected').to.be.instanceOf(Error);
		// Pin WHICH failure this exercises, so the test cannot start passing because the node rejected
		// earlier (before the cohort block) for an unrelated reason.
		expect((rejected as Error).name).to.equal('DuplicateProtocolHandlerError');
		expect((rejected as Error).message).to.contain('/optimystic/cohort-topic/1.0.0/register');
		expect(await portIsFree(port), 'listener port released (the node was stopped)').to.equal(true);
	});
});
