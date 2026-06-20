import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import type { BlockStore, IBlock, BlockOperation, BlockId } from '@optimystic/db-core';
import { Log, applyOperation } from '@optimystic/db-core';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import {
	buildDisputeResolutionProof,
	verifyInvalidationCertificate,
	computeRevertedBlock,
	computeTargetHash,
	computeArbitratorSetHash,
	voteSigningPayload,
	arbitratorSetSigningPayload,
	applyInvalidation,
	DEFERRED_DELETE_RESTORE,
	type CertificateTarget,
	type ArbitratorSetRecompute,
	type UnanchoredAcceptanceInfo,
} from '../src/dispute/invalidation.js';
import type { ArbitrationVote, DisputeResolution } from '../src/dispute/types.js';

// ─── Crypto helpers ───

type Arb = { peerId: PeerId; privateKey: PrivateKey };

async function makeArb(): Promise<Arb> {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
}

// A target- and set-bound (v3) vote: the signature commits to BOTH `targetHash` (the reversed
// transaction, #2) and `setHash` (the legitimately-selected arbitrator set, #1).
async function makeVote(arb: Arb, disputeId: string, vote: ArbitrationVote['vote'], computedHash: string, targetHash: string, setHash: string): Promise<ArbitrationVote> {
	const sig = await arb.privateKey.sign(voteSigningPayload(disputeId, vote, computedHash, targetHash, setHash));
	return {
		version: 'v3',
		disputeId,
		arbitratorPeerId: arb.peerId.toString(),
		vote,
		evidence: { computedHash, engineId: 'engine', schemaHash: 'schema', blockStateHashes: {} },
		signature: uint8ArrayToString(sig, 'base64url'),
	};
}

function makeResolution(disputeId: string, outcome: DisputeResolution['outcome'], votes: ArbitrationVote[]): DisputeResolution {
	return { disputeId, outcome, votes, affectedPeers: [], timestamp: 1 };
}

function setEquals(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
	const A = new Set(a);
	return a.length === b.length && b.every(x => A.has(x));
}

/** Layer-2 recompute that says the genuine set is legitimate and anything else is not. */
function recomputeMatching(genuineSet: ReadonlyArray<string>): ArbitratorSetRecompute {
	return async (ctx) => ({ feasible: true, legitimate: setEquals(ctx.arbitratorSet, genuineSet) });
}

/** Layer-2 recompute that cannot reconstruct the historical topology (late-joiner / churn). */
const recomputeInfeasible: ArbitratorSetRecompute = async () => ({ feasible: false });

// ─── In-memory log store (Chain BlockStore for the collection Log) ───

class MemLogStore implements BlockStore<IBlock> {
	private blocks = new Map<string, IBlock>();
	private nextId = 1;
	createBlockHeader(type: string, newId?: string) { return { id: newId ?? `log-${this.nextId++}`, type, collectionId: 'log' }; }
	insert(block: IBlock): void { this.blocks.set(block.header.id, structuredClone(block)); }
	async tryGet(id: string): Promise<IBlock | undefined> { return structuredClone(this.blocks.get(id)); }
	update(id: string, op: BlockOperation): void { const b = this.blocks.get(id); if (!b) throw new Error(`Block ${id} not found`); applyOperation(b, op); }
	delete(id: string): void { this.blocks.delete(id); }
	generateId(): string { return `log-${this.nextId++}`; }
}

// ─── Block content helpers ───

type ValueBlock = IBlock & { value: string };

function valueBlock(id: BlockId, value: string): ValueBlock {
	return { header: { id, type: 'TST', collectionId: 'C' }, value };
}

/**
 * Seeds a block through the real StorageRepo commit path: rev 1 inserts `original`, rev 2 (T_inv)
 * updates the value, then optional later revisions. Returns the wired repo + storage factory.
 */
