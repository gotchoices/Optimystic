/**
 * Regression gates for the cost of a cold `APPLY SCHEMA` through the COORDINATED commit path
 * (`NetworkTransactor` -> `CoordinatorRepo` -> solo-cohort branch).
 *
 * ## Why this path, specifically
 *
 * `local-transactor-read-cache.spec.ts` already guards the `local` transactor seam. Nothing
 * guarded the coordinated one — and that is precisely the path that regressed in the field
 * (GitHub issue #8): a host that had been routing cold schema apply through a local transactor
 * switched to the coordinated path and a ~3 s founding operation became a multi-minute one. The
 * numbers below were measured while diagnosing that report, against both a real libp2p node and
 * this harness (they agree exactly — see "Fidelity" below).
 *
 * ## What is asserted, and what deliberately is not
 *
 * Operation COUNTS, never wall clock — the same rule `local-transactor-read-cache.spec.ts`
 * states, for the same reason: wall clock on this workload varies several-fold between runs on
 * one host. Five dimensions, each catching a failure the others cannot:
 *
 * 1. **Driver calls per object** — read amplification at the storage seam. This is the dimension
 *    issue #8 was filed about (reported at 194/object; `withReadCache` brought it to ~23-33, and
 *    the catalog batch below to ~6-18).
 * 2. **Commits per object** — commit-count amplification, which a read cache cannot touch. The
 *    plugin's `beginSchemaBatch`/`endSchemaBatch` hooks coalesce every catalog write of one
 *    `APPLY SCHEMA` into ONE catalog commit (`schema-batch.spec.ts`), so what a cold apply of
 *    empty tables costs today is that one commit plus one flush per invented index tree —
 *    `1 + I` — until `schema-batch-index-tree-flush-deferral` removes the per-index flush. It is
 *    the dimension a "one substrate commit per DDL" regression shows up in.
 * 3. **Cost per object must not GROW with schema size.** A fixed-size gate cannot catch a
 *    quadratic: at one scale an O(n^2) path and an O(n) path both just look like "some number".
 *    Running two scales and comparing per-object cost is what makes superlinearity visible.
 *    This was not hypothetical here — before the catalog batch, `ITransactor.get` per object
 *    measured 41 / 55 / 81 for 22 / 67 / 250 objects (each created object re-read a growing
 *    catalog) while the read cache hid it at the storage seam. The batch opens the catalog once
 *    per apply, and gates 5 and 6 now pin non-growth at the transactor seam directly.
 * 4. **`findCluster` calls per commit** — the key-network seam. Its per-call COST is
 *    environment-dependent (it was 3.4 ms on a solo Node process until self-address memoization
 *    landed in `libp2p-key-network.ts`, and is device-dependent on React Native), so the cost is
 *    not assertable here. The call COUNT is, and a regression that starts consulting the cohort
 *    more often per commit is the thing that would make that cost matter again.
 * 5. **Substrate round trips per object** — EVERY `ITransactor` method call, whatever it is. The
 *    device-relevant figure: on React Native each one is a cohort consult plus a native-bridge
 *    crossing, and driver calls counted below the read cache (gate 1) cannot see a cache miss
 *    that still crosses the bridge. Gate 6.
 *
 * ## Fidelity of the harness
 *
 * A 1-node mesh over `buildNetworkTransactor` reaches the real `NetworkTransactor` and the real
 * `CoordinatorRepo.commit` solo-cohort branch, with no sockets and no libp2p boot.
 *
 * `createMesh` does NOT wrap its storage in the read cache — only `libp2p-node-base.resolveStorage`
 * does that in production — so this spec wraps it explicitly. That is load-bearing, not incidental:
 * unwrapped, the same workload costs 312 and 396 driver calls per object at the two scales below
 * (and per-object cost RISES with scale); wrapped, it costs 32.7 and 23.5 and per-object cost
 * falls. Both figures match a real `createLibp2pNode` run exactly, so what is gated here is what
 * production does. If this spec is ever changed to drop the wrap, gate 1 and gate 3 both become
 * meaningless — they would be measuring an uncached configuration nothing ships.
 *
 * Thresholds carry ~20% headroom over measured values so ordinary churn does not trip them; they
 * are ceilings on a known-good shape, not targets. A failure means "the cost shape changed" —
 * re-measure and move the number deliberately, with the new figure recorded in the commit.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import {
	KvRawStorage,
	MemoryStoreDriver,
	withReadCache,
	type IRawStorage,
	type RawStoreDriver,
} from '@optimystic/db-p2p';
import { createMesh, buildNetworkTransactor } from '@optimystic/db-p2p/testing';
import type { ITransactor, IKeyNetwork } from '@optimystic/db-core';
import register from '../dist/plugin.js';

/** Every read the driver surface offers. Split from writes so amplification is attributable. */
const READ_METHODS = [
	'getMetadata', 'getRevision', 'rangeRevisions', 'getPending',
	'listPendingActionIds', 'getTransaction', 'getMaterialized', 'getProof',
] as const;

