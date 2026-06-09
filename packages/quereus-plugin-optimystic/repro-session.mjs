import { Database } from '@quereus/quereus';
import { TransactionCoordinator } from '@optimystic/db-core';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import register from './dist/plugin.js';
import { QuereusEngine } from './dist/index.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const dir = path.join(os.tmpdir(), 'optimystic-repro', randomUUID());
await fs.mkdir(dir, { recursive: true });

function localOptions() {
  return {
    collectionUri: 'tree://unused',
    transactor: 'test',
    keyNetwork: 'test',
    libp2pOptions: {},
    cache: false,
    encoding: 'json',
  };
}

async function step(label, fn) {
  const t = setTimeout(() => {
    console.error(`>>> HUNG at: ${label}`);
    process.exit(7);
  }, 5000);
  try {
    const r = await fn();
    clearTimeout(t);
    console.error(`ok: ${label}`);
    return r;
  } catch (e) {
    clearTimeout(t);
    console.error(`THREW at ${label}: ${e?.message ?? e}`);
    throw e;
  }
}

const db = new Database();
const plugin = register(db, {
  default_transactor: 'test',
  default_key_network: 'test',
  enable_cache: false,
});
for (const v of plugin.vtables) db.registerModule(v.name, v.module, v.auxData);
for (const f of plugin.functions) db.registerFunction(f.schema);

await step('create table', () => db.exec(`create table Seq (id integer primary key, v text) using optimystic('tree://session/seq')`));

const transactor = await plugin.collectionFactory.getOrCreateTransactor(localOptions());
const origPend = transactor.pend.bind(transactor);
transactor.pend = async (req) => { const r = await origPend(req); console.error('    PEND rev=', req.rev, 'success=', r.success, 'reason=', r.reason, 'blockIds=', (r.blockIds||[]).length, 'inserts=', Object.keys(req.transforms?.inserts||{}).length, 'updates=', Object.keys(req.transforms?.updates||{}).length); return r; };
const origCommitT = transactor.commit.bind(transactor);
transactor.commit = async (req) => { const r = await origCommitT(req); console.error('    COMMIT tailId=', req.tailId, 'rev=', req.rev, 'blockIds=', (req.blockIds||[]).length, 'success=', r.success, 'reason=', r.reason); return r; };
const coordinator = new TransactionCoordinator(transactor, plugin.txnBridge.getCollectionRegistry());
const engine = new QuereusEngine(db, coordinator);

const origApply = coordinator.applyActions.bind(coordinator);
coordinator.applyActions = async (a, s) => { console.error('  > applyActions n=', a.length, 'stamp=', s); const r = await origApply(a, s); console.error('  < applyActions done'); return r; };
const origCommit = coordinator.commit.bind(coordinator);
coordinator.commit = async (tx) => { console.error('  > coordinator.commit'); const r = await origCommit(tx); console.error('  < coordinator.commit done'); return r; };
const origRollback = coordinator.rollback.bind(coordinator);
coordinator.rollback = async (s) => { console.error('  > coordinator.rollback', s); const r = await origRollback(s); console.error('  < coordinator.rollback done'); return r; };

// Pre-warm the schema-hash cache OUTSIDE any statement so the provider does not
// trigger a re-entrant db.eval during beginTransaction (which deadlocks).
const warmed = await engine.getSchemaHash();
console.error('warmed schema hash =', warmed);
plugin.txnBridge.configureTransactionMode(coordinator, engine, async () => { console.error('  > schemaHashProvider'); const h = await engine.getSchemaHash(); console.error('  < schemaHashProvider', h); return h; });
console.error('session mode enabled; registry size =', plugin.txnBridge.getCollectionRegistry().size);

await step('insert id=1', () => db.exec(`insert into Seq (id, v) values (1, 'one')`));
await step('select count', async () => {
  for await (const row of db.eval('select count(*) as c from Seq')) console.error('count =', row.c);
});

console.error('DONE');
db.close();
process.exit(0);