async function seedBlock(raw: MemoryRawStorage, blockId: BlockId, revisions: { actionId: string; value: string; rev: number }[]) {
	const createBlockStorage = (id: BlockId) => new BlockStorage(id, raw);
	const repo = new StorageRepo(createBlockStorage);
	let first = true;
	for (const { actionId, value, rev } of revisions) {
		const transforms = first
			? { inserts: { [blockId]: valueBlock(blockId, value) } }
			: { updates: { [blockId]: [['value', 0, 0, value] as BlockOperation] } };
		await repo.pend({ actionId, transforms, rev } as Parameters<StorageRepo['pend']>[0]);
		await repo.commit({ actionId, rev, blockIds: [blockId], tailId: 'log' });
		first = false;
	}
	return { repo, createBlockStorage };
}

describe('Invalidation certificate verification', () => {
	// The transaction the votes are bound to. The verifier recomputes targetHash from (messageHash, target).
	const MSG = 'msg-1';
	const TARGET: CertificateTarget = { invalidatedActionId: 'a2', blockIds: ['B'] };

	// The challenger's base64url signature over `(disputeId, target, arbitratorSet)`.
	async function challengerSetSig(challenger: Arb, disputeId: string, arbitratorSet: ReadonlyArray<string>, target: CertificateTarget = TARGET, messageHash = MSG): Promise<string> {
		const targetHash = await computeTargetHash(messageHash, target);
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		return uint8ArrayToString(await challenger.privateKey.sign(arbitratorSetSigningPayload(disputeId, targetHash, setHash)), 'base64url');
	}

	// Assemble a v3 proof from already-built votes + an explicit arbitrator set (allows the set to differ
	// from the voters, for the non-member / sybil cases).
	async function proofFrom(challenger: Arb, arbitratorSet: string[], disputeId: string, outcome: DisputeResolution['outcome'], votes: ArbitrationVote[], target: CertificateTarget = TARGET, messageHash = MSG) {
		const arbitratorSetSignature = await challengerSetSig(challenger, disputeId, arbitratorSet, target, messageHash);
		return buildDisputeResolutionProof(makeResolution(disputeId, outcome, votes), messageHash, {
			arbitratorSet,
			challengerPeerId: challenger.peerId.toString(),
			arbitratorSetSignature,
		});
	}

	// The common case: every arb casts the same verdict, the carried set IS the voters, the challenger
	// signs that set. A genuine, self-consistent v3 certificate.
	async function genuineProof(challenger: Arb, arbs: Arb[], disputeId: string, outcome: DisputeResolution['outcome'], verdict: ArbitrationVote['vote'], target: CertificateTarget = TARGET, messageHash = MSG) {
		const arbitratorSet = arbs.map(a => a.peerId.toString());
		const targetHash = await computeTargetHash(messageHash, target);
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		const votes = await Promise.all(arbs.map(a => makeVote(a, disputeId, verdict, 'h', targetHash, setHash)));
		return proofFrom(challenger, arbitratorSet, disputeId, outcome, votes, target, messageHash);
	}

	it('accepts a challenger-wins resolution with a 2/3 super-majority of signed votes (bound to the matching target + set)', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(true);
	});

	it('rejects a genuine proof replayed against a different target (#2 target binding)', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		// Verifies against its own target, but NOT against an unrelated (innocent) transaction Y.
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(true);
		expect(await verifyInvalidationCertificate(proof, { invalidatedActionId: 'innocent', blockIds: ['Y'] })).to.equal(false);
		// Same action id, different blocks → still bound, still rejected.
		expect(await verifyInvalidationCertificate(proof, { invalidatedActionId: 'a2', blockIds: ['B', 'C'] })).to.equal(false);
	});

	it('binding is block-order independent (blockIds sorted)', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger', { invalidatedActionId: 'a2', blockIds: ['B', 'A'] });
		// Verifier given the same blocks in a different order still recomputes the same targetHash.
		expect(await verifyInvalidationCertificate(proof, { invalidatedActionId: 'a2', blockIds: ['A', 'B'] })).to.equal(true);
	});

	it('counts a duplicated arbitrator vote only once (#3 dedup)', async () => {
		// One genuine agree-with-challenger vote replicated 3× must NOT reach the super-majority: it is a
		// single arbitrator. Add two genuine majority votes → 1 challenger vs 2 majority ⇒ reject.
		const challenger = await makeArb();
		const [a1, a2, a3] = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const arbitratorSet = [a1!, a2!, a3!].map(a => a.peerId.toString());
		const targetHash = await computeTargetHash(MSG, TARGET);
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		const dup = await makeVote(a1!, 'd1', 'agree-with-challenger', 'h', targetHash, setHash);
		const votes = [
			dup, { ...dup }, { ...dup }, // same arbitrator, replicated → counts once
			await makeVote(a2!, 'd1', 'agree-with-majority', 'h', targetHash, setHash),
			await makeVote(a3!, 'd1', 'agree-with-majority', 'h', targetHash, setHash),
		];
		const proof = await proofFrom(challenger, arbitratorSet, 'd1', 'challenger-wins', votes);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);

		// Sanity: three DISTINCT arbitrators agreeing with the challenger still pass.
		const okProof = await genuineProof(challenger, [a1!, a2!, a3!], 'd1', 'challenger-wins', 'agree-with-challenger');
		expect(await verifyInvalidationCertificate(okProof, TARGET)).to.equal(true);
	});

	it('drops an equivocating arbitrator from both sides', async () => {
		// a1 equivocates (challenger AND majority) → dropped entirely; a2,a3 are genuine challenger votes.
		const challenger = await makeArb();
		const [a1, a2, a3] = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const arbitratorSet = [a1!, a2!, a3!].map(a => a.peerId.toString());
		const targetHash = await computeTargetHash(MSG, TARGET);
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		const votes = [
			await makeVote(a1!, 'd1', 'agree-with-challenger', 'h', targetHash, setHash),
			await makeVote(a1!, 'd1', 'agree-with-majority', 'h', targetHash, setHash),
			await makeVote(a2!, 'd1', 'agree-with-challenger', 'h', targetHash, setHash),
			await makeVote(a3!, 'd1', 'agree-with-challenger', 'h', targetHash, setHash),
		];
		const proof = await proofFrom(challenger, arbitratorSet, 'd1', 'challenger-wins', votes);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(true);
	});

	it('rejects an unversioned / v1 / v2 vote before counting', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		// Strip the version marker (simulate a legacy vote) → all dropped → 0 decisive → reject.
		const unversioned = {
			...proof,
			votes: proof.votes.map(v => { const { version, ...rest } = v; return rest as typeof v; }),
		};
		expect(await verifyInvalidationCertificate(unversioned, TARGET)).to.equal(false);
	});

	it('rejects a majority-wins resolution', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'majority-wins', 'agree-with-majority');
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);
	});

	it('rejects an inconclusive resolution', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'inconclusive', 'inconclusive');
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);
	});

	it('rejects a challenger-wins claim that does not actually meet the 2/3 threshold', async () => {
		// 1 challenger + 2 majority → challenger 1/3 < ceil(3*2/3)=2 ⇒ forged outcome must be rejected.
		const challenger = await makeArb();
		const [a1, a2, a3] = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const arbitratorSet = [a1!, a2!, a3!].map(a => a.peerId.toString());
		const targetHash = await computeTargetHash(MSG, TARGET);
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		const votes = [
			await makeVote(a1!, 'd1', 'agree-with-challenger', 'h', targetHash, setHash),
			await makeVote(a2!, 'd1', 'agree-with-majority', 'h', targetHash, setHash),
			await makeVote(a3!, 'd1', 'agree-with-majority', 'h', targetHash, setHash),
		];
		const proof = await proofFrom(challenger, arbitratorSet, 'd1', 'challenger-wins', votes);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);
	});

	it('drops votes with forged/invalid signatures before counting', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		// Corrupt every vote signature → all dropped → 0 decisive votes → reject.
		const forged = {
			...proof,
			votes: proof.votes.map(v => ({ ...v, signature: uint8ArrayToString(new Uint8Array(64), 'base64url') })),
		};
		expect(await verifyInvalidationCertificate(forged, TARGET)).to.equal(false);
	});

	it('rejects when the signed vote payload is tampered (computedHash mismatch)', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		// Signature was over computedHash 'h'; claim a different hash → verification fails.
		const tampered = {
			...proof,
			votes: proof.votes.map(v => ({ ...v, computedHash: 'tampered' })),
		};
		expect(await verifyInvalidationCertificate(tampered, TARGET)).to.equal(false);
	});

	// ─── #1 arbitrator-set binding ───

	it('rejects a proof missing the arbitrator-set binding', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		// A pre-set-binding (no arbitratorSet / challenger) proof is rejected, never accepted-by-default.
		expect(await verifyInvalidationCertificate({ ...proof, arbitratorSet: [] }, TARGET)).to.equal(false);
		expect(await verifyInvalidationCertificate({ ...proof, arbitratorSetSignature: '' }, TARGET)).to.equal(false);
		expect(await verifyInvalidationCertificate({ ...proof, challengerPeerId: '' }, TARGET)).to.equal(false);
	});

	it('does not count signature-valid votes from peers outside the arbitrator set (#1)', async () => {
		// The carried set is {a1,a2,a3}: a1 challenger, a2/a3 majority → 1 vs 2 ⇒ sub-threshold. Three sybils
		// also cast cryptographically-valid challenger votes over the SAME (targetHash,setHash) but are NOT
		// members → dropped. If they counted, challenger would be 4 vs 2 and pass; instead it stays 1 vs 2.
		const challenger = await makeArb();
		const [a1, a2, a3] = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const arbitratorSet = [a1!, a2!, a3!].map(a => a.peerId.toString());
		const targetHash = await computeTargetHash(MSG, TARGET);
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		const sybils = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const votes = [
			await makeVote(a1!, 'd1', 'agree-with-challenger', 'h', targetHash, setHash),
			await makeVote(a2!, 'd1', 'agree-with-majority', 'h', targetHash, setHash),
			await makeVote(a3!, 'd1', 'agree-with-majority', 'h', targetHash, setHash),
			...await Promise.all(sybils.map(s => makeVote(s, 'd1', 'agree-with-challenger', 'h', targetHash, setHash))),
		];
		const proof = await proofFrom(challenger, arbitratorSet, 'd1', 'challenger-wins', votes);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);
	});

	it('rejects a proof whose arbitrator set was tampered after signing (#1)', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(true); // baseline
		// Inject a sybil into the carried set → it no longer matches the challenger-signed digest → reject.
		const sybil = await makeArb();
		const tampered = { ...proof, arbitratorSet: [...proof.arbitratorSet, sybil.peerId.toString()] };
		expect(await verifyInvalidationCertificate(tampered, TARGET)).to.equal(false);
	});

	it('rejects sybil-key votes when recompute exposes a forged arbitrator set (#1 headline)', async () => {
		// The forgery part 1 left open: an attacker mints fresh keypairs, declares them the arbitrator set,
		// self-signs the set as "challenger", and signs a 2/3 super-majority. This is layer-1-consistent…
		const attacker = await makeArb();
		const sybils = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const forged = await genuineProof(attacker, sybils, 'd1', 'challenger-wins', 'agree-with-challenger');
		// …so on layer 1 ALONE (no recompute) it is accepted — the documented residual until a trust anchor.
		expect(await verifyInvalidationCertificate(forged, TARGET)).to.equal(true);
		// But a member that CAN reconstruct the genuine topology (some other selected set) rejects it.
		const genuineSet = (await Promise.all([makeArb(), makeArb(), makeArb()])).map(a => a.peerId.toString());
		expect(await verifyInvalidationCertificate(forged, TARGET, { recomputeArbitratorSet: recomputeMatching(genuineSet) })).to.equal(false);
	});

	it('recompute path: the genuine set verifies and a forged set fails (#1 layer 2)', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const genuineSet = arbs.map(a => a.peerId.toString());
		const recompute = recomputeMatching(genuineSet);

		const genuine = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		expect(await verifyInvalidationCertificate(genuine, TARGET, { recomputeArbitratorSet: recompute })).to.equal(true);

		// A different (sybil) set fails the recompute match even though it is layer-1-consistent.
		const attacker = await makeArb();
		const sybils = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const forged = await genuineProof(attacker, sybils, 'd2', 'challenger-wins', 'agree-with-challenger');
		expect(await verifyInvalidationCertificate(forged, TARGET, { recomputeArbitratorSet: recompute })).to.equal(false);
	});

	it('degradation path: a layer-1-valid cert is accepted and reported as not-fully-anchored', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');

		// No recompute capability → accept on layer 1 + report reason 'no-recompute-capability'.
		const seen: UnanchoredAcceptanceInfo[] = [];
		expect(await verifyInvalidationCertificate(proof, TARGET, { onUnanchored: (i) => seen.push(i) })).to.equal(true);
		expect(seen).to.have.lengthOf(1);
		expect(seen[0]!.reason).to.equal('no-recompute-capability');
		expect(seen[0]!.disputeId).to.equal('d1');

		// Recompute present but infeasible (late-joiner / churn) → still accept, reason 'recompute-infeasible'.
		const seen2: UnanchoredAcceptanceInfo[] = [];
		expect(await verifyInvalidationCertificate(proof, TARGET, { recomputeArbitratorSet: recomputeInfeasible, onUnanchored: (i) => seen2.push(i) })).to.equal(true);
		expect(seen2).to.have.lengthOf(1);
		expect(seen2[0]!.reason).to.equal('recompute-infeasible');
	});

	it('does not report unanchored when the recompute fully anchors the set', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		const genuineSet = arbs.map(a => a.peerId.toString());
		const seen: UnanchoredAcceptanceInfo[] = [];
		expect(await verifyInvalidationCertificate(proof, TARGET, { recomputeArbitratorSet: recomputeMatching(genuineSet), onUnanchored: (i) => seen.push(i) })).to.equal(true);
		expect(seen).to.have.lengthOf(0);
	});
});

