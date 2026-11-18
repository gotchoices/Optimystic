/**
 * Blob transfer between two machines (docs/blobs.md §What this answers in GitHub #63): how long one
 * machine takes to read a blob another machine holds, per MiB, and how many bytes cross the wire for it.
 *
 * Two nodes over loopback TCP, memory piece stores. A puts random bytes; B reads them with
 * `node.blobs.read`, which fetches every piece from A. Timed from B's first call to its last chunk, with
 * fresh content each repetition so B never already holds it. The wire count is the delta of B's
 * `node.blobs.wireBytes()` across the read, sent plus received: blob-protocol frames (length prefixes,
 * headers, pieces), not the noise or yamux framing the transport adds beneath every protocol alike.
 * Loopback with memory stores, so it measures the protocol and the hashing, not a link or a disk.
 *
 *   yarn build && node test/bench-blob-transfer.mjs      (from packages/db-p2p; N=5 by default)
 *
 * A's put is timed too, apart from the transfer, and the overhead above the content is split into the
 * list pieces (computed by building the same content apart from both nodes) and the rest: frame headers
 * and length prefixes. Not a mocha spec; runs in no script.
 *
 * Measured 2026-11-18, AMD Ryzen AI 9 HX 370, Windows 11, Node 24.2.0, N=5, ranges of the medians over
 * five runs (one of N=9). Byte columns are per MiB of content and were the same in every run:
 *
 *   size     put ms/MiB  read ms/MiB  wire B/MiB  overhead B/MiB  list B/MiB  frames B/MiB  pieces
 *   1 MiB    1.2-1.6     9.0-10.5     1049234     658             208         450           5
 *   3 MiB    1.0-3.6     5.5-7.1      1049116     540             203         337           13
 *   16 MiB   1.4-1.6     5.5-6.6      1049077     501             201         300           65
 *
 * The first read of each run took about twice the others (16-18 ms for 1 MiB, against about 9); the
 * median absorbs it, so no warm-up read is discarded.
 */
import { randomBytes } from 'node:crypto';
import { buildBlob, routingKeyForBlob } from '@optimystic/db-core';
import { createLibp2pNode, buildBlobProtocol } from '../dist/src/index.js';

const MIB = 1024 * 1024;
const N = Number(process.env.N ?? 5);
const SIZES_MIB = [1, 3, 16];
const NETWORK_NAME = 'bench-blob-transfer';
const BLOB_PROTOCOL = buildBlobProtocol(`/optimystic/${NETWORK_NAME}`);

async function* streamOf(bytes) {
	yield bytes;
}

async function until(condition, what, withinMs = 15_000) {
	const deadline = Date.now() + withinMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
		await new Promise(resolve => setTimeout(resolve, 50));
	}
}

function spawn() {
	return createLibp2pNode({
		port: 0,
		networkName: NETWORK_NAME,
		bootstrapNodes: [],
		fretProfile: 'edge',
		clusterSize: 2,
		clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
		arachnode: { enableRingZulu: false },
	});
}

function loopbackAddr(node) {
	const addr = node.getMultiaddrs().find(a => a.toString().startsWith('/ip4/127.0.0.1/tcp/'));
	if (!addr) throw new Error('No loopback TCP multiaddr on node');
	return addr;
}

/** The blob's pieces, data and list: how many and their bytes, computed apart from both nodes and outside the timing. */
async function piecesOf(content) {
	let count = 0;
	let bytes = 0;
	await buildBlob(streamOf(content), { put: async (_id, piece) => { count++; bytes += piece.byteLength; } });
	return { count, bytes };
}

function median(values) {
	const sorted = [...values].sort((x, y) => x - y);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function wireTotal(node) {
	const { sent, received } = node.blobs.wireBytes();
	return sent + received;
}

/** One repetition: A puts fresh content, B reads it all from A. */
async function transferOnce(a, b, sizeBytes) {
	const content = randomBytes(sizeBytes);
	const p0 = performance.now();
	const { ref } = await a.blobs.put(streamOf(content));
	const putMs = performance.now() - p0;
	await until(async () => Object.keys(await b.keyNetwork.findCluster(routingKeyForBlob(ref))).includes(a.peerId.toString()),
		"A is in B's view of the blob's cohort");
	const wireBefore = wireTotal(b);
	const t0 = performance.now();
	let read = 0;
	for await (const chunk of b.blobs.read(ref)) read += chunk.byteLength;
	const ms = performance.now() - t0;
	const wire = wireTotal(b) - wireBefore;
	if (read !== sizeBytes) throw new Error(`read ${read} bytes of ${sizeBytes}`);
	return { putMs, ms, wire, pieces: await piecesOf(content) };
}

async function measure(a, b) {
	console.log('Wire bytes count blob-protocol frames (length prefixes, headers, pieces), not the noise or yamux');
	console.log('framing the transport adds beneath every protocol alike. Loopback, memory piece stores.\n');
	console.log(`N=${N}, medians. put: A's put, not part of the transfer. read: B's read, the transfer.`);
	console.log('Overhead = wire bytes above the content: the list pieces, and the headers and length prefixes of the frames.\n');
	console.log('size     put ms/MiB  read ms/MiB  wire B/MiB  overhead B/MiB  list B/MiB  frames B/MiB  pieces  read samples ms');
	for (const mib of SIZES_MIB) {
		const size = mib * MIB;
		const runs = [];
		for (let i = 0; i < N; i++) runs.push(await transferOnce(a, b, size));
		const perMib = values => median(values) / mib;
		const wirePerMib = perMib(runs.map(r => r.wire));
		console.log([
			`${mib} MiB`.padEnd(8),
			perMib(runs.map(r => r.putMs)).toFixed(1).padStart(10),
			perMib(runs.map(r => r.ms)).toFixed(1).padStart(12),
			wirePerMib.toFixed(0).padStart(11),
			(wirePerMib - MIB).toFixed(0).padStart(15),
			perMib(runs.map(r => r.pieces.bytes - size)).toFixed(0).padStart(11),
			perMib(runs.map(r => r.wire - r.pieces.bytes)).toFixed(0).padStart(13),
			String(runs[0].pieces.count).padStart(7),
			' ' + runs.map(r => r.ms.toFixed(0)).join(' '),
		].join(' '));
	}
}

const nodes = [];
let failed = false;
try {
	const a = await spawn();
	nodes.push(a);
	const b = await spawn();
	nodes.push(b);
	await b.dial(loopbackAddr(a));
	await until(async () => (await b.keyNetwork.peersServing(BLOB_PROTOCOL, [a.peerId.toString()])).length === 1, 'B knows A serves the blob protocol');
	await until(async () => (await a.keyNetwork.peersServing(BLOB_PROTOCOL, [b.peerId.toString()])).length === 1, 'A knows B serves the blob protocol');
	await measure(a, b);
} catch (error) {
	failed = true;
	console.error(error);
} finally {
	await Promise.allSettled(nodes.map(node => node.stop()));
}
process.exit(failed ? 1 : 0);
