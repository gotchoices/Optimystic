/**
 * The two-commit pattern over two REAL machines (docs/blobs.md §Committing a reference, last bullet):
 * an application that must not expose a reference before the bytes have moved commits the attachment
 * row first — the row that only holds the reference, and so authorizes the cohort to store the blob —
 * waits for `onDurability` to report `majority` or `full`, and only then commits the row people act
 * on.
 *
 * `blob-pins-online.spec.ts` pins every link of that chain on ONE machine, where the cohort is that
 * machine alone and durability therefore never leaves `local`. What is real only here is the
 * announcement going over the wire, the receiver reading committed state to decide it may store the
 * blob, the multi-piece pull, and the durability class rising past `local`.
 *
 * The mechanism's own cases live below this layer: the drain's rules over doubles in
 * `packages/db-p2p/test/blob-copy-drain.spec.ts`, the receiver's answers in
 * `packages/db-p2p/test/blob-announce-receiver.spec.ts`, and the same round trip without SQL in
 * `packages/db-p2p/test/blob-copy.spec.ts`. What is left to this spec is the application's view of
 * it: two `Quereus` databases over two nodes, two tables, two commits, and no call into the blob
 * machinery but the ones an application makes. In particular nothing here drives the drain —
 * `BlobCopyDrain` re-announces on its own schedule, which is what makes the bounded waits below
 * sound rather than a race against a single attempt.
 *
 * Reading the blob's bytes on the receiver is deliberately not here: `stat(…).locality === 'here'`
 * is the claim the pattern rests on, and `packages/db-p2p/test/blob-network-read.spec.ts` already
 * pins a verified read across two machines.
 *
 * One deliberate difference from `two-node-secondary-index-libp2p.integration.spec.ts`, which this
 * otherwise follows: each plugin is handed its NODE (`registerLibp2pNode`) rather than a
 * `NetworkTransactor` built beside it, and the factory builds the transactor over that node. A
 * plugin given only a transactor has no node to read a blob service off and falls through to a
 * single-machine one, whose cohort is that machine alone — so wiring it the precedent's way would
 * leave this spec asserting `local` durability for ever.
 *
 * Gated on OPTIMYSTIC_INTEGRATION=1:
 *   yarn workspace @optimystic/quereus-plugin-optimystic test:integration
 */
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { multiaddr } from '@multiformats/multiaddr';
import {
	BLOB_PIECE_BYTES,
	routingKeyForBlob,
	routingKeyForBlock,
	type BlobDurability,
	type BlobDurabilityEvent,
	type BlobRef,
} from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { buildBlobProtocol, createLibp2pNode, type OptimysticNode } from '@optimystic/db-p2p';
import register from '../dist/plugin.js';
import { queryAll } from './query-helpers.js';

const NETWORK_NAME = 'two-node-blob-it';
/** What a member of a blob's cohort must be known to serve before it can be counted as accepting blobs. */
const BLOB_PROTOCOL = buildBlobProtocol(`/optimystic/${NETWORK_NAME}`);
const ATTACHMENT_URI = 'tree://two-node-blob/Attachment';
const MESSAGE_URI = 'tree://two-node-blob/Message';

/** Three data pieces under one list piece, so the copy is a real multi-piece pull. */
const BLOB_BYTES = 2 * BLOB_PIECE_BYTES + 1024;
/** How long the copy may take: two real nodes, the drain's own debounce, and a multi-piece transfer. */
const DURABILITY_BOUND_MS = 120_000;

const CREATE_ATTACHMENT = `create table Attachment (Id text primary key, Content blobref null) using optimystic('${ATTACHMENT_URI}')`;
const CREATE_MESSAGE = `create table Message (Id text primary key, Body text, AttachmentId text) using optimystic('${MESSAGE_URI}')`;

type Plugin = ReturnType<typeof register>;

interface Machine {
	readonly node: OptimysticNode;
	readonly db: Database;
	readonly plugin: Plugin;
}

function pickLocalTcpMultiaddr(node: OptimysticNode): string {
	const addrs = node.getMultiaddrs().map(a => a.toString());
	const local = addrs.find(a => a.startsWith('/ip4/127.0.0.1/tcp/'))
		?? addrs.find(a => a.includes('/tcp/') && a.includes('/p2p/'));
	if (!local) throw new Error(`No usable TCP multiaddr; have: ${addrs.join(', ')}`);
	return local;
}

/** Bytes from a seeded xorshift, so no two of the blob's data pieces are equal and share one piece id. */
function deterministicBytes(length: number, seed: number): Uint8Array {
	const bytes = new Uint8Array(length);
	let state = seed >>> 0 || 1;
	for (let i = 0; i < length; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		bytes[i] = state & 0xff;
	}
	return bytes;
}