const WRITE_METHODS = [
	'putMetadata', 'putRevision', 'putPending', 'deletePending', 'putTransaction',
	'putProof', 'putMaterialized', 'deleteMaterialized', 'promote',
] as const;

type Counts = Record<string, number>;

/** Count every method call by name, then delegate. Used at three seams. */
function counting<T extends object>(inner: T, counts: Counts): T {
	return new Proxy(inner, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== 'function') return value;
			return (...args: unknown[]) => {
				const name = String(prop);
				counts[name] = (counts[name] ?? 0) + 1;
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	}) as T;
}

const sumOf = (counts: Counts, keys: readonly string[]): number =>
	keys.reduce((sum, k) => sum + (counts[k] ?? 0), 0);

/**
 * A schema of the shape a real application schema has — several columns, a text primary key, and
 * secondary indexes over a subset of the tables. Deliberately tables + indexes only: views and
 * assertions would drag in engine behaviour that has nothing to do with what is being measured.
 */
function buildSchemaBody(tables: number, indexes: number): string {
	const parts: string[] = [];
	for (let i = 0; i < tables; i++) {
		parts.push(`\n  table T${i} (Id text, Name text, Amount integer, primary key (Id));`);
	}
	for (let i = 0; i < indexes; i++) {
		parts.push(`\n  index T${i % tables}ByName${i} on T${i % tables} (Name);`);
	}
	return parts.join('');
}

interface ApplyCost {
	objects: number;
	driverCalls: number;
	driverReads: number;
	commits: number;
	transactorGets: number;
	/** Every `ITransactor` method call — the substrate round trips gate 6 pins. */
	transactorCalls: number;
	/** The same, by method — printed so a gate 6 failure says WHICH call multiplied. */
	transactorByMethod: Counts;
	findClusterCalls: number;
	/** Per-object driver cost — the figure gate 3 compares ACROSS scales. */
	callsPerObject: number;
	/** Per-object transactor reads — gate 5. */
	getsPerObject: number;
	/** Per-object substrate round trips — gate 6. */
	roundTripsPerObject: number;
}

/**
 * Run one cold `APPLY SCHEMA` against a fresh 1-node mesh and return what it cost.
 *
 * Counting happens at three seams because a regression can land at any of them independently:
 * below the read cache (what reaches the backend), at `ITransactor` (how many coordinated
 * commits), and at `IKeyNetwork` (how often the cohort is consulted).
 */
