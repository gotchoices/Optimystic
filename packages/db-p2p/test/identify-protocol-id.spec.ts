/**
 * Lock spec for the protocol ids a spawned node actually advertises.
 *
 * Regression guard for the `//optimystic/<net>/id/1.0.0` defect (gotchoices/Optimystic#6):
 * `@libp2p/identify` builds its own protocol id as `/${protocolPrefix}/id/1.0.0`, always
 * prepending the leading slash, so `createLibp2pNodeBase` must hand it a slash-LESS prefix
 * while every other service keeps the slash-prefixed form. That asymmetry is invisible at
 * the call site and was shipped for several releases.
 *
 * Also covers #7: `identifyPush` was never registered at all.
 *
 * Two deliberate choices about HOW this asserts, because they are what the existing
 * `*-node-wiring` specs got wrong:
 *
 *  1. Expected ids are written out as LITERALS here, not computed by re-calling the same
 *     builder production uses. A test that derives the expectation from the code under test
 *     restates the bug instead of catching it.
 *  2. It asserts over the WHOLE `getProtocols()` list (no malformed id anywhere), not just
 *     `.to.include(...)` of the handful it happens to name. The `//` form passed every
 *     existing include-assertion precisely because nothing ever looked at the rest.
 */
import { expect } from 'chai';
import { createLibp2pNode } from '../src/libp2p-node.js';
import { expectWellFormedProtocolIds } from './util/protocol-ids.js';

describe('advertised protocol ids', function () {
	// Real libp2p boot + FRET seeding dominate.
	this.timeout(40_000);

	const NETWORK = 'test-identify-protocol-id';

	async function spawnProtocols(): Promise<string[]> {
		const node = await createLibp2pNode({
			port: 0,
			networkName: NETWORK,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false }
		} as any);
		try {
			return node.getProtocols() as string[];
		} finally {
			await node.stop();
		}
	}

	it('registers identify + identifyPush under the single-slash network-scoped prefix', async () => {
		const protocols = await spawnProtocols();

		// Literals, not `buildX(prefix)` — see header note 1.
		expect(protocols, 'identify registered as /optimystic/<net>/id/1.0.0')
			.to.include(`/optimystic/${NETWORK}/id/1.0.0`);
		expect(protocols, 'identifyPush registered as /optimystic/<net>/id/push/1.0.0')
			.to.include(`/optimystic/${NETWORK}/id/push/1.0.0`);

		// The exact defect: an already-slash-prefixed value handed to @libp2p/identify.
		expect(protocols, 'no double-slash identify id (#6 regression)')
			.to.not.include(`//optimystic/${NETWORK}/id/1.0.0`);
		expect(protocols, 'no double-slash identifyPush id (#6 regression)')
			.to.not.include(`//optimystic/${NETWORK}/id/push/1.0.0`);
	});

	it('advertises no malformed id on ANY protocol, named or not', async () => {
		const protocols = await spawnProtocols();

		// The generalization of the above: whatever the services map grows next, a protocol id
		// is `/`-rooted with no empty path segment. This is the assertion that would have caught
		// #6 without anyone having thought about identify specifically. See header note 2.
		// It lives in `test/util/protocol-ids.ts` so every node-spawning spec can make it —
		// an id nobody named is exactly the kind this catches, so it belongs everywhere.
		expectWellFormedProtocolIds(protocols, 'default node');
	});

	it('keeps the custom services on the slash-prefixed prefix (they build their own ids)', async () => {
		const protocols = await spawnProtocols();

		// Guards the other half of the asymmetry: the #6 fix must NOT be applied to these.
		for (const suffix of ['cluster/1.0.0', 'repo/1.0.0']) {
			expect(protocols, `${suffix} still under /optimystic/<net>`)
				.to.include(`/optimystic/${NETWORK}/${suffix}`);
		}
	});
});
