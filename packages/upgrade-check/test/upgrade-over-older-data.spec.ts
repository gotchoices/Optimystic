/**
 * Restarts the working tree's build over data a PUBLISHED older build wrote, and checks both
 * directions: everything the older build wrote reads back, and new writes land on top of it and
 * read back with it after a second restart.
 *
 * One `describe` per checked-in fixture (`fixtures/<version>/<backend>.json`). Its `it`s are the
 * steps of one upgrade, in order, over one data directory, so each builds on the state the previous
 * one left: run them together, not one at a time with `--grep`. What each fixture holds, and how to
 * add one when a release goes out, is in readme.md.
 */

import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '@quereus/quereus';
import { Diary, type CommitResult } from '@optimystic/db-core';
import { loadFixtures, unpackFixture, type DiaryEntry, type Fixture, type TableRow } from './fixture.js';
import { startCurrentBuild, type CurrentBuild } from './current-build.js';

/**
 * What a host is documented to do after upgrading over data a particular release wrote, because the
 * current build deliberately stopped reading something that release wrote ("Don't worry about
 * backwards compatibility yet", AGENTS.md). Each entry says where the break is documented and which
 * fixtures it applies to, then does what the documentation says — after first proving the break is
 * still there. So a build that starts reading the old format again fails the step and the entry is
 * deleted, rather than the step quietly working around a regression it was never meant to cover.
 */
interface DocumentedUpgradeStep {
	title: string;
	fixtures: readonly string[];
	run(current: CurrentBuild, fixture: Fixture): Promise<void>;
}

const DOCUMENTED_UPGRADE_STEPS: readonly DocumentedUpgradeStep[] = [{
	// quereus-plugin-optimystic README, "Format-break caveat". Builds before 1.0.0 filed each schema
	// catalog record under the bare table name; `hydrate` now reads only the framed (schema, table)
	// key (`catalogKey` in quereus-plugin-optimystic's `src/schema/table-identity.ts`). A table
	// declared with an explicit URI keeps its storage, so declaring it again reaches its rows.
	title: 're-declare each table, whose catalog record the older build filed under its bare name',
	fixtures: ['1.0.0-beta.3'],
	async run({ db }, { manifest }) {
		const message = await captureError(() => db.exec(`select count(*) from ${manifest.table.name}`));
		expect(message, 'hydrate found the table, so this step is no longer needed').to.match(/not found/);
		for (const statement of manifest.table.ddl) {
			await db.exec(statement);
		}
	},
}];

/**
 * New rows beside the old ones, and edits to rows the older build wrote: a unique value moved off an
 * old row, a declared-index value changed on another, an old row deleted, and its unique value then
 * reused — which only succeeds if the delete removed the older build's index entry.
 */
const writesOnTop = (table: string): string[] => [
	`insert into ${table} (id, email, name) values (100, 'new@example.org', 'fresh')`,
	`update ${table} set email = 'user5-moved@example.org' where id = 5`,
	`update ${table} set name = 'fresh' where id = 6`,
	`delete from ${table} where id = 4`,
	`insert into ${table} (id, email, name) values (101, 'user4@example.org', 'reused')`,
];

const NEW_DIARY_ENTRY: DiaryEntry = { n: 1_000, text: 'written by the current build' };

const fixtures = await loadFixtures();

describe('an upgrade over data an older build wrote', () => {
	it('has a fixture to run against', () => {
		expect(fixtures.map(fixture => fixture.version), 'no fixtures under fixtures/').to.not.be.empty;
	});
});

