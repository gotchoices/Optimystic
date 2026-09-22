# upgrade-check

Starts the working tree's build over data that a **published, older** build wrote, and checks that it reads all of it and can write on top of it. Every other suite in this repository writes its data with the same build that reads it, so a change to what is stored, or to how a stored record is read, can pass all of them and still break the first machine that restarts after updating. This suite is the one place that does not.

It is private and never published.

## What runs

`yarn test` — from this directory, or the root `yarn test` and therefore `yarn check` — runs `test/upgrade-over-older-data.spec.ts` once for every fixture under `fixtures/`. It needs no network: a fixture is the data itself, checked in. Each run takes a few seconds. For each fixture it:

1. writes the older build's stored bytes back into a temporary directory;
2. starts one node from the working tree's build over them — the same identity, `clusterSize: 1`, the same storage backend — with a Quereus database over the node;
3. takes any documented upgrade step that applies to that version (below);
4. reads back every row of the table, looks rows up through the unique column and the declared index, and runs the plugin's `verifyIndexes` over both index trees;
5. checks that a duplicate of a unique value the older build wrote is still refused;
6. reads the diary, then commits the append that was in flight when the older build stopped — its pending record written by the older build, its commit by this one;
7. writes on top: new rows, edits and a delete of old rows, reuse of the deleted row's unique value, another diary append;
8. stops, starts again, and reads everything back.

Steps run in order over one data directory, each building on the last, so run the file whole rather than one `it` at a time.

## What a fixture holds

`fixtures/<version>/<backend>.json` is what `writer/write-scenario.mjs` left behind when it ran against the published `<version>` packages, plus the manifest it recorded of what a reader must find.

| What the writer does | Why |
| --- | --- |
| a table with a `unique` column and a declared index, created with an explicit collection URI | the schema catalog, the table's B-tree, and both kinds of index tree |
| 80 rows in one statement | more than one B-tree leaf holds (`NodeCapacity` in `packages/db-core/src/btree/btree.ts`), so the tree has a branch node |
| an update of each indexed column, then a delete | index entries the older build moved and removed |
| a diary of 35 entries | more than one chain block holds (`EntriesPerBlock` in `packages/db-core/src/chain/chain.ts`), so its log spans two blocks |
| one more append whose pend landed and whose commit was never sent | a pending record with whatever the older build kept beside it; the commit request is in the manifest |
| all of it on a solo node with a persistent key-value store | the commit proofs a solo node signs, and the under-replication ledger (1.0.0 and later; earlier builds have no `kvStore` option) |

There is one fixture per storage backend a deployment runs on:

- **`fs`** — `FileRawStorage` and `FileKVStore` from `@optimystic/db-p2p-storage-fs`, what `reference-peer` runs on. Packed as `files`, keyed by path.
- **`leveldb`** — `LevelDBRawStorage` and `LevelDBKVStore` from `@optimystic/db-p2p-storage-rn` over one LevelDB database, what a React Native app runs on. Written through `classic-level` (`writer/classic-level.mjs`, the binding that package's own suite uses) rather than `rn-leveldb`: the keys and values come from the package, not from the binding. Packed as `entries`, in key order, each key in hex.

Each stored value is packed as parsed JSON when that gives back exactly its bytes, else as UTF-8 text, else base64, and is unpacked to those same bytes.

The manifest's `writtenBy` lists the installed version of every package that did the writing. The generator refuses an install in which any `@optimystic/*` package is anything but the named version, because our packages depend on each other by caret range and a plain install of an older one pulls in newer siblings.

## The fixtures checked in

- **`1.0.0-beta.3`** — the last build before pending records kept the revision they claim and the base they were computed against (`pendingRevs` and `pendingBases` in `packages/db-p2p/src/storage/struct.ts`), and before the schema catalog was keyed by schema and table. Its in-flight commit is the only test that commits a pending record with no stored base, which `StorageRepo.internalCommit` then checks against the commit's own declared base.
- **`1.2.0`** — the release this workspace was added after.

## Adding a fixture when a release goes out

After the release is published:

```bash
yarn workspace @optimystic/upgrade-check write-fixture <version>
```

It needs the network: it installs the published `@optimystic/*@<version>` packages into a scratch directory with npm (outside this workspace, so they resolve as a consumer's install would), runs the writer there once per backend, and packs what each run left into `fixtures/<version>/`. Commit that directory.

It will not overwrite a version that already has fixtures. A fixture is what that release wrote, and regenerating it runs the same published packages again, so `--force` is only for when the scenario itself changes — and then every version should be regenerated, so all fixtures describe the same scenario. The writer must keep to API the oldest fixture version has; its header says which that is.

## When a change stops reading something an older release wrote

That is allowed here ("Don't worry about backwards compatibility yet", AGENTS.md), but it must be a decision, not an accident this suite reports. Either:

- **document the step a host takes after upgrading**, and add it to `DOCUMENTED_UPGRADE_STEPS` in the spec, naming the fixture versions it applies to. A step first proves the old format really is still unread, so a later build that reads it again fails the step and the entry is deleted, instead of the step quietly working around a regression. The one entry today re-declares each table, per the "Format-break caveat" in the Quereus plugin's readme; or
- **retire the fixture** — delete that version's directory in the same change that documents why its data is no longer supported, so the decision is visible in one diff.

## What this does not cover

- **Two builds running at once**, as a network is partway through an upgrade. Nothing here runs an older build live; that is backlog `debt-no-scenario-runs-two-builds-in-one-cohort`.
- **The SQLite and IndexedDB backends** (`@optimystic/db-p2p-storage-ns`, `@optimystic/db-p2p-storage-web`). Their values come from the same shared encoding as the two here (`KvRawStorage` in `packages/db-p2p/src/storage/kv-raw-storage.ts`), so a change in *what* is stored is covered for them too; a change in how either lays out its own tables or object stores is not.
- **A cohort of more than one machine.** The data is a solo node's. A member of a larger cohort stores the same kinds of record, but multi-signer commit proofs and a ledger that owes copies to real peers only appear there.
- **What a node keeps only in memory**, such as a writer's retained attempt at the write that was in flight. The in-flight commit is delivered from the manifest, as a remote writer's commit would arrive at a storage node that restarted; a writer in the same process as the node loses it on restart.
- **An older build of one package running against a newer build of another in one process** — what the caret ranges above allow a host's install to produce. See the note under "Version alignment" in [docs/releasing.md](../../docs/releasing.md#version-alignment).
