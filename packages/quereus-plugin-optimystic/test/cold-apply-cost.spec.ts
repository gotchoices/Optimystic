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
 * one host. Four dimensions, each catching a failure the others cannot:
 *
 * 1. **Driver calls per object** — read amplification at the storage seam. This is the dimension
 *    issue #8 was filed about (reported at 194/object; `withReadCache` brought it to ~23-33).
 * 2. **Commits per object** — commit-count amplification, which a read cache cannot touch. This
 *    is what `beginSchemaBatch`/`endSchemaBatch` would improve, and what a retry loop would blow
 *    out. It is the dimension a "one substrate commit per DDL" regression shows up in.
 * 3. **Cost per object must not GROW with schema size.** A fixed-size gate cannot catch a
 *    quadratic: at one scale an O(n^2) path and an O(n) path both just look like "some number".
 *    Running two scales and comparing per-object cost is what makes superlinearity visible.
 *    This is not hypothetical here — `ITransactor.get` per object is measured at 41 / 55 / 81 for
 *    22 / 67 / 250 objects, i.e. each created object re-reads a growing catalog. The read cache
 *    absorbs it at the storage seam today, which is exactly why it needs its own gate: the day
 *    the cache stops absorbing it, this is the number that moves first.
 * 4. **`findCluster` calls per commit** — the key-network seam. Its per-call COST is
 *    environment-dependent (it was 3.4 ms on a solo Node process until self-address memoization
 *    landed in `libp2p-key-network.ts`, and is device-dependent on React Native), so the cost is
 *    not assertable here. The call COUNT is, and a regression that starts consulting the cohort
 *    more often per commit is the thing that would make that cost matter again.
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
	findClusterCalls: number;
	/** Per-object driver cost — the figure gate 3 compares ACROSS scales. */
	callsPerObject: number;
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

	return {
		objects,
		driverCalls,
		driverReads,
		commits: transactorCounts['commit'] ?? 0,
		transactorGets: transactorCounts['get'] ?? 0,
		findClusterCalls: keyNetworkCounts['findCluster'] ?? 0,
		callsPerObject: driverCalls / objects,
	};
}

// Two scales. The SMALL one is the schema shape from the on-device report on issue #8 (9 tables
// + 13 indexes); the LARGE one is the schema from the issue itself (54 + 13). Gate 3 needs both.
const SMALL = { tables: 9, indexes: 13 };
const LARGE = { tables: 54, indexes: 13 };

/** Measured 2026-09-03; thresholds carry ~20% headroom. Re-measure before moving any of them. */
const MEASURED = {
	small: { callsPerObject: 32.7, commitsPerObject: 1.59, findClusterPerCommit: 2.40, getsPerObject: 40.9 },
	large: { callsPerObject: 23.5, commitsPerObject: 1.19, findClusterPerCommit: 2.23, getsPerObject: 55.0 },
};

const MAX_DRIVER_CALLS_PER_OBJECT = 40;
const MAX_COMMITS_PER_OBJECT = 2.0;
const MAX_FINDCLUSTER_PER_COMMIT = 3.0;
/** Gate 3's allowance: per-object cost may not grow with scale, bar a few percent of noise. */
const SCALE_GROWTH_TOLERANCE = 1.05;
/**
 * Gate 5's ceilings — one per scale, because this quantity legitimately GROWS with scale today
 * and a cross-scale comparison would fail on arrival. See gate 5 for why it is gated anyway.
 */
const MAX_GETS_PER_OBJECT = { small: 50, large: 66 };

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
			.to.be.at.most(MAX_DRIVER_CALLS_PER_OBJECT);
		expect(large.callsPerObject, `large: ${large.driverCalls} calls / ${large.objects} objects`)
			.to.be.at.most(MAX_DRIVER_CALLS_PER_OBJECT);
	});

	it('gate 2: coordinated commits per created object stay bounded', () => {
		// A read cache cannot help here — this is the commit-count axis that the unimplemented
		// `beginSchemaBatch`/`endSchemaBatch` hooks would improve, and the axis a commit retry
		// loop blows out. A cold apply should cost a small constant number of commits per object.
		expect(small.commits / small.objects, `small: ${small.commits} commits / ${small.objects} objects`)
			.to.be.at.most(MAX_COMMITS_PER_OBJECT);
		expect(large.commits / large.objects, `large: ${large.commits} commits / ${large.objects} objects`)
			.to.be.at.most(MAX_COMMITS_PER_OBJECT);
	});

	it('gate 3: per-object cost does not grow as the schema grows', () => {
		// The gate a fixed-size threshold cannot express. Today per-object cost FALLS with scale
		// (32.7 -> 23.5) because fixed setup amortizes; the assertion is only that it must not
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
		expect(small.findClusterCalls / small.commits, `small: ${small.findClusterCalls} findCluster / ${small.commits} commits`)
			.to.be.at.most(MAX_FINDCLUSTER_PER_COMMIT);
		expect(large.findClusterCalls / large.commits, `large: ${large.findClusterCalls} findCluster / ${large.commits} commits`)
			.to.be.at.most(MAX_FINDCLUSTER_PER_COMMIT);
	});

	it('gate 5: transactor reads per object do not get worse than the shape measured here', () => {
		// The number gate 3 CANNOT see. `ITransactor.get` per object is 40.9 / 55.0 / 80.6 at
		// 22 / 67 / 250 objects — each created object re-reads a catalog that grows underneath
		// it. Gate 3 watches DRIVER calls, and the read cache absorbs this growth before it
		// reaches the driver, so gate 3 reads flat (32.7 -> 23.5) while this rises. Nothing
		// would have caught it.
		//
		// Unlike gate 3 this asserts a CEILING PER SCALE rather than "must not grow", because
		// the growth is real and present: a no-growth assertion would fail the moment it was
		// written. What this pins is that the shape does not get WORSE unnoticed. It is not a
		// blessing of the current curve — that is tracked as its own work item; see
		// `tickets/backlog/feat-schema-batch-hooks-for-apply-schema`, whose batch-scoped context
		// is what would stop the catalog being re-read per object at all.
		expect(small.transactorGets / small.objects, `small: ${small.transactorGets} gets / ${small.objects} objects`)
			.to.be.at.most(MAX_GETS_PER_OBJECT.small);
		expect(large.transactorGets / large.objects, `large: ${large.transactorGets} gets / ${large.objects} objects`)
			.to.be.at.most(MAX_GETS_PER_OBJECT.large);
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
				`${cost.transactorGets} transactor gets = ${(cost.transactorGets / cost.objects).toFixed(1)}/object ` +
				`[baseline ${baseline.getsPerObject}]`
			);
		}
	});
});
