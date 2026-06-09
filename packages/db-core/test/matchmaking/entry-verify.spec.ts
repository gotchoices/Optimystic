import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	MatchmakingProvider,
	MatchmakingSeeker,
	verifyProviderEntry,
	verifySeekerEntry,
	providerEntryOf,
	seekerEntryOf,
	matchTopicId,
} from '../../src/matchmaking/index.js';
import type { EntrySigVerifier } from '../../src/matchmaking/index.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';

/**
 * Sign → forward → verify round-trip for the advisory trust model (option (b)): the seeker reconstructs
 * the signed image from the forwarded entry fields ALONE (no correlationId), so the entry's
 * registrationSig verifies. A deterministic `sha256(payload)` stand-in for the libp2p peer key keeps
 * this crypto-free at db-core; the injected verifier recomputes the same image and compares.
 */
const fakeSign = async (payload: Uint8Array): Promise<string> => bytesToB64url(sha256(payload));

/** Matches `fakeSign`: recompute sha256(payload) and compare to the forwarded signature bytes. */
const fakeVerify: EntrySigVerifier = (_signerId, payload, sig) => bytesToB64url(sha256(payload)) === bytesToB64url(sig);

describe('matchmaking / forwarded entry re-validation (sign → forward → verify)', () => {
	const topicId = matchTopicId('capability', 'pdf-render');

	it('verifies a provider entry reconstructed from forwarded fields alone', async () => {
		const provider = new MatchmakingProvider({ topicId, capabilities: ['pdf-render', 'gpu'], capacityBudget: 3, contactHint: 'p', sign: fakeSign });
		const payload = await provider.buildAppPayload();
		// The cohort forwards the registration as an entry (the seeker holds no correlationId).
		const entry = providerEntryOf({ participantId: 'peer-A', attachedAt: 123, payload });
		expect(verifyProviderEntry(topicId, entry, fakeVerify)).to.equal(true);
	});

	it('rejects a provider entry whose capacityBudget was tampered after signing', async () => {
		const provider = new MatchmakingProvider({ topicId, capabilities: ['pdf-render'], capacityBudget: 3, contactHint: 'p', sign: fakeSign });
		const payload = await provider.buildAppPayload();
		const entry = { ...providerEntryOf({ participantId: 'peer-A', attachedAt: 1, payload }), capacityBudget: 99 };
		expect(verifyProviderEntry(topicId, entry, fakeVerify)).to.equal(false);
	});

	it('rejects a provider entry forwarded under the wrong topicId', async () => {
		const provider = new MatchmakingProvider({ topicId, capabilities: ['pdf-render'], capacityBudget: 1, contactHint: 'p', sign: fakeSign });
		const entry = providerEntryOf({ participantId: 'peer-A', attachedAt: 1, payload: await provider.buildAppPayload() });
		expect(verifyProviderEntry(matchTopicId('capability', 'other'), entry, fakeVerify)).to.equal(false);
	});

	it('returns false (never throws) on a malformed registrationSig', () => {
		const entry = { participantId: 'p', capabilities: ['x'], capacityBudget: 1, contactHint: 'c', attachedAt: 1, registrationSig: '!!!not-base64url!!!' };
		expect(verifyProviderEntry(topicId, entry, fakeVerify)).to.equal(false);
	});

	it('verifies a seeker entry reconstructed from forwarded fields alone', async () => {
		const seeker = new MatchmakingSeeker({ topicId, wantCount: 8, contactHint: 's', sign: fakeSign });
		const entry = seekerEntryOf({ participantId: 'peer-S', attachedAt: 9, payload: await seeker.buildAppPayload() });
		expect(verifySeekerEntry(topicId, entry, fakeVerify)).to.equal(true);
	});

	it('rejects a seeker entry whose wantCount was tampered', async () => {
		const seeker = new MatchmakingSeeker({ topicId, wantCount: 8, contactHint: 's', sign: fakeSign });
		const entry = { ...seekerEntryOf({ participantId: 'peer-S', attachedAt: 1, payload: await seeker.buildAppPayload() }), wantCount: 1 };
		expect(verifySeekerEntry(topicId, entry, fakeVerify)).to.equal(false);
	});
});