for (const fixture of fixtures) {
	describe(`restarting on the current build over what ${fixture.version} wrote to its ${fixture.manifest.storage.backend} store`, function () {
		// Two node starts per fixture; each is about a second on a developer machine.
		this.timeout(60_000);

		const { manifest } = fixture;
		const table = manifest.table.name;
		let dataDir: string;
		let current: CurrentBuild | undefined;

		before(async () => {
			dataDir = await mkdtemp(join(tmpdir(), `optimystic-upgrade-check-${fixture.version}-${fixture.manifest.storage.backend}-`));
			await unpackFixture(fixture, dataDir);
			current = await startCurrentBuild(dataDir, manifest);
		});

		after(async () => {
			await current?.stop();
			await rm(dataDir, { recursive: true, force: true });
		});

		const running = (): CurrentBuild => {
			if (!current) {
				throw new Error('the current build is not running');
			}
			return current;
		};

		for (const step of DOCUMENTED_UPGRADE_STEPS.filter(documented => documented.fixtures.includes(fixture.version))) {
			it(`takes the documented upgrade step: ${step.title}`, async () => {
				await step.run(running(), fixture);
			});
		}

		it('reads every row the older build wrote, and both indexes agree with them', async () => {
			await expectTable(running().db, table, manifest.table.rows);
			await expectIndexesAgree(running(), table);
		});

		it('finds rows through the unique index and the declared index the older build wrote', async () => {
			const { db } = running();
			expect(await selectIds(db, `select id from ${table} where email = 'moved@example.org'`)).to.deep.equal([1]);
			// The older build moved row 1 off this value; a leftover index entry would still find it.
			expect(await selectIds(db, `select id from ${table} where email = 'user1@example.org'`)).to.deep.equal([]);
			expect(await selectIds(db, `select id from ${table} where name = 'renamed'`)).to.deep.equal([2]);
			expect(await selectIds(db, `select id from ${table} where name = 'name2' order by id`))
				.to.deep.equal(manifest.table.rows.filter(row => row.name === 'name2').map(row => row.id));
		});

		it('refuses a duplicate of a unique value the older build wrote', async () => {
			const message = await captureError(() => running().db.exec(
				`insert into ${table} (id, email, name) values (1000, 'user4@example.org', 'duplicate')`));
			expect(message).to.match(/UNIQUE constraint failed/);
			await expectTable(running().db, table, manifest.table.rows);
		});

		it('reads the diary without the append that was in flight when the older build stopped', async () => {
			expect(await readDiary(running(), manifest.diary.id)).to.deep.equal(manifest.diary.entries);
		});

		it('lands the append that was in flight, pended by the older build and committed by this one', async () => {
			const { commit } = manifest.diary.inFlight;
			const pendingClaim = () => running().node.storageRepo.pendingClaimOf(commit.tailId, commit.actionId);
			expect(await pendingClaim(), 'the older build left no pending record for the in-flight append').to.not.equal(undefined);
			const result: CommitResult = await running().transactor.commit(commit);
			expect(result.success, `commit refused: ${JSON.stringify(result)}`).to.equal(true);
			expect(await pendingClaim(), 'the commit did not promote the pending record').to.equal(undefined);
			expect(await readDiary(running(), manifest.diary.id))
				.to.deep.equal([...manifest.diary.entries, manifest.diary.inFlight.entry]);
		});

		it('writes on top of the older data', async () => {
			const { db } = running();
			for (const statement of writesOnTop(table)) {
				await db.exec(statement);
			}
			await appendToDiary(running(), manifest.diary.id, NEW_DIARY_ENTRY);
			await expectTable(db, table, rowsAfterWritesOnTop(manifest.table.rows));
			await expectIndexesAgree(running(), table);
			expect(await readDiary(running(), manifest.diary.id)).to.deep.equal(diaryAfterWritesOnTop(fixture));
		});

		it('reads the older data and the new writes back after restarting again', async () => {
			await running().stop();
			current = undefined;
			current = await startCurrentBuild(dataDir, manifest);
			await expectTable(running().db, table, rowsAfterWritesOnTop(manifest.table.rows));
			await expectIndexesAgree(running(), table);
			expect(await readDiary(running(), manifest.diary.id)).to.deep.equal(diaryAfterWritesOnTop(fixture));
		});
	});
}

function rowsAfterWritesOnTop(rows: readonly TableRow[]): TableRow[] {
	const edited = rows
		.filter(row => row.id !== 4)
		.map(row => row.id === 5 ? { ...row, email: 'user5-moved@example.org' }
			: row.id === 6 ? { ...row, name: 'fresh' }
				: row);
	return [
		...edited,
		{ id: 100, email: 'new@example.org', name: 'fresh' },
		{ id: 101, email: 'user4@example.org', name: 'reused' },
	].sort((a, b) => a.id - b.id);
}

function diaryAfterWritesOnTop({ manifest }: Fixture): DiaryEntry[] {
	return [...manifest.diary.entries, manifest.diary.inFlight.entry, NEW_DIARY_ENTRY];
}

async function expectTable(db: Database, table: string, expected: readonly TableRow[]): Promise<void> {
	const rows: TableRow[] = [];
	for await (const row of db.eval(`select id, email, name from ${table} order by id`)) {
		rows.push({ id: Number(row.id), email: String(row.email), name: String(row.name) });
	}
	expect(rows).to.deep.equal(expected);
}

async function expectIndexesAgree({ db, plugin }: CurrentBuild, table: string): Promise<void> {
	const reports = await plugin.verifyIndexes(db, table);
	// The declared index on `name`, and the tree that enforces the `unique` column.
	expect(reports.map(report => report.kind).sort()).to.deep.equal(['declared', 'unique-enforcement']);
	for (const report of reports) {
		expect(report.missing, `${report.index}: rows with no index entry`).to.deep.equal([]);
		expect(report.orphaned, `${report.index}: entries no row implies`).to.deep.equal([]);
		expect(report.entryCount, `${report.index}: entries`).to.equal(report.rowCount);
	}
}

async function selectIds(db: Database, sql: string): Promise<number[]> {
	const ids: number[] = [];
	for await (const row of db.eval(sql)) {
		ids.push(Number(row.id));
	}
	return ids;
}

async function captureError(action: () => Promise<unknown>): Promise<string> {
	try {
		await action();
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
	throw new Error('expected the statement to be refused, but it succeeded');
}

async function openDiary({ transactor }: CurrentBuild, id: string): Promise<Diary<DiaryEntry>> {
	const diary = await Diary.open<DiaryEntry>(transactor, id);
	if (!diary) {
		throw new Error(`diary ${id} did not open`);
	}
	return diary;
}

async function readDiary(current: CurrentBuild, id: string): Promise<DiaryEntry[]> {
	const entries: DiaryEntry[] = [];
	for await (const entry of (await openDiary(current, id)).select()) {
		entries.push(entry);
	}
	return entries;
}

async function appendToDiary(current: CurrentBuild, id: string, entry: DiaryEntry): Promise<void> {
	await (await openDiary(current, id)).append(entry);
}