/** `content` in 64 KiB chunks, the way a host hands over a file it is reading. */
async function* streamOf(content: Uint8Array): AsyncIterable<Uint8Array> {
	const chunk = 64 * 1024;
	for (let at = 0; at < content.byteLength; at += chunk) {
		yield content.subarray(at, Math.min(at + chunk, content.byteLength));
	}
}

/** The durability reported for `ref`, in the order the events arrived. */
function classesFor(events: readonly BlobDurabilityEvent[], ref: BlobRef): BlobDurability[] {
	return events.filter(event => event.ref === ref).map(event => event.durability);
}

/**
 * Wait, bounded, for a durability event reporting `majority` or `full` for `ref` — the two classes the
 * two-commit pattern accepts.
 *
 * A failure names the last class seen rather than saying "timed out", because "stalled at `local`" and
 * "nothing was ever reported" have different causes: the first means the cohort never came to hold the
 * blob (the other member not counted as accepting, or its pull never finishing), the second that no
 * commit announced the reference at all.
 */
async function waitForCohortDurability(
	events: readonly BlobDurabilityEvent[],
	ref: BlobRef,
	timeoutMs: number,
): Promise<BlobDurability> {
	const beyondLocal = (): BlobDurability | undefined =>
		classesFor(events, ref).find(({ quorum }) => quorum === 'majority' || quorum === 'full');
	try {
		await waitFor(() => beyondLocal() !== undefined, {
			timeoutMs,
			intervalMs: 250,
			description: "the blob's durability to reach majority or full",
		});
	} catch {
		const seen = classesFor(events, ref);
		const last = seen[seen.length - 1];
		throw new Error(last === undefined
			? `No durability was reported for ${ref} within ${timeoutMs}ms, so nothing announced it`
			: `The blob's durability stalled at '${last.quorum}' (${last.confirmed} of ${last.accepting} accepting cohort members hold it) for ${timeoutMs}ms`);
	}
	return beyondLocal()!;
}

