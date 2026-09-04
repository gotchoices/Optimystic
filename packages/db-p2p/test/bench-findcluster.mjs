/**
 * Attribution bench for the `findCluster` cost the issue-8 repro surfaced: 13.8 ms per call on a
 * SOLO node with zero peers, ~49% of a cold `apply schema`. Times the whole call and its two
 * plausible internals (`hashKey`, `assembleCohort`) so the fix targets the right one.
 *
 *   node test/bench-findcluster.mjs
 */
import { createLibp2pNode } from '../dist/src/index.js';
import { hashKey } from 'p2p-fret';

const N = Number(process.env.N ?? 200);
const NETWORK_NAME = 'bench-findcluster';

const node = await createLibp2pNode({
	port: 0,
	networkName: NETWORK_NAME,
	bootstrapNodes: [],
	fretProfile: 'edge',
	clusterSize: 1,
	clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
	arachnode: { enableRingZulu: true },
});

const kn = node.keyNetwork;
const keys = Array.from({ length: N }, (_, i) => new TextEncoder().encode(`bench-block-${i}`));

async function time(label, fn) {
	// One warm pass so JIT/lazy init is not attributed to the measurement.
	await fn(keys[0]);
	const t0 = performance.now();
	for (const k of keys) await fn(k);
	const ms = performance.now() - t0;
	console.log(`${label.padEnd(24)} ${ms.toFixed(1)}ms total  ${(ms / N).toFixed(3)}ms/call`);
	return ms;
}

const whole = await time('findCluster', (k) => kn.findCluster(k));
const hash = await time('hashKey', (k) => hashKey(k));

// assembleCohort is reached through the private `getFret()`; go via the service directly.
const fret = node.services?.fret ?? node.services?.arachnode;
if (fret?.assembleCohort) {
	const coords = [];
	for (const k of keys) coords.push(await hashKey(k));
	let i = 0;
	await time('assembleCohort', async () => { fret.assembleCohort(coords[i++ % coords.length], 1); });
} else {
	console.log('assembleCohort           (fret service not reachable from node.services)');
}

console.log(`\nhashKey share of findCluster: ${((hash / whole) * 100).toFixed(1)}%`);
await node.stop();
process.exit(0);
