import { expect } from 'chai';
import { sha256 } from '@noble/hashes/sha2.js';
import {
	shouldInstantiate,
	createForwarder,
	createColdStartManager,
	promotedRedirectReply,
	type ParentRegistrar,
} from '../../src/cohort-topic/coldstart.js';
import type { TopicTrafficV1 } from '../../src/cohort-topic/wire/types.js';

function bytes(label: string, len = 32): Uint8Array {
	return sha256(new TextEncoder().encode(label)).slice(0, len);
}

const TOPIC = bytes('coldstart-topic');
const PARENT = bytes('coldstart-parent');

describe('cohort-topic / cold-start gate', () => {
	it('instantiates for a bootstrap root request with a willing quorum', () => {
		expect(shouldInstantiate({ bootstrap: true, followOn: false, quorumWilling: true })).to.be.true;
	});

	it('instantiates for a Promoted follow-on with a willing quorum', () => {
		expect(shouldInstantiate({ bootstrap: false, followOn: true, quorumWilling: true })).to.be.true;
	});

	it('does NOT instantiate for a speculative probe (neither bootstrap nor follow-on)', () => {
		// A bare d_max probe with no growth signal must get NoState, not fork a parallel branch.
		expect(shouldInstantiate({ bootstrap: false, followOn: false, quorumWilling: true })).to.be.false;
	});

	it('does NOT instantiate without a willing quorum, even on a legitimate trigger', () => {
		expect(shouldInstantiate({ bootstrap: true, followOn: false, quorumWilling: false })).to.be.false;
		expect(shouldInstantiate({ bootstrap: false, followOn: true, quorumWilling: false })).to.be.false;
	});
});

describe('cohort-topic / cold-start forwarder lifecycle', () => {
	it('a cold root (tier 0) serves immediately — no parent to link', () => {
		const root = createForwarder(0);
		expect(root.phase()).to.equal('serving');
		expect(root.acceptsParticipants()).to.be.true;
		expect(root.servesParentOps()).to.be.true;
	});

	it('a deeper forwarder accepts participants but holds parent-ops until the parent ack', () => {
		const fwd = createForwarder(2);
		expect(fwd.phase()).to.equal('awaiting_parent');
		expect(fwd.acceptsParticipants(), 'accepts participants pre-ack').to.be.true;
		expect(fwd.servesParentOps(), 'holds notifications/queries needing the parent pre-ack').to.be.false;

		fwd.onParentAck();
		expect(fwd.phase()).to.equal('serving');
		expect(fwd.servesParentOps()).to.be.true;
	});

	it('rejects a negative forwarder tier', () => {
		expect(() => createForwarder(-1)).to.throw(RangeError);
	});
});

describe('cohort-topic / cold-start manager parent registration', () => {
	it('cold-root forms and serves under quorum without any parent registration', () => {
		let calls = 0;
		const registrar: ParentRegistrar = { registerWithParent: async () => { calls++; } };
		const mgr = createColdStartManager({ parentRegistrar: registrar });
		const root = mgr.instantiate(TOPIC, 0);
		expect(root.phase()).to.equal('serving');
		expect(calls, 'root never registers with a parent').to.equal(0);
		expect(mgr.get(TOPIC)).to.equal(root);
	});

	it('registers a deeper forwarder with its parent and flips to serving on ack', async () => {
		let resolveAck!: () => void;
		const ack = new Promise<void>((res) => { resolveAck = res; });
		let registeredWith: Uint8Array | undefined;
		const registrar: ParentRegistrar = {
			registerWithParent: async (_topic, parentCoord) => { registeredWith = parentCoord; return ack; },
		};
		const mgr = createColdStartManager({ parentRegistrar: registrar });

		const fwd = mgr.instantiate(TOPIC, 1, PARENT);
		expect(fwd.acceptsParticipants(), 'accepts participants during link-up').to.be.true;
		expect(fwd.servesParentOps(), 'holds parent-ops until ack').to.be.false;
		expect(registeredWith, 'kicked off parent registration at the parent coord').to.deep.equal(PARENT);

		resolveAck();
		await new Promise<void>((r) => setTimeout(r, 0)); // flush the registrar promise + .then(onParentAck)
		expect(fwd.servesParentOps(), 'serving after parent ack').to.be.true;
	});

	it('keeps a forwarder holding parent-ops when parent registration fails (no auto-retry)', async () => {
		// Gap-flagged behavior: a failed parent registration is logged, not swallowed silently, and the
		// forwarder is left accepting participants but holding parent-involving ops so a host-driven
		// retry can complete the link-up. It must NOT spuriously flip to serving.
		const warnings: unknown[][] = [];
		const realWarn = console.warn;
		console.warn = (...args: unknown[]): void => { warnings.push(args); };
		try {
			const registrar: ParentRegistrar = {
				registerWithParent: async () => { throw new Error('parent unreachable'); },
			};
			const mgr = createColdStartManager({ parentRegistrar: registrar });
			const fwd = mgr.instantiate(TOPIC, 1, PARENT);
			await new Promise<void>((r) => setTimeout(r, 0)); // flush the rejected registrar promise + .catch
			expect(fwd.acceptsParticipants(), 'still accepts participants after a failed link-up').to.be.true;
			expect(fwd.servesParentOps(), 'does NOT serve parent-ops on a failed registration').to.be.false;
			expect(fwd.phase()).to.equal('awaiting_parent');
			expect(warnings.length, 'the failure is surfaced via console.warn, not swallowed').to.equal(1);
		} finally {
			console.warn = realWarn;
		}
	});

	it('requires a parentCoord for a deeper-than-root forwarder', () => {
		const registrar: ParentRegistrar = { registerWithParent: async () => {} };
		const mgr = createColdStartManager({ parentRegistrar: registrar });
		expect(() => mgr.instantiate(TOPIC, 2)).to.throw(/parentCoord/);
	});

	it('is idempotent per topic — a second instantiate returns the same forwarder', () => {
		const registrar: ParentRegistrar = { registerWithParent: async () => {} };
		const mgr = createColdStartManager({ parentRegistrar: registrar });
		const a = mgr.instantiate(TOPIC, 0);
		const b = mgr.instantiate(TOPIC, 0);
		expect(a).to.equal(b);
	});
});

describe('cohort-topic / just-promoted burst', () => {
	const traffic: TopicTrafficV1 = {
		windowSeconds: 60,
		arrivalsPerMin: 120,
		queriesPerMin: 0,
		directParticipants: 64,
		childCohortCount: 0,
	};

	it('bounces a burst at a just-promoted cohort with Promoted(d+1) — not buffered, not UnwillingCohort', () => {
		// A cohort that has just promoted (child tier not fully instantiated) bounces the in-flight burst
		// with a cheap single-RPC redirect. Resolved GROUNDING question: bounce, never buffer/decline.
		const reply = promotedRedirectReply(1, traffic);
		expect(reply.result).to.equal('promoted');
		expect(reply.result).to.not.equal('unwilling_cohort');
		expect(reply.targetTier).to.equal(1);
		// The outgoing cohort's traffic rides along so the redirected participant can gauge the target.
		expect(reply.topicTraffic).to.deep.equal(traffic);
	});

	it('builds a redirect without traffic when none is supplied', () => {
		const reply = promotedRedirectReply(2);
		expect(reply.result).to.equal('promoted');
		expect(reply.targetTier).to.equal(2);
		expect(reply.topicTraffic).to.equal(undefined);
	});

	it('rejects a non-positive redirect target tier', () => {
		expect(() => promotedRedirectReply(0)).to.throw(RangeError);
	});
});