describe('Compensating-state computation', () => {
	it('restores the pre-T_inv content for a single-block T_inv', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'original', rev: 1 },
			{ actionId: 'a2', value: 'tinv', rev: 2 },
		]);
		const result = await computeRevertedBlock(createBlockStorage('B'), 2);
		expect(result.kind).to.equal('restore');
		if (result.kind === 'restore') {
			expect((result.block as ValueBlock).value).to.equal('original');
			expect(result.fromRev).to.equal(2);
			expect(result.laterActions).to.equal(0);
		}
	});

	it('replays surviving later actions on the rolled-back base (T_inv superseded)', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'original', rev: 1 },
			{ actionId: 'a2', value: 'tinv', rev: 2 },
			{ actionId: 'a3', value: 'later', rev: 3 },
		]);
		const result = await computeRevertedBlock(createBlockStorage('B'), 2);
		expect(result.kind).to.equal('restore');
		if (result.kind === 'restore') {
			// a3 overwrote the block after T_inv, so the as-if-absent content is a3's content.
			expect((result.block as ValueBlock).value).to.equal('later');
			expect(result.laterActions).to.equal(1);
		}
	});

	it('reports a deletion when T_inv created the block (no prior revision)', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'created-by-tinv', rev: 1 },
		]);
		const result = await computeRevertedBlock(createBlockStorage('B'), 1);
		expect(result.kind).to.equal('delete');
	});
});

