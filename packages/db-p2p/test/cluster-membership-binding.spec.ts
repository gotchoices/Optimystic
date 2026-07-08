import { expect } from 'chai';
import { ClusterMember, clusterMember } from '../src/cluster/cluster-repo.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import { PersistentTransactionStateStore } from '../src/cluster/persistent-transaction-state-store.js';
import {
	membershipDigest,
	recordMembershipDigest,
	computeClusterMessageHash,
	computeClusterPromiseHash,
	computeClusterCommitHash,
	CURRENT_MEMBERSHIP_VERSION
} from '@optimystic/db-core';
import type {
	IRepo, ClusterRecord, RepoMessage, Signature, BlockGets, GetBlockResults, PendRequest, PendResult,
	CommitRequest, CommitResult, ActionBlocks, ClusterPeers
} from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import type { PersistedParticipantState } from '../src/cluster/i-transaction-state-store.js';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as u8ToString, fromString as u8FromString } from 'uint8arrays';

// ─── The pre-change ("legacy" / v1) hashing, reproduced verbatim from the implementation before this
//     ticket. These are the regression oracle: the version-dispatched helpers, given NO membership digest,
//     must reproduce these byte-for-byte so already-committed history and its commit certs keep verifying. ───

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.keys(v).sort().reduce((o: Record<string, unknown>, k) => { o[k] = v[k]; return o; }, {})
			: v
	);
}

const legacyMessageHash = async (message: RepoMessage): Promise<string> => {
	const bytes = new TextEncoder().encode(canonicalJson(message));
	return base58btc.encode((await sha256.digest(bytes)).digest);
};

const legacyPromiseHash = async (record: ClusterRecord): Promise<string> => {
	const bytes = new TextEncoder().encode(record.messageHash + canonicalJson(record.message));
	return u8ToString((await sha256.digest(bytes)).digest, 'base64url');
};

const legacyCommitHash = async (record: ClusterRecord): Promise<string> => {
	const bytes = new TextEncoder().encode(record.messageHash + canonicalJson(record.message) + canonicalJson(record.promises));
	return u8ToString((await sha256.digest(bytes)).digest, 'base64url');
};

// ─── Fixtures ───

interface KeyPair { peerId: PeerId; privateKey: PrivateKey; }

const makeKeyPair = async (): Promise<KeyPair> => {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
};

const makeClusterPeers = (keyPairs: KeyPair[], multiaddr = '/ip4/127.0.0.1/tcp/8000'): ClusterPeers => {
	const peers: ClusterPeers = {};
	for (const { peerId } of keyPairs) {
		peers[peerId.toString()] = {
			multiaddrs: [multiaddr],
			publicKey: u8ToString(peerId.publicKey!.raw, 'base64url')
		};
	}
	return peers;
};

const signVote = async (privateKey: PrivateKey, hash: string, type: 'approve' | 'reject', rejectReason?: string): Promise<string> => {
	const payload = hash + ':' + type + (rejectReason ? ':' + rejectReason : '');
	return u8ToString(await privateKey.sign(new TextEncoder().encode(payload)), 'base64url');
};

const makeMessage = (blockId = 'block-1'): RepoMessage => ({
	operations: [{ get: { blockIds: [blockId] } }],
	expiration: Date.now() + 30000
});

/** Build a well-formed v2 record: digest derived from peers, messageHash folded over it. */
const makeV2Record = async (peers: ClusterPeers, message: RepoMessage): Promise<ClusterRecord> => {
	const digest = await membershipDigest(peers);
	const messageHash = await computeClusterMessageHash(message, digest);
	return {
		messageHash,
		peers,
		membershipVersion: CURRENT_MEMBERSHIP_VERSION,
		membershipDigest: digest,
		message,
		promises: {},
		commits: {}
	};
};

const makeV1Record = async (peers: ClusterPeers, message: RepoMessage): Promise<ClusterRecord> => {
	const messageHash = await legacyMessageHash(message);
	return { messageHash, peers, message, promises: {}, commits: {} };
};

