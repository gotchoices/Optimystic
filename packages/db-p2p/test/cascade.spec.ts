import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import type { BlockStore, IBlock, BlockOperation, BlockId, ReadDependency, DisputeResolutionProof } from '@optimystic/db-core';
import { Log, applyOperation } from '@optimystic/db-core';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import {
	buildDisputeResolutionProof,
	applyInvalidation,
	cascadeInvalidate,
	type CollectionEnv,
	type CascadeSeed,
	type CascadeEscalation,
	type Reevaluate,
	type CascadeResult,
} from '../src/dispute/index.js';
import type { ArbitrationVote, DisputeResolution } from '../src/dispute/types.js';

// ─── Crypto / proof helpers (mirror invalidation.spec.ts) ───

type Arb = { peerId: PeerId; privateKey: PrivateKey };

async function makeArb(): Promise<Arb> {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
}

async function makeVote(arb: Arb, disputeId: string, vote: ArbitrationVote['vote'], computedHash: string): Promise<ArbitrationVote> {
	const sig = await arb.privateKey.sign(new TextEncoder().encode(`${disputeId}:${vote}:${computedHash}`));
	return {
		disputeId, arbitratorPeerId: arb.peerId.toString(), vote,
		evidence: { computedHash, engineId: 'engine', schemaHash: 'schema', blockStateHashes: {} },
		signature: uint8ArrayToString(sig, 'base64url'),
	};
}

async function challengerWinsProof(disputeId: string): Promise<DisputeResolutionProof> {
	const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
	const votes = await Promise.all(arbs.map(a => makeVote(a, disputeId, 'agree-with-challenger', 'h')));
	const resolution: DisputeResolution = { disputeId, outcome: 'challenger-wins', votes, affectedPeers: [], timestamp: 1 };
	return buildDisputeResolutionProof(resolution, 'msg-1');
}

// ─── In-memory log store (Chain BlockStore for a collection Log) ───

class MemLogStore implements BlockStore<IBlock> {
	private blocks = new Map<string, IBlock>();
	private nextId = 1;
	constructor(private readonly prefix: string) {}
	createBlockHeader(type: string, newId?: string) { return { id: newId ?? `${this.prefix}-log-${this.nextId++}`, type, collectionId: this.prefix }; }
	insert(block: IBlock): void { this.blocks.set(block.header.id, structuredClone(block)); }
	async tryGet(id: string): Promise<IBlock | undefined> { return structuredClone(this.blocks.get(id)); }
	update(id: string, op: BlockOperation): void { const b = this.blocks.get(id); if (!b) throw new Error(`Block ${id} not found`); applyOperation(b, op); }
	delete(id: string): void { this.blocks.delete(id); }
	generateId(): string { return `${this.prefix}-log-${this.nextId++}`; }
}

// ─── Collection harness ───

type ValueBlock = IBlock & { value: string };

type Collection = CollectionEnv & {
	readonly repo: StorageRepo;
	/** Commit a block revision (insert on first write, update thereafter) and append a matching log entry. */
	seed(input: SeedAction): Promise<void>;
};

type SeedAction = {
	actionId: string;
	rev: number;
	writes: { blockId: BlockId; value: string }[];
	/** undefined ⇒ legacy entry (no persisted read set). */
	reads?: ReadDependency[];
};

async function makeCollection(collectionId: string): Promise<Collection> {
	const raw = new MemoryRawStorage();
	const createBlockStorage = (id: BlockId) => new BlockStorage(id, raw);
	const repo = new StorageRepo(createBlockStorage);
	const log = await Log.create<unknown>(new MemLogStore(collectionId));
	const committedBlocks = new Set<BlockId>();

	const seed = async ({ actionId, rev, writes, reads }: SeedAction): Promise<void> => {
		for (const { blockId, value } of writes) {
			const isNew = !committedBlocks.has(blockId);
			const transforms = isNew
				? { inserts: { [blockId]: { header: { id: blockId, type: 'TST', collectionId }, value } as ValueBlock } }
				: { updates: { [blockId]: [['value', 0, 0, value] as BlockOperation] } };
			await repo.pend({ actionId, transforms, rev } as Parameters<StorageRepo['pend']>[0]);
			await repo.commit({ actionId, rev, blockIds: [blockId], tailId: 'log' });
			committedBlocks.add(blockId);
		}
		await log.addActions(['op'], actionId, rev, () => writes.map(w => w.blockId), [], reads);
	};

	return { collectionId, log, createBlockStorage, repo, seed };
}