describe('applyInvalidation', () => {
	// Build a challenger-wins proof whose votes are bound to `target` (defaults to the a2/B target the
	// apply tests revert) AND to the legitimately-selected set; the certificate verifies against the
	// matching apply target on layer 1 (applyInvalidation runs no recompute).
	async function challengerWinsProof(disputeId: string, messageHash: string, target: CertificateTarget = { invalidatedActionId: 'a2', blockIds: ['B'] }) {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const arbitratorSet = arbs.map(a => a.peerId.toString());
		const targetHash = await computeTargetHash(messageHash, target);
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		const votes = await Promise.all(arbs.map(a => makeVote(a, disputeId, 'agree-with-challenger', 'h', targetHash, setHash)));
		const arbitratorSetSignature = uint8ArrayToString(await challenger.privateKey.sign(arbitratorSetSigningPayload(disputeId, targetHash, setHash)), 'base64url');
		return buildDisputeResolutionProof(makeResolution(disputeId, 'challenger-wins', votes), messageHash, {
			arbitratorSet,
			challengerPeerId: challenger.peerId.toString(),
			arbitratorSetSignature,
		});
	}

	it('writes a new revision restoring pre-T_inv content and appends a durable invalidation entry', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'original', rev: 1 },
			{ actionId: 'a2', value: 'tinv', rev: 2 },
		]);
		const log = await Log.create<unknown>(new MemLogStore());
		const proof = await challengerWinsProof('d1', 'msg-1');

		const result = await applyInvalidation({ log, createBlockStorage }, {
			invalidatedActionId: 'a2', invalidatedRev: 2, blockIds: ['B'], proof,
		});

		expect(result.applied).to.equal(true);
		expect(result.rev).to.equal(3);
		// The block's current content is restored to the pre-T_inv value.
		const current = await createBlockStorage('B').getBlock();
		expect((current!.block as ValueBlock).value).to.equal('original');
		expect(current!.actionRev.rev).to.equal(3);
		// Durable committed-invalidated status, discoverable from the log.
		const inv = await log.findInvalidation('a2');
		expect(inv?.resolution.disputeId).to.equal('d1');
		expect(inv?.reverted[0]?.blockId).to.equal('B');
	});

	it('is idempotent: re-applying the same resolution yields one entry and one revision', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'original', rev: 1 },
			{ actionId: 'a2', value: 'tinv', rev: 2 },
		]);
		const log = await Log.create<unknown>(new MemLogStore());
		const proof = await challengerWinsProof('d1', 'msg-1');
		const ctx = { log, createBlockStorage };
		const params = { invalidatedActionId: 'a2', invalidatedRev: 2, blockIds: ['B'], proof } as const;

		const first = await applyInvalidation(ctx, params);
		const second = await applyInvalidation(ctx, params);

		expect(first.applied).to.equal(true);
		expect(second.applied).to.equal(false);
		expect(second.reason).to.equal('already-applied');

		// Exactly one invalidation entry in the log.
		let invCount = 0;
		for await (const entry of log.select()) {
			if (entry.invalidation) invCount++;
		}
		expect(invCount).to.equal(1);
		// Block still at the single compensating revision (no second revision written).
		expect((await createBlockStorage('B').getLatest())!.rev).to.equal(3);
	});

	it('rejects an invalid certificate and appends nothing', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'original', rev: 1 },
			{ actionId: 'a2', value: 'tinv', rev: 2 },
		]);
		const log = await Log.create<unknown>(new MemLogStore());
		// majority-wins is not a valid invalidation certificate.
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb()]);
		const arbitratorSet = arbs.map(a => a.peerId.toString());
		const targetHash = await computeTargetHash('msg-1', { invalidatedActionId: 'a2', blockIds: ['B'] });
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		const votes = await Promise.all(arbs.map(a => makeVote(a, 'd1', 'agree-with-majority', 'h', targetHash, setHash)));
		const arbitratorSetSignature = uint8ArrayToString(await challenger.privateKey.sign(arbitratorSetSigningPayload('d1', targetHash, setHash)), 'base64url');
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'majority-wins', votes), 'msg-1', {
			arbitratorSet, challengerPeerId: challenger.peerId.toString(), arbitratorSetSignature,
		});

		const result = await applyInvalidation({ log, createBlockStorage }, {
			invalidatedActionId: 'a2', invalidatedRev: 2, blockIds: ['B'], proof,
		});

		expect(result.applied).to.equal(false);
		expect(result.reason).to.equal('invalid-certificate');
		expect(await log.findInvalidation('a2')).to.be.undefined;
		// Block content untouched (still T_inv's value).
		expect(((await createBlockStorage('B').getBlock())!.block as ValueBlock).value).to.equal('tinv');
	});

	it('rejects a genuine proof replayed against a different action/blocks and writes nothing (#2 apply-path replay)', async () => {
		// A genuine challenger-wins proof bound to the REAL target (a2 / block B)…
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'original', rev: 1 },
			{ actionId: 'a2', value: 'tinv', rev: 2 },
		]);
		const log = await Log.create<unknown>(new MemLogStore());
		const proof = await challengerWinsProof('d1', 'msg-1', { invalidatedActionId: 'a2', blockIds: ['B'] });

		// …carried in an apply against an UNRELATED innocent action 'innocent'/block 'B' → rejected,
		// no revision and no log entry written.
		const result = await applyInvalidation({ log, createBlockStorage }, {
			invalidatedActionId: 'innocent', invalidatedRev: 2, blockIds: ['B'], proof,
		});

		expect(result.applied).to.equal(false);
		expect(result.reason).to.equal('invalid-certificate');
		expect(await log.findInvalidation('innocent')).to.be.undefined;
		// Block content untouched (still T_inv's value) — nothing was reverted.
		expect(((await createBlockStorage('B').getBlock())!.block as ValueBlock).value).to.equal('tinv');
	});

	it('records a deferred sentinel when T_inv created the block (delete-restore)', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'created-by-tinv', rev: 1 },
		]);
		const log = await Log.create<unknown>(new MemLogStore());
		const proof = await challengerWinsProof('d1', 'msg-1', { invalidatedActionId: 'a1', blockIds: ['B'] });

		const result = await applyInvalidation({ log, createBlockStorage }, {
			invalidatedActionId: 'a1', invalidatedRev: 1, blockIds: ['B'], proof,
		});

		expect(result.applied).to.equal(true);
		expect(result.reverted[0]?.restoredContentHash).to.equal(DEFERRED_DELETE_RESTORE);
	});

	it('converges: independent members compute the same restored hash and revision', async () => {
		// Two independent storages/logs, seeded identically, apply the same proof.
		const proof = await challengerWinsProof('d1', 'msg-1');
		const seedRevs = [
			{ actionId: 'a1', value: 'original', rev: 1 },
			{ actionId: 'a2', value: 'tinv', rev: 2 },
		];

		async function applyOnMember() {
			const raw = new MemoryRawStorage();
			const { createBlockStorage } = await seedBlock(raw, 'B', seedRevs);
			const log = await Log.create<unknown>(new MemLogStore());
			return applyInvalidation({ log, createBlockStorage }, {
				invalidatedActionId: 'a2', invalidatedRev: 2, blockIds: ['B'], proof,
			});
		}

		const [m1, m2] = await Promise.all([applyOnMember(), applyOnMember()]);
		expect(m1.rev).to.equal(m2.rev);
		expect(m1.reverted[0]?.restoredContentHash).to.equal(m2.reverted[0]?.restoredContentHash);
		expect(m1.reverted[0]?.restoredContentHash).to.be.a('string').and.not.equal(DEFERRED_DELETE_RESTORE);
	});
});
