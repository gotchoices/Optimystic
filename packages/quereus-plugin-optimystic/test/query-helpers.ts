import type { Database } from '@quereus/quereus';

/** Collect every row `sql` returns from a node's database, finalizing the statement. */
export async function queryAll(db: Database, sql: string): Promise<Record<string, any>[]> {
	const stmt = await db.prepare(sql);
	try {
		const rows: Record<string, any>[] = [];
		for await (const row of stmt.all()) rows.push(row);
		return rows;
	} finally {
		await stmt.finalize();
	}
}

/** Run `sql` and return its single row, or `undefined` when no row matches (not ready yet). */
export async function queryGet(db: Database, sql: string): Promise<Record<string, any> | undefined> {
	const stmt = await db.prepare(sql);
	try {
		return await stmt.get();
	} finally {
		await stmt.finalize();
	}
}
