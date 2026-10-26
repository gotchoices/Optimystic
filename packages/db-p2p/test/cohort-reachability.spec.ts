import { expect } from 'chai';
import type { BlockId, ClusterPeers, RoutingKey } from '@optimystic/db-core';
import { KeyNetworkCohortReachability, type CohortReachabilityDeps } from '../src/network/cohort-reachability.js';

const SELF = 'self-peer';
const PARTNER = 'partner-peer';

/** A block's cohort as the key-network double reports it, or a lookup that throws. */
type CohortView = { members: string[]; absent?: string[] } | 'throws';

const utf8 = new TextDecoder();

function keyNetworkOver(views: Record<string, CohortView>, awaitingBootstrap = false): CohortReachabilityDeps['keyNetwork'] {
	const viewOf = (key: RoutingKey): CohortView => views[utf8.decode(key)] ?? { members: [] };
	return {
		async findCluster(key) {
			const view = viewOf(key);
			if (view === 'throws') throw new Error('lookup failed');
			return Object.fromEntries(view.members.map(id => [id, { multiaddrs: [], publicKey: '' }])) as ClusterPeers;
		},
		async absentCohortMembers(key) {
			const view = viewOf(key);
			return view === 'throws' ? [] : view.absent ?? [];
		},
		async awaitingBootstrapContact() {
			return awaitingBootstrap;
		},
	};
}

function gateOver(views: Record<string, CohortView>, options: { awaitingBootstrap?: boolean; identifying?: number } = {}): KeyNetworkCohortReachability {
	return new KeyNetworkCohortReachability({
		keyNetwork: keyNetworkOver(views, options.awaitingBootstrap),
		selfId: SELF,
		identifying: () => options.identifying ?? 0,
	});
}

const block = (id: string): BlockId => id as BlockId;
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('KeyNetworkCohortReachability', () => {
	describe('reachable', () => {
		it('is open when the cohort names a member other than this node', async () => {
			expect(await gateOver({ h: { members: [SELF, PARTNER] } }).reachable([block('h')])).to.equal(true);
		});

		it('is open when this node is genuinely alone: self-only, nothing absent, awaited or identifying', async () => {
			expect(await gateOver({ h: { members: [SELF] } }).reachable([block('h')])).to.equal(true);
		});

		it('is closed on a self-only view while a remembered member is absent', async () => {
			expect(await gateOver({ h: { members: [SELF], absent: [PARTNER] } }).reachable([block('h')])).to.equal(false);
		});

		it('is closed on a self-only view while a bootstrap peer is awaited', async () => {
			expect(await gateOver({ h: { members: [SELF] } }, { awaitingBootstrap: true }).reachable([block('h')])).to.equal(false);
		});

		it('is closed on a self-only view while an identify exchange is in flight', async () => {
			expect(await gateOver({ h: { members: [SELF] } }, { identifying: 1 }).reachable([block('h')])).to.equal(false);
		});

		it('is closed when the cohort is empty: nobody to commit with, this node included', async () => {
			expect(await gateOver({ h: { members: [] } }).reachable([block('h')])).to.equal(false);
		});

		it('is closed, not thrown, when the cohort lookup throws', async () => {
			expect(await gateOver({ h: 'throws' }).reachable([block('h')])).to.equal(false);
		});

		it('judges each block on its own: a partner on the tail does not open a header with an absent member', async () => {
			const gate = gateOver({ header: { members: [SELF], absent: [PARTNER] }, tail: { members: [SELF, PARTNER] } });
			expect(await gate.reachable([block('header'), block('tail')])).to.equal(false);
		});
	});

	describe('onChange', () => {
		it('coalesces a connection and the identify that follows it into one wake, and wakes nobody after the last unsubscribe', async () => {
			const events = new EventTarget();
			const gate = new KeyNetworkCohortReachability({
				keyNetwork: keyNetworkOver({}),
				selfId: SELF,
				events,
				wakeDebounceMs: 20,
			});
			let wakes = 0;
			const unsubscribe = gate.onChange(() => { wakes++; });

			events.dispatchEvent(new Event('connection:open'));
			events.dispatchEvent(new Event('peer:identify'));
			await settle(80);
			expect(wakes, 'one wake for the pair').to.equal(1);

			unsubscribe();
			unsubscribe();
			events.dispatchEvent(new Event('connection:open'));
			await settle(80);
			expect(wakes, 'no wake once unsubscribed').to.equal(1);
		});
	});
});