class MockRepo implements IRepo {
	async get(_blockGets: BlockGets): Promise<GetBlockResults> { return {}; }
	async pend(_request: PendRequest): Promise<PendResult> { return { success: true, blockIds: [], pending: [] }; }
	async commit(_request: CommitRequest): Promise<CommitResult> { return { success: true }; }
	async cancel(_actionRef: ActionBlocks): Promise<void> { /* no-op */ }
}

class MockPeerNetwork implements IPeerNetwork {
	async connect(_peerId: PeerId, _protocol: string): Promise<any> { return {}; }
}

const makeMember = (self: KeyPair): ClusterMember => clusterMember({
	storageRepo: new MockRepo(),
	peerNetwork: new MockPeerNetwork(),
	peerId: self.peerId,
	privateKey: self.privateKey
});

// ─── Tests ───

describe('cluster membership binding', () => {

	describe('membershipDigest determinism', () => {
		it('is independent of multiaddr contents and peer-map key insertion order', async () => {
			const [a, b, c] = await Promise.all([makeKeyPair(), makeKeyPair(), makeKeyPair()]);
			const idA = a.peerId.toString(), idB = b.peerId.toString(), idC = c.peerId.toString();

			// Same id set, different multiaddrs, different insertion order.
			const peers1: ClusterPeers = {
				[idA]: { multiaddrs: ['/ip4/127.0.0.1/tcp/1'], publicKey: 'pkA' },
				[idB]: { multiaddrs: ['/ip4/127.0.0.1/tcp/2'], publicKey: 'pkB' },
				[idC]: { multiaddrs: ['/ip4/127.0.0.1/tcp/3'], publicKey: 'pkC' }
			};
			const peers2: ClusterPeers = {
				[idC]: { multiaddrs: ['/dns4/example.com/tcp/9999'], publicKey: 'DIFFERENT' },
				[idA]: { multiaddrs: [], publicKey: 'x' },
				[idB]: { multiaddrs: ['/ip4/10.0.0.1/tcp/5', '/ip4/10.0.0.2/tcp/6'], publicKey: 'y' }
			};

			expect(await membershipDigest(peers1)).to.equal(await membershipDigest(peers2));
		});

		it('changes when an id is added or removed', async () => {
			const [a, b, c] = await Promise.all([makeKeyPair(), makeKeyPair(), makeKeyPair()]);
			const base = makeClusterPeers([a, b]);
			const added = makeClusterPeers([a, b, c]);
			const removed = makeClusterPeers([a]);

			const dBase = await membershipDigest(base);
			expect(await membershipDigest(added)).to.not.equal(dBase);
			expect(await membershipDigest(removed)).to.not.equal(dBase);
		});

		it('is well-defined for empty and single-peer sets', async () => {
			const emptyDigest = await membershipDigest({});
			expect(emptyDigest).to.be.a('string').with.length.greaterThan(0);
			// Deterministic constant for the empty set.
			expect(await membershipDigest({})).to.equal(emptyDigest);

			const solo = makeClusterPeers([await makeKeyPair()]);
			const soloDigest = await membershipDigest(solo);
			expect(soloDigest).to.be.a('string').with.length.greaterThan(0);
			expect(soloDigest).to.not.equal(emptyDigest);
		});
	});

	describe('v1 (legacy) hashing is byte-identical to the pre-change implementation', () => {
		it('messageHash matches for a record with no membershipVersion', async () => {
			const message = makeMessage();
			expect(await computeClusterMessageHash(message, recordMembershipDigest({}))).to.equal(await legacyMessageHash(message));
		});

		it('promiseHash and commitHash match for a v1 record', async () => {
			const peers = makeClusterPeers([await makeKeyPair(), await makeKeyPair()]);
			const v1 = await makeV1Record(peers, makeMessage());
			v1.promises = { 'p1': { type: 'approve', signature: 'sig' } as Signature };

			const digest = recordMembershipDigest(v1); // undefined for v1
			expect(await computeClusterPromiseHash(v1.messageHash, v1.message, digest)).to.equal(await legacyPromiseHash(v1));
			expect(await computeClusterCommitHash(v1.messageHash, v1.message, v1.promises, digest)).to.equal(await legacyCommitHash(v1));
		});
	});

	describe('v2 messageHash binds the peer set', () => {
		it('differs when the peer-id set differs but the message is identical', async () => {
			const [a, b, c] = await Promise.all([makeKeyPair(), makeKeyPair(), makeKeyPair()]);
			const message = makeMessage();

			const digestAB = await membershipDigest(makeClusterPeers([a, b]));
			const digestAC = await membershipDigest(makeClusterPeers([a, c]));
			const hashAB = await computeClusterMessageHash(message, digestAB);
			const hashAC = await computeClusterMessageHash(message, digestAC);

			expect(hashAB).to.not.equal(hashAC);
			// And both differ from the v1 (unbound) hash of the same message.
			expect(hashAB).to.not.equal(await legacyMessageHash(message));
		});

		it('is stable under multiaddr churn and peer-map reordering (message/promise/commit)', async () => {
			const [a, b] = await Promise.all([makeKeyPair(), makeKeyPair()]);
			const message = makeMessage();

			const peers1 = makeClusterPeers([a, b], '/ip4/127.0.0.1/tcp/1');
			// Same ids, different multiaddr, reversed insertion order.
			const peers2: ClusterPeers = {};
			peers2[b.peerId.toString()] = { multiaddrs: ['/ip4/9.9.9.9/tcp/2'], publicKey: 'zzz' };
			peers2[a.peerId.toString()] = { multiaddrs: ['/ip4/8.8.8.8/tcp/3'], publicKey: 'yyy' };

			const r1 = await makeV2Record(peers1, message);
			const r2 = await makeV2Record(peers2, message);

			expect(r1.messageHash).to.equal(r2.messageHash);
			const promises = { 'x': { type: 'approve', signature: 's' } as Signature };
			expect(await computeClusterPromiseHash(r1.messageHash, message, recordMembershipDigest(r1)))
				.to.equal(await computeClusterPromiseHash(r2.messageHash, message, recordMembershipDigest(r2)));
			expect(await computeClusterCommitHash(r1.messageHash, message, promises, recordMembershipDigest(r1)))
				.to.equal(await computeClusterCommitHash(r2.messageHash, message, promises, recordMembershipDigest(r2)));
		});
	});

	describe('validateRecord (via update)', () => {
		let self: KeyPair;
		let member: ClusterMember;
		beforeEach(async () => { self = await makeKeyPair(); member = makeMember(self); });
		afterEach(() => member.dispose());

		it('accepts a well-formed v2 record and adds our promise', async () => {
			const peers = makeClusterPeers([self, await makeKeyPair()]);
			const record = await makeV2Record(peers, makeMessage());
			const result = await member.update(record);
			expect(result.promises[self.peerId.toString()]).to.not.equal(undefined);
		});

		it('rejects a v2 record whose membershipDigest does not match its peers', async () => {
			const peers = makeClusterPeers([self, await makeKeyPair()]);
			const record = await makeV2Record(peers, makeMessage());
			// Tamper the declared digest (messageHash left as-is): digest check fires first.
			const tampered: ClusterRecord = { ...record, membershipDigest: 'not-the-real-digest' };

			try {
				await member.update(tampered);
				expect.fail('expected membership digest mismatch to throw');
			} catch (err) {
				expect((err as Error).message.toLowerCase()).to.include('membership digest mismatch');
			}
		});

		it('rejects a record with an unsupported membershipVersion', async () => {
			const peers = makeClusterPeers([self]);
			const record = await makeV2Record(peers, makeMessage());
			const bad: ClusterRecord = { ...record, membershipVersion: 3 as unknown as 2 };
			try {
				await member.update(bad);
				expect.fail('expected unsupported version to throw');
			} catch (err) {
				expect((err as Error).message.toLowerCase()).to.include('unsupported membershipversion');
			}
		});
	});

	describe('mergeRecords invariant', () => {
		it('rejects two v2 records with equal messageHash but different membership (invariant violation)', async () => {
			const self = await makeKeyPair();
			const member = makeMember(self);
			const message = makeMessage();

			const recA = await makeV2Record(makeClusterPeers([self, await makeKeyPair()]), message);
			// A different peer set → genuinely different digest — but force the SAME messageHash to model a
			// collision / protocol violation that must be caught rather than silently merged.
			const recB = await makeV2Record(makeClusterPeers([self, await makeKeyPair()]), message);
			const forced: ClusterRecord = { ...recB, messageHash: recA.messageHash };
			expect(forced.membershipDigest).to.not.equal(recA.membershipDigest);

			try {
				await (member as any).mergeRecords(recA, forced);
				expect.fail('expected peers-mismatch invariant to throw');
			} catch (err) {
				expect((err as Error).message).to.include('Peers mismatch');
			} finally {
				member.dispose();
			}
		});

		it('still merges two v2 records with the SAME membership (multiaddr churn) without throwing', async () => {
			const self = await makeKeyPair();
			const other = await makeKeyPair();
			const member = makeMember(self);
			const message = makeMessage();

			const r1 = await makeV2Record(makeClusterPeers([self, other], '/ip4/1.1.1.1/tcp/1'), message);
			// Same ids, different multiaddr → same digest & messageHash; peers OBJECT differs.
			const r2 = await makeV2Record(makeClusterPeers([self, other], '/ip4/2.2.2.2/tcp/2'), message);
			expect(r2.messageHash).to.equal(r1.messageHash);

			const merged = await (member as any).mergeRecords(r1, r2) as ClusterRecord;
			expect(merged.messageHash).to.equal(r1.messageHash);
			member.dispose();
		});
	});

	describe('state-store round-trip', () => {
		it('a v2 record persisted and recovered keeps its fields and re-verifies', async () => {
			const self = await makeKeyPair();
			const peers = makeClusterPeers([self, await makeKeyPair()]);
			const record = await makeV2Record(peers, makeMessage());

			// Persist through the real JSON-backed store.
			const store = new PersistentTransactionStateStore(new MemoryKVStore());
			const state: PersistedParticipantState = { messageHash: record.messageHash, record, lastUpdate: Date.now() };
			await store.saveParticipantState(record.messageHash, state);

			const [recovered] = await store.getAllParticipantStates();
			expect(recovered, 'state recovered').to.not.equal(undefined);
			expect(recovered!.record.membershipVersion).to.equal(CURRENT_MEMBERSHIP_VERSION);
			expect(recovered!.record.membershipDigest).to.equal(record.membershipDigest);

			// The recovered record must still validate (digest + messageHash re-check) on a fresh member.
			const member = makeMember(self);
			const result = await member.update(recovered!.record);
			expect(result.promises[self.peerId.toString()]).to.not.equal(undefined);
			member.dispose();
		});
	});

	describe('v1 commit cert remains verifiable under version dispatch', () => {
		it('a commit signature made over the legacy commit hash still verifies', async () => {
			const signer = await makeKeyPair();
			const peers = makeClusterPeers([signer, await makeKeyPair()]);
			const v1 = await makeV1Record(peers, makeMessage());
			v1.promises = {
				[signer.peerId.toString()]: { type: 'approve', signature: await signVote(signer.privateKey, await legacyPromiseHash(v1), 'approve') }
			};

			// Signer endorses the legacy commit-vote preimage (what a stored v1 commit cert carries).
			const storedHash = await legacyCommitHash(v1);
			const signedPayload = new TextEncoder().encode(storedHash + ':approve');
			const sig = u8FromString(await signVote(signer.privateKey, storedHash, 'approve'), 'base64url');

			// The version-dispatched helper (v1 ⇒ no digest) must reproduce the exact bytes that were signed.
			const recomputed = await computeClusterCommitHash(v1.messageHash, v1.message, v1.promises, recordMembershipDigest(v1));
			expect(recomputed).to.equal(storedHash);

			const pub = publicKeyFromRaw(signer.peerId.publicKey!.raw);
			expect(await pub.verify(signedPayload, sig)).to.equal(true);
		});
	});
});