async function measureColdApply(tables: number, indexes: number): Promise<ApplyCost> {
	const driverCounts: Counts = {};
	const transactorCounts: Counts = {};
	const keyNetworkCounts: Counts = {};

	const mesh = await createMesh(1, {
		responsibilityK: 1,
		clusterSize: 1,
		clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
		// The wrap is what makes this production-shaped — see "Fidelity" in the file header.
		// Counting BELOW it is the only place the cache's effect is observable, exactly as
		// `local-transactor-read-cache.spec.ts` argues at its own seam.
		rawStorageFactory: (): IRawStorage =>
			withReadCache(
				new KvRawStorage(counting<RawStoreDriver>(new MemoryStoreDriver(), driverCounts)),
				'cold-apply-cost'
			).storage,
	});
	mesh.keyNetwork = counting<IKeyNetwork>(mesh.keyNetwork, keyNetworkCounts);
	const transactor = counting<ITransactor>(buildNetworkTransactor(mesh), transactorCounts);

	const db = new Database();
	// `default_transactor` is left unset so it resolves to 'network'; the mesh-backed
	// NetworkTransactor is injected under that cache key before any DDL runs.
	const plugin = register(db, {
		default_key_network: 'libp2p',
		enable_cache: false,
	} as unknown as Record<string, SqlValue>);
	plugin.collectionFactory.registerTransactor('network:libp2p', transactor);
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);

	await db.exec(`PRAGMA default_vtab_module='optimystic'`);

	const sql = `declare schema main {${buildSchemaBody(tables, indexes)}\n}\napply schema main;`;
	for await (const _row of db.eval(sql)) { /* drain */ }

	const objects = tables + indexes;
	const driverReads = sumOf(driverCounts, READ_METHODS);
	const driverCalls = driverReads + sumOf(driverCounts, WRITE_METHODS);
	const transactorGets = transactorCounts['get'] ?? 0;
	const transactorCalls = sumOf(transactorCounts, Object.keys(transactorCounts));

	return {
		objects,
		driverCalls,
		driverReads,
		commits: transactorCounts['commit'] ?? 0,
		transactorGets,
		transactorCalls,
		transactorByMethod: { ...transactorCounts },
		findClusterCalls: keyNetworkCounts['findCluster'] ?? 0,
		callsPerObject: driverCalls / objects,
		getsPerObject: transactorGets / objects,
		roundTripsPerObject: transactorCalls / objects,
	};
}

// Two scales. The SMALL one is the schema shape from the on-device report on issue #8 (9 tables
// + 13 indexes); the LARGE one is the schema from the issue itself (54 + 13). Gate 3 needs both.
const SMALL = { tables: 9, indexes: 13 };
const LARGE = { tables: 54, indexes: 13 };

/**
 * Measured 2026-09-10, after the `APPLY SCHEMA` catalog batch landed; thresholds carry ~20%
 * headroom. Re-measure before moving any of them.
 *
 * For the record, the same workload measured 2026-09-03, BEFORE the batch: driver calls 32.7 /
 * 23.5 per object, commits 1.59 / 1.19 per object (35 / 80 absolute — `T + 2·I`), findCluster
 * 2.40 / 2.23 per commit, and transactor gets 40.9 / 55.0 per object (899 / 3683 absolute).
 * Round trips (gate 6) were not counted then; gets and commits alone were 934 / 3763, against
 * 91 / 181 total today. Commits are now `1 + I` (14 at both scales) and gets no longer grow
 * with scale.
 */
const MEASURED = {
	small: { callsPerObject: 17.6, commitsPerObject: 0.64, findClusterPerCommit: 3.00, getsPerObject: 2.5, roundTripsPerObject: 4.1 },
	large: { callsPerObject: 6.4, commitsPerObject: 0.21, findClusterPerCommit: 3.00, getsPerObject: 1.5, roundTripsPerObject: 2.7 },
};

/**
 * Per-scale ceilings, ~20% over the measured value. Fixed costs (the one catalog commit, the 13
 * index-tree flushes shared by both schemas) amortize over more objects at the large scale, so
 * one number for both would either be slack at one scale or trip at the other.
 */
const MAX_DRIVER_CALLS_PER_OBJECT = { small: 21, large: 8 };
const MAX_COMMITS_PER_OBJECT = { small: 0.77, large: 0.26 };
const MAX_FINDCLUSTER_PER_COMMIT = 3.6;
const MAX_GETS_PER_OBJECT = { small: 3.0, large: 1.8 };
const MAX_ROUND_TRIPS_PER_OBJECT = { small: 5.0, large: 3.3 };
/** Gates 3, 5 and 6: per-object cost may not grow with scale, bar a few percent of noise. */
const SCALE_GROWTH_TOLERANCE = 1.05;

