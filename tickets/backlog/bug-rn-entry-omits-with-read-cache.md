RESOLVED — the one-line export was added directly (`packages/db-p2p/src/rn.ts`, next to the other
storage re-exports). The wider class it exposed — nothing keeps the two entries in step, and 19
modules currently differ, `cluster/commit-proof` among them — is tracked as
`plan/entry-points-drift-without-a-guard`. Kept here only until the next tending pass files it to
complete/.

----
description: The React-Native/browser entry point of db-p2p is missing an export that this repo's own Quereus plugin imports from it, so anything built against that entry fails to link. It breaks the downstream build outright and would ship broken if released as-is.
prereq:
files:
  - packages/db-p2p/src/rn.ts (the entry missing the export)
  - packages/db-p2p/src/index.ts (line 25 — the Node entry, which has it)
  - packages/db-p2p/src/storage/with-read-cache.ts (the module)
  - packages/quereus-plugin-optimystic (its /rn build is the importer)
difficulty: low
severity: build-break
likelihood: certain
repro: verified downstream
----

# `db-p2p`'s `/rn` entry does not export `withReadCache`, and the plugin's `/rn` build imports it

## What happens

Building `sereus` against this repo at `74de6509` fails outright:

```
X [ERROR] No matching export in "../../optimystic/packages/db-p2p/dist/src/rn.js" for import "withReadCache"

    ../../optimystic/packages/quereus-plugin-optimystic/dist/chunk-GGDD2DHJ.js:4:27:
      4 │ import { createLibp2pNode, withReadCache, MemoryRawStorage, Storage...
```

## It is a real gap, not a stale `dist`

- `packages/db-p2p/src/index.ts:25` — `export * from "./storage/with-read-cache.js";`
- `packages/db-p2p/src/rn.ts` — **no such line**, and `grep -c with-read-cache` on it returns `0`.

So the export is absent from the `/rn` **source**. Rebuilding cannot produce it. The Node entry has
it; the platform-neutral one does not, and the two entries are supposed to re-export the same
storage modules — the downstream `cached-storage.ts` comment states that assumption explicitly
("Both db-p2p entrypoints re-export the same storage modules, so class identity is unaffected on
Node"), and relies on it for `instanceof` checks.

`withReadCache` arrived with the read-cache work (`libp2p-node-base.ts:20, 383`), and the `/rn`
entry was not updated alongside `index.ts`.

## Why it matters for the release

**This ships broken.** The `/rn` entry is the one non-Node consumers use — React Native and browser
— and it is exactly what the downstream repo imports for its browser path
(`composeStrand` / `connectToStrandBrowser` / `wrapStorageWithCache` all import from
`@optimystic/db-p2p/rn`, deliberately, to avoid pulling Node-only transports). A published version
with this gap fails to build for every such consumer, which is the whole audience that entry exists
for.

Downstream is currently **red at `yarn build`** because of it — not a test failure, a link failure,
so nothing downstream can be measured against this HEAD until it is fixed.

## The fix

Add the missing re-export to `packages/db-p2p/src/rn.ts`:

```ts
export * from './storage/with-read-cache.js';
```

Worth also asking the wider question while it is open: **nothing enforces that the two entries stay
in step.** This one drifted silently and was caught only by a downstream build. A gate comparing the
export sets of `index.ts` and `rn.ts` — allowing a declared, documented list of Node-only exclusions
— would turn the next drift into a failure here rather than in a consumer's build. (That is the
shape the downstream repo uses for its own duplicated-schema copies, which are held identical by a
drift spec.)