/** Apply the root invalidation through the single-collection primitive and build the cascade seed from it. */
async function applyRoot(coll: Collection, actionId: string, rev: number, blockIds: BlockId[], proof: DisputeResolutionProof): Promise<CascadeSeed[]> {
	const result = await applyInvalidation(
		{ log: coll.log, createBlockStorage: coll.createBlockStorage },
		{ invalidatedActionId: actionId, invalidatedRev: rev, blockIds, proof }
	);
	expect(result.applied, 'root invalidation applied').to.equal(true);
	return result.reverted.map(rb => ({ collectionId: coll.collectionId, blockId: rb.blockId, rev, restoredContentHash: rb.restoredContentHash }));
}

async function countInvalidationEntries(coll: Collection): Promise<number> {
	let n = 0;
	for await (const e of coll.log.select()) {
		if (e.invalidation) n++;
	}
	return n;
}

function invalidatedIds(result: CascadeResult): string[] {
	return result.invalidated.map(c => c.actionId);
}

// ─── Tests ───

describe('Invalidation cascade', () => {
	it('reverts a genuine linear chain T_inv → T2 → T3 in revision order', async () => {
		const c = await makeCollection('C');
		// rev1 genesis creates the three data blocks; each later tx reads the prior tx's block.
		await c.seed({ actionId: 'gen', rev: 1, writes: [{ blockId: 'A', value: 'a0' }, { blockId: 'B', value: 'b0' }, { blockId: 'D', value: 'd0' }], reads: [] });
		await c.seed({ actionId: 'tinv', rev: 2, writes: [{ blockId: 'A', value: 'a-tinv' }], reads: [] });
		await c.seed({ actionId: 't2', rev: 3, writes: [{ blockId: 'B', value: 'b-t2' }], reads: [{ blockId: 'A', revision: 2 }] });
		await c.seed({ actionId: 't3', rev: 4, writes: [{ blockId: 'D', value: 'd-t3' }], reads: [{ blockId: 'B', revision: 3 }] });

		const proof = await challengerWinsProof('d1');
		const seed = await applyRoot(c, 'tinv', 2, ['A'], proof);

		const result = await cascadeInvalidate({ rootActionId: 'tinv', proof, seed, envs: [c] });

		expect(invalidatedIds(result)).to.deep.equal(['t2', 't3']);
		expect(result.escalation).to.equal(undefined);
		// Each child carries the root as its cascadeRoot, discoverable from the durable log.
		expect((await c.log.findInvalidation('t2'))?.cascadeRoot).to.equal('tinv');
		expect((await c.log.findInvalidation('t3'))?.cascadeRoot).to.equal('tinv');
		// Root + two children = three invalidation entries on the chain.
		expect(await countInvalidationEntries(c)).to.equal(3);
	});

	it('retains a dependent whose observed content the revert did not actually change (re-evaluation prune)', async () => {
		const c = await makeCollection('C');
		// T_inv re-writes A with the SAME value it already had → reverting it restores identical content.
		await c.seed({ actionId: 'gen', rev: 1, writes: [{ blockId: 'A', value: 'shared' }, { blockId: 'B', value: 'b0' }], reads: [] });
		await c.seed({ actionId: 'tinv', rev: 2, writes: [{ blockId: 'A', value: 'shared' }], reads: [] });
		await c.seed({ actionId: 't2', rev: 3, writes: [{ blockId: 'B', value: 'b-t2' }], reads: [{ blockId: 'A', revision: 2 }] });
		await c.seed({ actionId: 't3', rev: 4, writes: [{ blockId: 'D', value: 'd-t3' }], reads: [{ blockId: 'B', revision: 3 }] });

		const proof = await challengerWinsProof('d1');
		const seed = await applyRoot(c, 'tinv', 2, ['A'], proof);

		const result = await cascadeInvalidate({ rootActionId: 'tinv', proof, seed, envs: [c] });

		// T2 appeared in the dependency chain (read A@2) but the value it observed is unchanged → retained.
		expect(invalidatedIds(result)).to.deep.equal([]);
		expect(result.retained.map(r => r.actionId)).to.include('t2');
		// T3-via-T2 is therefore unaffected and never invalidated.
		expect(await c.log.findInvalidation('t2')).to.equal(undefined);
		expect(await c.log.findInvalidation('t3')).to.equal(undefined);
	});

	it('supports field-granular retain through an injected (engine-style) re-evaluator', async () => {
		const c = await makeCollection('C');
		await c.seed({ actionId: 'gen', rev: 1, writes: [{ blockId: 'A', value: 'a0' }, { blockId: 'B', value: 'b0' }], reads: [] });
		await c.seed({ actionId: 'tinv', rev: 2, writes: [{ blockId: 'A', value: 'a-tinv' }], reads: [] });
		await c.seed({ actionId: 't2', rev: 3, writes: [{ blockId: 'B', value: 'b-t2' }], reads: [{ blockId: 'A', revision: 2 }] });
		await c.seed({ actionId: 't3', rev: 4, writes: [{ blockId: 'D', value: 'd-t3' }], reads: [{ blockId: 'B', revision: 3 }] });

		const proof = await challengerWinsProof('d1');
		const seed = await applyRoot(c, 'tinv', 2, ['A'], proof);

		// Engine-style re-evaluator: knows t2 only depended on an unread field, so it re-runs clean.
		const reevaluate: Reevaluate = async (cand) => (cand.actionId === 't2' ? 'retain' : 'invalidate');
		const result = await cascadeInvalidate({ rootActionId: 'tinv', proof, seed, envs: [c], reevaluate });

		expect(invalidatedIds(result)).to.deep.equal([]);
		expect(result.retained.map(r => r.actionId)).to.include('t2');
	});

	it('cascades across collections via a cross-collection read dependency', async () => {
		const a = await makeCollection('A');
		const b = await makeCollection('B');
		// T_inv lives in collection A and writes X.
		await a.seed({ actionId: 'genA', rev: 1, writes: [{ blockId: 'X', value: 'x0' }], reads: [] });
		await a.seed({ actionId: 'tinv', rev: 2, writes: [{ blockId: 'X', value: 'x-tinv' }], reads: [] });
		// T2 lives in collection B but reads A's invalidated revision of X.
		await b.seed({ actionId: 'genB', rev: 1, writes: [{ blockId: 'Y', value: 'y0' }], reads: [] });
		await b.seed({ actionId: 't2', rev: 2, writes: [{ blockId: 'Y', value: 'y-t2' }], reads: [{ blockId: 'X', revision: 2 }] });

		const proof = await challengerWinsProof('d1');
		const seed = await applyRoot(a, 'tinv', 2, ['X'], proof);

		const result = await cascadeInvalidate({ rootActionId: 'tinv', proof, seed, envs: [a, b] });

		expect(result.invalidated.map(c => `${c.collectionId}:${c.actionId}`)).to.deep.equal(['B:t2']);
		expect((await b.log.findInvalidation('t2'))?.cascadeRoot).to.equal('tinv');
	});

	it('evaluates a diamond dependent once, after both invalidated ancestors', async () => {
		const c = await makeCollection('C');
		await c.seed({ actionId: 'gen', rev: 1, writes: [{ blockId: 'A', value: 'a0' }, { blockId: 'B', value: 'b0' }, { blockId: 'D', value: 'd0' }], reads: [] });
		await c.seed({ actionId: 'tinv', rev: 2, writes: [{ blockId: 'A', value: 'a-tinv' }], reads: [] });
		await c.seed({ actionId: 't2', rev: 3, writes: [{ blockId: 'B', value: 'b-t2' }], reads: [{ blockId: 'A', revision: 2 }] });
		// T3 depends on BOTH the root (A@2) and T2 (B@3).
		await c.seed({ actionId: 't3', rev: 4, writes: [{ blockId: 'D', value: 'd-t3' }], reads: [{ blockId: 'A', revision: 2 }, { blockId: 'B', revision: 3 }] });

		const proof = await challengerWinsProof('d1');
		const seed = await applyRoot(c, 'tinv', 2, ['A'], proof);

		const result = await cascadeInvalidate({ rootActionId: 'tinv', proof, seed, envs: [c] });

		expect(invalidatedIds(result)).to.deep.equal(['t2', 't3']);
		// Evaluated exactly once — a single invalidation entry for t3.
		const t3Entries = invalidatedIds(result).filter(id => id === 't3').length;
		expect(t3Entries).to.equal(1);
		expect(await countInvalidationEntries(c)).to.equal(3);
	});

	it('stops at maxCascadeTransactions, applies what it did, and escalates the remainder', async () => {
		const c = await makeCollection('C');
		await c.seed({ actionId: 'gen', rev: 1, writes: [{ blockId: 'A', value: 'a0' }, { blockId: 'B', value: 'b0' }, { blockId: 'D', value: 'd0' }], reads: [] });
		await c.seed({ actionId: 'tinv', rev: 2, writes: [{ blockId: 'A', value: 'a-tinv' }], reads: [] });
		await c.seed({ actionId: 't2', rev: 3, writes: [{ blockId: 'B', value: 'b-t2' }], reads: [{ blockId: 'A', revision: 2 }] });
		await c.seed({ actionId: 't3', rev: 4, writes: [{ blockId: 'D', value: 'd-t3' }], reads: [{ blockId: 'B', revision: 3 }] });

		const proof = await challengerWinsProof('d1');
		const seed = await applyRoot(c, 'tinv', 2, ['A'], proof);

		const escalations: CascadeEscalation[] = [];
		// Budget = root + 1 child: t2 lands, t3 must be escalated, never silently dropped.
		const result = await cascadeInvalidate({
			rootActionId: 'tinv', proof, seed, envs: [c],
			config: { maxCascadeDepth: 32, maxCascadeTransactions: 2 },
			onEscalation: (e) => escalations.push(e),
		});

		expect(invalidatedIds(result)).to.deep.equal(['t2']);
		expect(result.escalation?.reason).to.equal('max-transactions');
		expect(result.escalation?.remainder.map(r => r.actionId)).to.include('t3');
		expect(result.escalation?.collections).to.include('C');
		expect(escalations).to.have.lengthOf(1);
		// t2's reversal stands durably; t3 was not applied.
		expect(await c.log.findInvalidation('t2')).to.not.equal(undefined);
		expect(await c.log.findInvalidation('t3')).to.equal(undefined);
	});

	it('is idempotent / restartable: re-running converges without duplicate entries (and catches a commit landing mid-cascade)', async () => {
		const c = await makeCollection('C');
		await c.seed({ actionId: 'gen', rev: 1, writes: [{ blockId: 'A', value: 'a0' }, { blockId: 'B', value: 'b0' }, { blockId: 'D', value: 'd0' }], reads: [] });
		await c.seed({ actionId: 'tinv', rev: 2, writes: [{ blockId: 'A', value: 'a-tinv' }], reads: [] });
		await c.seed({ actionId: 't2', rev: 3, writes: [{ blockId: 'B', value: 'b-t2' }], reads: [{ blockId: 'A', revision: 2 }] });

		const proof = await challengerWinsProof('d1');
		const seed = await applyRoot(c, 'tinv', 2, ['A'], proof);

		const first = await cascadeInvalidate({ rootActionId: 'tinv', proof, seed, envs: [c] });
		expect(invalidatedIds(first)).to.deep.equal(['t2']);
		expect(await countInvalidationEntries(c)).to.equal(2); // root + t2

		// A new dependent commits AFTER the first cascade pass (reads t2's now-invalid B@3).
		await c.seed({ actionId: 't3', rev: 4, writes: [{ blockId: 'D', value: 'd-t3' }], reads: [{ blockId: 'B', revision: 3 }] });

		// Restart the cascade from the same root: t2 dedups (already-applied), t3 is caught — nothing skipped.
		const second = await cascadeInvalidate({ rootActionId: 'tinv', proof, seed, envs: [c] });
		expect(invalidatedIds(second).sort()).to.deep.equal(['t2', 't3']);
		// Exactly one entry per invalidated action — no duplicates from the re-run.
		expect(await countInvalidationEntries(c)).to.equal(3); // root + t2 + t3
	});

	it('escalates a legacy (reads-less) candidate rather than guessing it independent', async () => {
		const c = await makeCollection('C');
		await c.seed({ actionId: 'gen', rev: 1, writes: [{ blockId: 'A', value: 'a0' }, { blockId: 'B', value: 'b0' }], reads: [] });
		await c.seed({ actionId: 'tinv', rev: 2, writes: [{ blockId: 'A', value: 'a-tinv' }], reads: [] });
		// Legacy entry: no persisted read set (undefined).
		await c.seed({ actionId: 'legacy', rev: 3, writes: [{ blockId: 'B', value: 'b-legacy' }] });

		const proof = await challengerWinsProof('d1');
		const seed = await applyRoot(c, 'tinv', 2, ['A'], proof);

		const escalations: CascadeEscalation[] = [];
		const result = await cascadeInvalidate({ rootActionId: 'tinv', proof, seed, envs: [c], onEscalation: (e) => escalations.push(e) });

		expect(invalidatedIds(result)).to.deep.equal([]);
		expect(result.escalation?.reason).to.equal('unevaluable');
		expect(result.escalation?.unevaluable.map(u => u.actionId)).to.include('legacy');
		expect(escalations).to.have.lengthOf(1);
		// The legacy candidate is left in place (safe-but-stale), not invalidated.
		expect(await c.log.findInvalidation('legacy')).to.equal(undefined);
	});

	it('retains a structural-only false dependent (overlap whose content the revert leaves identical)', async () => {
		const c = await makeCollection('C');
		// S is a shared structural block T_inv touches without changing its serialized content.
		await c.seed({ actionId: 'gen', rev: 1, writes: [{ blockId: 'S', value: 'struct' }, { blockId: 'A', value: 'a0' }], reads: [] });
		await c.seed({ actionId: 'tinv', rev: 2, writes: [{ blockId: 'S', value: 'struct' }, { blockId: 'A', value: 'a-tinv' }], reads: [] });
		// T2 read only the structural block S (not the value A that actually changed).
		await c.seed({ actionId: 't2', rev: 3, writes: [{ blockId: 'B', value: 'b-t2' }], reads: [{ blockId: 'S', revision: 2 }] });

		const proof = await challengerWinsProof('d1');
		const seed = await applyRoot(c, 'tinv', 2, ['S', 'A'], proof);

		const result = await cascadeInvalidate({ rootActionId: 'tinv', proof, seed, envs: [c] });

		// S reverted to identical bytes → the structural-only read still holds → retained.
		expect(invalidatedIds(result)).to.deep.equal([]);
		expect(result.retained.map(r => r.actionId)).to.include('t2');
	});

	it('throws on a same-collection back-edge (corruption guard)', async () => {
		const c = await makeCollection('C');
		await c.seed({ actionId: 'gen', rev: 1, writes: [{ blockId: 'A', value: 'a0' }], reads: [] });
		await c.seed({ actionId: 'tinv', rev: 2, writes: [{ blockId: 'A', value: 'a-tinv' }], reads: [] });
		// Forged: a same-collection action at rev 2 claims to read A@5 — a future revision (back-edge).
		await c.seed({ actionId: 'bad', rev: 2, writes: [{ blockId: 'B', value: 'b' }], reads: [{ blockId: 'A', revision: 5 }] });

		// Seed the impossible pair (A,5) directly so `bad`'s read matches it inside the same collection.
		const proof = await challengerWinsProof('d1');
		const seed: CascadeSeed[] = [{ collectionId: 'C', blockId: 'A', rev: 5, restoredContentHash: 'whatever' }];

		await applyInvalidation({ log: c.log, createBlockStorage: c.createBlockStorage }, { invalidatedActionId: 'tinv', invalidatedRev: 2, blockIds: ['A'], proof });

		let threw = false;
		try {
			await cascadeInvalidate({ rootActionId: 'tinv', proof, seed, envs: [c] });
		} catch (err) {
			threw = true;
			expect((err as Error).message).to.match(/back-edge/);
		}
		expect(threw).to.equal(true);
	});

	it('reverts a multi-collection dependent in every collection it wrote (not just one)', async () => {
		const a = await makeCollection('A');
		const b = await makeCollection('B');
		// Collection A: genesis seeds X (the root's block) and P (t2's A-block, so its revert restores).
		await a.seed({ actionId: 'genA', rev: 1, writes: [{ blockId: 'X', value: 'x0' }, { blockId: 'P', value: 'p0' }], reads: [] });
		await a.seed({ actionId: 'tinv', rev: 2, writes: [{ blockId: 'X', value: 'x-tinv' }], reads: [] });
		// Collection B: genesis seeds Q (t2's B-block).
		await b.seed({ actionId: 'genB', rev: 1, writes: [{ blockId: 'Q', value: 'q0' }], reads: [] });
		// t2 is ONE transaction spanning both collections: same actionId, same read set, distinct
		// per-collection entry (P@3 in A, Q@2 in B). Both read the root's invalidated X@2.
		await a.seed({ actionId: 't2', rev: 3, writes: [{ blockId: 'P', value: 'p-t2' }], reads: [{ blockId: 'X', revision: 2 }] });
		await b.seed({ actionId: 't2', rev: 2, writes: [{ blockId: 'Q', value: 'q-t2' }], reads: [{ blockId: 'X', revision: 2 }] });

		const proof = await challengerWinsProof('d1');
		const seed = await applyRoot(a, 'tinv', 2, ['X'], proof);

		const result = await cascadeInvalidate({ rootActionId: 'tinv', proof, seed, envs: [a, b] });

		// The regression: t2 is reverted in BOTH collections, not just the lower-rev one.
		const reverted = result.invalidated.map(c => `${c.collectionId}:${c.actionId}`).sort();
		expect(reverted).to.deep.equal(['A:t2', 'B:t2']);
		expect((await a.log.findInvalidation('t2'))?.cascadeRoot).to.equal('tinv');
		expect((await b.log.findInvalidation('t2'))?.cascadeRoot).to.equal('tinv');
		expect(await countInvalidationEntries(a)).to.equal(2); // root tinv + t2
		expect(await countInvalidationEntries(b)).to.equal(1); // t2
		expect(result.escalation).to.equal(undefined);
	});

	it('is idempotent for a multi-collection dependent: re-running adds no duplicate entries in either collection', async () => {
		const a = await makeCollection('A');
		const b = await makeCollection('B');
		await a.seed({ actionId: 'genA', rev: 1, writes: [{ blockId: 'X', value: 'x0' }, { blockId: 'P', value: 'p0' }], reads: [] });
		await a.seed({ actionId: 'tinv', rev: 2, writes: [{ blockId: 'X', value: 'x-tinv' }], reads: [] });
		await b.seed({ actionId: 'genB', rev: 1, writes: [{ blockId: 'Q', value: 'q0' }], reads: [] });
		await a.seed({ actionId: 't2', rev: 3, writes: [{ blockId: 'P', value: 'p-t2' }], reads: [{ blockId: 'X', revision: 2 }] });
		await b.seed({ actionId: 't2', rev: 2, writes: [{ blockId: 'Q', value: 'q-t2' }], reads: [{ blockId: 'X', revision: 2 }] });

		const proof = await challengerWinsProof('d1');
		const seed = await applyRoot(a, 'tinv', 2, ['X'], proof);

		const first = await cascadeInvalidate({ rootActionId: 'tinv', proof, seed, envs: [a, b] });
		expect(first.invalidated.map(c => `${c.collectionId}:${c.actionId}`).sort()).to.deep.equal(['A:t2', 'B:t2']);
		expect(await countInvalidationEntries(a)).to.equal(2);
		expect(await countInvalidationEntries(b)).to.equal(1);

		// Restart from the same root: each collection-entry dedups (already-applied), still reported.
		const second = await cascadeInvalidate({ rootActionId: 'tinv', proof, seed, envs: [a, b] });
		expect(second.invalidated.map(c => `${c.collectionId}:${c.actionId}`).sort()).to.deep.equal(['A:t2', 'B:t2']);
		// No duplicate child entries from the re-run.
		expect(await countInvalidationEntries(a)).to.equal(2);
		expect(await countInvalidationEntries(b)).to.equal(1);
	});

	it('counts a multi-collection dependent once at maxCascadeTransactions (all-or-nothing, never split)', async () => {
		const a = await makeCollection('A');
		const b = await makeCollection('B');
		// A: X (root), P (t2's A-block), R (the independent t3's block).
		await a.seed({ actionId: 'genA', rev: 1, writes: [{ blockId: 'X', value: 'x0' }, { blockId: 'P', value: 'p0' }, { blockId: 'R', value: 'r0' }], reads: [] });
		await a.seed({ actionId: 'tinv', rev: 2, writes: [{ blockId: 'X', value: 'x-tinv' }], reads: [] });
		await b.seed({ actionId: 'genB', rev: 1, writes: [{ blockId: 'Q', value: 'q0' }], reads: [] });
		// t2: one transaction, two collection-entries — must count as a single transaction.
		await a.seed({ actionId: 't2', rev: 3, writes: [{ blockId: 'P', value: 'p-t2' }], reads: [{ blockId: 'X', revision: 2 }] });
		await b.seed({ actionId: 't2', rev: 2, writes: [{ blockId: 'Q', value: 'q-t2' }], reads: [{ blockId: 'X', revision: 2 }] });
		// t3: a second, INDEPENDENT dependent (distinct actionId) — the one that must be escalated.
		await a.seed({ actionId: 't3', rev: 4, writes: [{ blockId: 'R', value: 'r-t3' }], reads: [{ blockId: 'X', revision: 2 }] });

		const proof = await challengerWinsProof('d1');
		const seed = await applyRoot(a, 'tinv', 2, ['X'], proof);

		const escalations: CascadeEscalation[] = [];
		// Budget = root + 1 transaction. t2 (one transaction across both collections) must land in BOTH;
		// t3 (the second transaction) is escalated. If t2 were counted per-collection-entry it would
		// trip the horizon mid-transaction — the partial reversal this fix closes.
		const result = await cascadeInvalidate({
			rootActionId: 'tinv', proof, seed, envs: [a, b],
			config: { maxCascadeDepth: 32, maxCascadeTransactions: 2 },
			onEscalation: (e) => escalations.push(e),
		});

		expect(result.invalidated.map(c => `${c.collectionId}:${c.actionId}`).sort()).to.deep.equal(['A:t2', 'B:t2']);
		expect(result.escalation?.reason).to.equal('max-transactions');
		expect(result.escalation?.remainder.map(r => r.actionId)).to.include('t3');
		expect(escalations).to.have.lengthOf(1);
		// t2 reverted durably in both collections; the independent t3 was not applied.
		expect(await a.log.findInvalidation('t2')).to.not.equal(undefined);
		expect(await b.log.findInvalidation('t2')).to.not.equal(undefined);
		expect(await a.log.findInvalidation('t3')).to.equal(undefined);
		expect(await countInvalidationEntries(a)).to.equal(2); // root tinv + t2 (t3 escalated)
		expect(await countInvalidationEntries(b)).to.equal(1); // t2
	});

	it('reverts a multi-collection dependent all-or-nothing even when an over-budget txn interleaves at the horizon', async () => {
		const a = await makeCollection('A');
		const b = await makeCollection('B');
		// A: X (root), P (t2's A-block), R (the independent over-budget tN's block).
		await a.seed({ actionId: 'genA', rev: 1, writes: [{ blockId: 'X', value: 'x0' }, { blockId: 'P', value: 'p0' }, { blockId: 'R', value: 'r0' }], reads: [] });
		await a.seed({ actionId: 'tinv', rev: 2, writes: [{ blockId: 'X', value: 'x-tinv' }], reads: [] });
		await b.seed({ actionId: 'genB', rev: 1, writes: [{ blockId: 'Q', value: 'q0' }], reads: [] });
		// t2 is ONE transaction: A:P@3 and B:Q@5. tN is a second, INDEPENDENT transaction at rev 4 —
		// so by the cascade's (rev, collectionId) ordering it sorts BETWEEN t2's two entries.
		await a.seed({ actionId: 't2', rev: 3, writes: [{ blockId: 'P', value: 'p-t2' }], reads: [{ blockId: 'X', revision: 2 }] });
		await a.seed({ actionId: 'tN', rev: 4, writes: [{ blockId: 'R', value: 'r-tN' }], reads: [{ blockId: 'X', revision: 2 }] });
		await b.seed({ actionId: 't2', rev: 5, writes: [{ blockId: 'Q', value: 'q-t2' }], reads: [{ blockId: 'X', revision: 2 }] });

		const proof = await challengerWinsProof('d1');
		const seed = await applyRoot(a, 'tinv', 2, ['X'], proof);

		const escalations: CascadeEscalation[] = [];
		// Budget = root + 1 transaction. Once t2 is counted (its A-entry), the budget is full, so the
		// interleaving tN trips the horizon mid-round. The cascade must NOT abandon t2's still-pending
		// B-entry: t2 is reverted all-or-nothing in BOTH collections, and tN — the genuinely-new
		// transaction — is the one escalated. (Regression: a horizon `break` would split t2.)
		const result = await cascadeInvalidate({
			rootActionId: 'tinv', proof, seed, envs: [a, b],
			config: { maxCascadeDepth: 32, maxCascadeTransactions: 2 },
			onEscalation: (e) => escalations.push(e),
		});

		expect(result.invalidated.map(c => `${c.collectionId}:${c.actionId}`).sort()).to.deep.equal(['A:t2', 'B:t2']);
		expect(result.escalation?.reason).to.equal('max-transactions');
		expect(result.escalation?.remainder.map(r => r.actionId)).to.deep.equal(['tN']);
		expect(escalations).to.have.lengthOf(1);
		// t2 reverted durably in both collections; the independent over-budget tN was not applied.
		expect(await a.log.findInvalidation('t2')).to.not.equal(undefined);
		expect(await b.log.findInvalidation('t2')).to.not.equal(undefined);
		expect(await a.log.findInvalidation('tN')).to.equal(undefined);
		expect(await countInvalidationEntries(a)).to.equal(2); // root tinv + t2 (tN escalated)
		expect(await countInvalidationEntries(b)).to.equal(1); // t2
	});
});
