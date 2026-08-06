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

/**
 * Run a node creation that is expected to reject, and return the rejection. If the factory instead
 * SUCCEEDS the returned node is stopped before failing the assertion — otherwise the very leak these
 * tests exist to catch would hang mocha on the way to reporting the failure.
 */
async function rejectionFrom(options: Parameters<typeof createLibp2pNode>[0]): Promise<Error> {
	let node: Awaited<ReturnType<typeof createLibp2pNode>> | undefined;
	try {
		node = await createLibp2pNode(options);
	} catch (err) {
		return err as Error;
	}
	await node.stop();
	throw new Error('expected createLibp2pNode to reject, but it resolved');
}

describe('createLibp2pNode post-start rollback', function () {
	this.timeout(40_000);

	it('a failure after node.start() rejects AND stops the node (listener port released)', async () => {
		const port = await freePort();

		const rejected = await rejectionFrom({
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

		// The ORIGINAL error, never a rollback error.
		expect(rejected.message).to.equal('corrupt persisted state');
		expect(await portIsFree(port), 'listener port released (the node was stopped)').to.equal(true);
	});

	it('a cohort-topic host construction failure also rolls back (listener port released)', async () => {
		const port = await freePort();

		const rejected = await rejectionFrom({
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

		// Pin WHICH failure this exercises, so the test cannot start passing because the node rejected
		// earlier (before the cohort block) for an unrelated reason.
		expect(rejected.name).to.equal('DuplicateProtocolHandlerError');
		expect(rejected.message).to.contain('/optimystic/cohort-topic/1.0.0/register');
		expect(await portIsFree(port), 'listener port released (the node was stopped)').to.equal(true);
	});

	// NOT covered here: the `cohortTopic enabled but the FRET service is unavailable` hard-fail and the
	// `networkManager.setReputation` injection — the other two sites whose ad-hoc stop-and-rethrow the
	// rollback `catch` replaced. Both are unreachable from `NodeOptions`: the fret and networkManager
	// services are registered unconditionally by the factory and there is no option to suppress or
	// substitute one. Reaching them needs a service-injection seam this package does not have.
});
