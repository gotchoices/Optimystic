import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommitRequest } from '@optimystic/db-core';
import { openClassicLevel } from '../writer/classic-level.mjs';

/**
 * Reading side of `fixtures/<version>/<backend>.json`, which `scripts/write-fixture.mjs` writes. The
 * manifest is whatever `writer/write-scenario.mjs` recorded while a published build wrote the data,
 * plus what the generator adds about the build itself.
 */

export const FIXTURES_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'fixtures');

export interface TableRow {
	id: number;
	email: string;
	name: string;
}

export interface DiaryEntry {
	n: number;
	text: string;
}

/** Where the writer's storage lives under the data directory, per backend. */
export type StorageLayout =
	| { backend: 'fs'; blocks: string; kv: string }
	| { backend: 'leveldb'; path: string };

export interface FixtureManifest {
	networkName: string;
	/** The node's Ed25519 identity, protobuf-encoded then base64, so the restart keeps its peer id. */
	peerKey: string;
	storage: StorageLayout;
	table: {
		name: string;
		/** The statements that declared the table and its index, in order. */
		ddl: string[];
		rows: TableRow[];
	};
	diary: {
		id: string;
		/** Every committed entry, in append order. */
		entries: DiaryEntry[];
		/** One more append whose pend landed and whose commit, recorded here, was never sent. */
		inFlight: { entry: DiaryEntry; commit: CommitRequest };
	};
	/** Package name → installed version for the build that wrote the data, plus `node`. */
	writtenBy: Record<string, string>;
	writtenOn: string;
}

/**
 * One stored value: the parsed value when it is JSON that round-trips byte for byte, else its UTF-8
 * text, else base64 — see `packBytes` in the generator.
 */
type PackedBytes = { json: unknown } | { text: string } | { base64: string };

/** What the older build left in its store: files for the filesystem backend, key-value pairs for LevelDB. */
type PackedStore =
	| { files: Record<string, PackedBytes> }
	| { entries: Array<[keyHex: string, value: PackedBytes]> };

/** A fixture file's contents. */
type StoredFixture = PackedStore & { manifest: FixtureManifest };

export type Fixture = StoredFixture & {
	/** The `@optimystic/*` version that wrote it — its directory's name. */
	version: string;
};

/** Every checked-in fixture, by version directory then backend file, both in name order. */
export async function loadFixtures(): Promise<Fixture[]> {
	const fixtures: Fixture[] = [];
	for (const version of (await readdir(FIXTURES_DIR)).sort()) {
		for (const name of (await readdir(join(FIXTURES_DIR, version))).filter(file => file.endsWith('.json')).sort()) {
			const stored = JSON.parse(await readFile(join(FIXTURES_DIR, version, name), 'utf8')) as StoredFixture;
			fixtures.push({ ...stored, version });
		}
	}
	return fixtures;
}

/** Put back, under `dir`, exactly the bytes the older build left in its store. */
export async function unpackFixture(fixture: Fixture, dir: string): Promise<void> {
	if ('files' in fixture) {
		await unpackFiles(fixture.files, dir);
	} else if (fixture.manifest.storage.backend === 'leveldb') {
		await unpackEntries(fixture.entries, join(dir, fixture.manifest.storage.path));
	} else {
		throw new Error(`fixture ${fixture.version} holds key-value entries for a ${fixture.manifest.storage.backend} store`);
	}
}

async function unpackFiles(files: Record<string, PackedBytes>, dir: string): Promise<void> {
	for (const [path, packed] of Object.entries(files)) {
		const target = join(dir, ...path.split('/'));
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, unpackBytes(packed));
	}
}

async function unpackEntries(entries: Array<[string, PackedBytes]>, path: string): Promise<void> {
	const db = await openClassicLevel(path);
	try {
		const batch = db.batch();
		for (const [keyHex, packed] of entries) {
			batch.put(Buffer.from(keyHex, 'hex'), unpackBytes(packed));
		}
		await batch.write();
	} finally {
		await db.close();
	}
}

function unpackBytes(packed: PackedBytes): Uint8Array {
	if ('json' in packed) {
		return Buffer.from(JSON.stringify(packed.json), 'utf8');
	}
	return 'text' in packed ? Buffer.from(packed.text, 'utf8') : Buffer.from(packed.base64, 'base64');
}