describe('cold `apply schema` cost through the coordinated commit path', function () {
	// Two full schema applies over an in-process mesh; no sockets, no libp2p boot.
	this.timeout(60_000);

	let small: ApplyCost;
	let large: ApplyCost;

	before(async () => {
		small = await measureColdApply(SMALL.tables, SMALL.indexes);
		large = await measureColdApply(LARGE.tables, LARGE.indexes);
	});

	it('gate 1: raw-storage calls per created object stay bounded', () => {
		// The dimension issue #8 reported at 194/object. `withReadCache` is what holds this down;
		// if this trips, check FIRST that the cache is still attached — an unwrapped store costs
		// an order of magnitude more (312/object at this scale) and fails here immediately.
		expect(small.callsPerObject, `small: ${small.driverCalls} calls / ${small.objects} objects`)
			.to.be.at.most(MAX_DRIVER_CALLS_PER_OBJECT.small);
		expect(large.callsPerObject, `large: ${large.driverCalls} calls / ${large.objects} objects`)
			.to.be.at.most(MAX_DRIVER_CALLS_PER_OBJECT.large);
	});

	it('gate 2: coordinated commits per created object stay bounded', () => {
		// A read cache cannot help here — this is the commit-count axis the catalog batch
		// improved (`T + 2·I` -> `1 + I`: one catalog commit per apply plus one flush per invented
		// index tree), and the axis a commit retry loop blows out. The per-index flush is the
		// next ticket's (`schema-batch-index-tree-flush-deferral`); when it lands this becomes
		// "exactly one commit at both scales".
		expect(small.commits / small.objects, `small: ${small.commits} commits / ${small.objects} objects`)
			.to.be.at.most(MAX_COMMITS_PER_OBJECT.small);
		expect(large.commits / large.objects, `large: ${large.commits} commits / ${large.objects} objects`)
			.to.be.at.most(MAX_COMMITS_PER_OBJECT.large);
	});

	it('gate 3: per-object cost does not grow as the schema grows', () => {
		// The gate a fixed-size threshold cannot express. Today per-object cost FALLS with scale
		// (17.6 -> 6.4) because fixed setup amortizes; the assertion is only that it must not
		// rise. A regression that makes each object re-read the whole catalog uncached shows up
		// here as a rising number long before it trips gate 1 at any single scale.
		expect(
			large.callsPerObject,
			`per-object cost rose with scale: ${small.callsPerObject.toFixed(1)} at ${small.objects} objects ` +
			`-> ${large.callsPerObject.toFixed(1)} at ${large.objects}. Something is scaling superlinearly.`
		).to.be.at.most(small.callsPerObject * SCALE_GROWTH_TOLERANCE);
	});

	it('gate 4: cohort lookups per commit stay bounded', () => {
		// Counts, not cost: `findCluster`'s per-call cost is environment-dependent (it was 3.4 ms
		// on a solo Node process before self-address memoization landed, and is device-dependent
		// on React Native), so only the call count is stable enough to assert.
		//
		// SCOPE: this counts the lookups the TRANSACTOR drives, which is what the proxy over
		// `mesh.keyNetwork` sees. Each mesh node derives its cohort from its own self-including
		// key-network view (see `MeshOptions.deriveExpectedCluster`), so the coordinator-side
		// `getClusterPeerIds` calls inside `CoordinatorRepo.commit` are NOT in this number. That
		// is a stable seam, not a complete one — a regression that adds a lookup on the
		// coordinator side needs its own gate in `db-p2p`, where that seam is reachable.
		//
		// The ratio ROSE from 2.40 / 2.23 to 3.00 when the catalog batch landed, while the
		// absolute count fell (84 -> 42, 178 -> 42): the commits the batch removed were the
		// per-DDL catalog re-commits, which touch fewer blocks (~2 lookups each) than the
		// invented index-tree flushes that remain (3 each). A ratio is the right gate for a
		// per-commit cost; just do not read a rising ratio here as more cohort traffic.
		expect(small.findClusterCalls / small.commits, `small: ${small.findClusterCalls} findCluster / ${small.commits} commits`)
			.to.be.at.most(MAX_FINDCLUSTER_PER_COMMIT);
		expect(large.findClusterCalls / large.commits, `large: ${large.findClusterCalls} findCluster / ${large.commits} commits`)
			.to.be.at.most(MAX_FINDCLUSTER_PER_COMMIT);
	});

	it('gate 5: transactor reads per object stay bounded and do not grow with scale', () => {
		// The number gate 3 CANNOT see. Before the catalog batch, `ITransactor.get` per object
		// was 40.9 / 55.0 / 80.6 at 22 / 67 / 250 objects — each created object re-read a catalog
		// that grew underneath it — and gate 3 read flat (32.7 -> 23.5) because the read cache
		// absorbed the growth before it reached the driver. This gate then had to be a ceiling
		// per scale, since the growth was real. The batch opens the catalog ONCE per apply and
		// answers every catalog read from that one tree plus its in-memory overlay, so the
		// per-object figure now FALLS with scale (2.5 -> 1.5) and the gate is the same shape as
		// gate 3: must not grow — plus a ceiling per scale so an absolute regression at one
		// scale cannot hide behind a flat curve.
		expect(small.getsPerObject, `small: ${small.transactorGets} gets / ${small.objects} objects`)
			.to.be.at.most(MAX_GETS_PER_OBJECT.small);
		expect(large.getsPerObject, `large: ${large.transactorGets} gets / ${large.objects} objects`)
			.to.be.at.most(MAX_GETS_PER_OBJECT.large);
		expect(
			large.getsPerObject,
			`transactor reads per object rose with scale: ${small.getsPerObject.toFixed(2)} at ${small.objects} objects ` +
			`-> ${large.getsPerObject.toFixed(2)} at ${large.objects}. Something re-reads the catalog per object again.`
		).to.be.at.most(small.getsPerObject * SCALE_GROWTH_TOLERANCE);
	});

	it('gate 6: substrate round trips per object stay bounded and do not grow with scale', () => {
		// The device-relevant figure: EVERY `ITransactor` method call (get, pend, commit, …). On
		// React Native each is a cohort consult plus a native-bridge crossing, which the three
		// app teams on issue #8 measured as the cost that dominates — halving the price of each
		// call moved end-to-end time by only 6-16%, so it is the COUNT that has to stay down.
		// Gate 1 cannot stand in for this: it counts below the read cache, so a cache miss that
		// still crosses the bridge is invisible there. Gate 5 is one method of it; gate 2 another.
		expect(small.roundTripsPerObject, `small: ${small.transactorCalls} transactor calls / ${small.objects} objects`)
			.to.be.at.most(MAX_ROUND_TRIPS_PER_OBJECT.small);
		expect(large.roundTripsPerObject, `large: ${large.transactorCalls} transactor calls / ${large.objects} objects`)
			.to.be.at.most(MAX_ROUND_TRIPS_PER_OBJECT.large);
		expect(
			large.roundTripsPerObject,
			`round trips per object rose with scale: ${small.roundTripsPerObject.toFixed(2)} at ${small.objects} objects ` +
			`-> ${large.roundTripsPerObject.toFixed(2)} at ${large.objects}.`
		).to.be.at.most(small.roundTripsPerObject * SCALE_GROWTH_TOLERANCE);
	});

	it('reports the measured cost (diagnostic, not an assertion)', () => {
		// Printed so a failure above has its context in the same output, and so a deliberate
		// threshold move has a number to copy. Mirrors the before/after print in
		// `cached-raw-storage.spec.ts`.
		for (const [label, cost, baseline] of [
			['small', small, MEASURED.small],
			['large', large, MEASURED.large],
		] as const) {
			console.log(
				`      ${label} (${cost.objects} objects): ` +
				`${cost.driverCalls} driver calls (${cost.driverReads} reads) = ${cost.callsPerObject.toFixed(1)}/object ` +
				`[baseline ${baseline.callsPerObject}], ` +
				`${cost.commits} commits = ${(cost.commits / cost.objects).toFixed(2)}/object ` +
				`[baseline ${baseline.commitsPerObject}], ` +
				`${cost.findClusterCalls} findCluster = ${(cost.findClusterCalls / cost.commits).toFixed(2)}/commit ` +
				`[baseline ${baseline.findClusterPerCommit}], ` +
				`${cost.transactorGets} transactor gets = ${cost.getsPerObject.toFixed(1)}/object ` +
				`[baseline ${baseline.getsPerObject}], ` +
				`${cost.transactorCalls} round trips = ${cost.roundTripsPerObject.toFixed(1)}/object ` +
				`[baseline ${baseline.roundTripsPerObject}] ` +
				`(${Object.entries(cost.transactorByMethod).map(([method, n]) => `${method} ${n}`).join(', ')})`
			);
		}
	});
});