describe('a blob reaches the cohort before the row that shows it, over real libp2p', function () {
	// Two real libp2p boots, cohort convergence, the drain's own debounce and a multi-piece transfer.
	this.timeout(240_000);

	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	const nodes: OptimysticNode[] = [];
	const machines: Machine[] = [];

	// As `two-node-secondary-index-libp2p.integration.spec.ts`: a replication factor much larger than
	// the machine count, with the cohort size the deployment can actually field declared explicitly, so
	// the read-repair corroboration floor relaxes (db-p2p `cluster/cluster-policy.ts`).
	const clusterPolicy = { allowDownsize: true, sizeTolerance: 0.5, assumedClusterSize: 2 };

	afterEach(async () => {
		for (const { db, plugin } of machines.splice(0, machines.length)) {
			await db.close();
			await plugin.dispose();
		}
		await Promise.allSettled(nodes.splice(0, nodes.length).map(node => node.stop()));
	});

	async function spawnNode(bootstrapNodes: string[]): Promise<OptimysticNode> {
		const node = await createLibp2pNode({
			port: 0,
			networkName: NETWORK_NAME,
			bootstrapNodes,
			fretProfile: bootstrapNodes.length === 0 ? 'edge' : 'core',
			clusterSize: 16,
			clusterPolicy,
			arachnode: { enableRingZulu: true },
		});
		nodes.push(node);
		return node;
	}

	/** Two connected nodes that assemble the same cohort and each know the other takes blobs. */
	async function stabilizedPair(): Promise<[OptimysticNode, OptimysticNode]> {
		const a = await spawnNode([]);
		const b = await spawnNode([pickLocalTcpMultiaddr(a)]);
		const mesh = [a, b];
		for (const from of mesh) {
			for (const to of mesh) {
				if (from === to) continue;
				try { await from.dial(multiaddr(pickLocalTcpMultiaddr(to))); } catch { /* the reciprocal dial covers this */ }
			}
		}
		await waitFor(() => mesh.every(node => node.getPeers().length >= 1),
			{ timeoutMs: 30_000, intervalMs: 250, description: 'the 2-node mesh to connect' });
		await waitFor(async () => {
			for (const node of mesh) {
				const ids = Object.keys(await node.keyNetwork.findCluster(routingKeyForBlock('two-node-blob-probe')));
				if (ids.length !== 2) return false;
			}
			return true;
		}, { timeoutMs: 40_000, intervalMs: 500, description: 'both nodes to assemble the same 2-peer cohort' });
		// A member whose protocol list has not landed yet reads as REFUSING blobs, which leaves it out of
		// the denominator durability is counted over — and a denominator of this node alone is `local`
		// whatever happens (`blobAcceptanceOf` in packages/db-p2p/src/blob/accepts-blobs.ts, and backlog
		// `debt-a-peer-read-as-refusing-may-only-be-unidentified`). Gated here so that misread cannot be
		// what a failure of this spec is about.
		await waitFor(async () => {
			for (const [node, other] of [[a, b], [b, a]] as const) {
				if ((await node.keyNetwork.peersServing(BLOB_PROTOCOL, [other.peerId.toString()])).length !== 1) return false;
			}
			return true;
		}, { timeoutMs: 40_000, intervalMs: 250, description: 'each node to know the other serves the blob protocol' });
		return [a, b];
	}

	/** A `Database` whose plugin runs over `node`, as a host that builds its own node wires one. */
	function machineOver(node: OptimysticNode): Machine {
		const db = new Database();
		const plugin = register(db, { default_network_name: NETWORK_NAME, default_key_network: 'libp2p', enable_cache: false });
		// The NODE, not a transactor built over it: a registered node is what makes this plugin's blob
		// service the node's own — the one with a cohort — rather than a single-machine one
		// (`CollectionFactory.resolveBlobBackend`), and the factory builds the network transactor over it.
		plugin.collectionFactory.registerLibp2pNode(NETWORK_NAME, node, node.coordinatedRepo);
		for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
		for (const func of plugin.functions) db.registerFunction(func.schema);
		// Without the types a `blobref` column is refused, so the Attachment table would not open.
		for (const type of plugin.types) db.registerType(type.name, type.definition);
		const machine = { node, db, plugin };
		machines.push(machine);
		return machine;
	}

	it('copies the blob to the other machine before the row people act on is committed', async () => {
		const [a, b] = await stabilizedPair();
		const writer = machineOver(a);
		const reader = machineOver(b);

		// Both machines declare the schema before either writes, as the other two-node specs do.
		for (const { db } of [writer, reader]) {
			await db.exec(CREATE_ATTACHMENT);
			await db.exec(CREATE_MESSAGE);
		}

		const content = deterministicBytes(BLOB_BYTES, 1);
		const { ref } = await writer.plugin.blobs.put(streamOf(content));
		expect((await b.blobs.stat(ref)).locality, 'B holds nothing of a blob only A has put').to.equal('unknown');

		// The routing key is the digest in the reference, so which machines are responsible for THIS blob
		// is not the test's to choose. Asserted up front, because the durability wait below would
		// otherwise be the thing that failed, with nothing to say about why.
		await waitFor(async () => Object.keys(await a.keyNetwork.findCluster(routingKeyForBlob(ref))).length === 2,
			{ timeoutMs: 40_000, intervalMs: 250, description: "A to see both machines in the blob's cohort" });

		// Subscribed before the first commit — and after the put, which is what resolved the backend these
		// events come off: a subscription made before anything else touched the network starts that
		// resolution asynchronously, and could attach after the commit had already announced.
		const events: BlobDurabilityEvent[] = [];
		const unsubscribe = writer.plugin.blobs.onDurability(event => events.push(event));
		try {
			// The first commit: the row that only holds the reference. Its commit announces the blob, which
			// is what authorizes the cohort to store it.
			await writer.db.exec('insert into Attachment (Id, Content) values (?, ?)', ['att-1', ref]);

			// Not awaited: the announce and its first durability report happen inside the COMMIT, so by the
			// time `exec` resolves the first class is already reported (docs/blobs.md §Committing a reference).
			expect(classesFor(events, ref), 'the commit announced the blob before it returned')
				.to.have.length.of.at.least(1);

			const reached = await waitForCohortDurability(events, ref, DURABILITY_BOUND_MS);
			expect(reached.confirmed, 'both accepting members of the cohort hold the blob').to.equal(2);

			// The claim the two-commit pattern rests on, asserted BEFORE the second commit: the bytes are on
			// the other machine already. Nothing in this test told B to fetch them — A's announcement plus
			// B's own read of committed state is what authorized the pull.
			const onB = await b.blobs.stat(ref);
			expect(onB.locality, 'B holds the whole blob').to.equal('here');
			expect(onB.size, 'every piece of it, the root among them').to.equal(BLOB_BYTES);
		} finally {
			unsubscribe();
		}

		// The second commit: the row people act on, which cannot land before the bytes are held by others.
		await writer.db.exec('insert into Message (Id, Body, AttachmentId) values (?, ?, ?)',
			['msg-1', 'see the attachment', 'att-1']);

		expect(await queryAll(reader.db, 'select Id, Body, AttachmentId from Message order by Id'),
			'B reads the row people act on').to.deep.equal([
				{ Id: 'msg-1', Body: 'see the attachment', AttachmentId: 'att-1' },
			]);
	});
});
