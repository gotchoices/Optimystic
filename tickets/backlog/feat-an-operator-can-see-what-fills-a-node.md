description: A storage node can now work out what is filling its disk — blocks, its own bookkeeping, and files broken down by why each is kept — but nothing shows that to anyone, so an operator still only ever sees one number for how full the node is.
architecture: packages/db-p2p/docs/storage.md
files: packages/reference-peer/src/cli.ts (`logRingInfo`), packages/db-p2p/src/storage/storage-account.ts (`StorageAccount.breakdown`), packages/db-p2p/docs/storage.md
tradeoffs: The report costs a walk of every stored file on the filesystem and web backends, so a node that shows it routinely pays for it; a maintainer may reasonably decide the one number is enough until someone actually asks what is filling a node.
----

# An operator can see what fills a node

## Why

`StorageAccount.breakdown()` answers what a node's bytes are: the files its blob store holds, the blocks and bookkeeping together, and the blob bytes split by the reason each blob is kept (pinned by the application, owed to a group that does not hold it yet, held because the node is responsible for it, or merely read once). Those four deserve completely different reactions from an operator, and the last is the one that can be given up for free.

Nothing calls it. The one surface a human watches, the reference peer's start-up status lines, still logs only `capacity()` — the single "38 of 50 GB" figure whose insufficiency is the reason the breakdown was built. So the capability exists and nobody can see it.

## What an operator should be able to see

A status line that names, for this node:

- how full it is (what `capacity()` already reports: the allotment, what the location will hold, the effective total, what is used, what is available),
- what the blob store's files come to,
- what the blocks and the node's own bookkeeping come to together,
- and per hold kind, how many bytes of blobs are kept for that reason — plus how many blobs of that kind the node has never learned the size of, which is a real state and must not read as zero bytes.

The report is an attribution, not a measurement: files are shared between blobs so one shared file counts under every blob that lists it, and a blob counts at its full size whether or not the node holds all of it. Whatever surface shows these figures must not present them as reconciling with the blob store's own total, and must not subtract one from the other. `packages/db-p2p/docs/storage.md` §9 states both rules.

## What has to be decided when this is built

**It must not be measured when nobody is looking.** The reference peer's status lines go through a `debug` logger, and the argument to a `debug` call is evaluated whether or not the namespace is enabled — so a naive swap of `capacity()` for `breakdown()` makes every node pay for the report on every start-up with the logging off. The report costs more than `capacity()` does: on the filesystem backend it reads the size of every stored file one at a time, and on the browser backend it reads every stored byte. Gate the measurement on whether the line will actually be printed, the way `logStorageAllotment` in `packages/db-p2p/src/libp2p-node-base.ts` already gates its own.

**It must not fail a status line.** Measuring can reject. The existing call site already catches and logs that the figures were unavailable, and the replacement has to keep doing so: a peer must still come up when its disk cannot be measured.

**Where else it belongs.** The reference peer's start-up lines are the minimum. Whether a node should also offer the figures through a surface a long-running deployment can poll — and if so, how a poller is kept from paying the file walk every time — is open, and is the part worth thinking about rather than assuming.

## Not in scope

Acting on any of it. Shedding, deleting or refusing when a node is over its allotment is `a-node-stays-within-its-allotment`.

## Arm: the pressure stage belongs in the same report

`a-node-stays-within-its-allotment` gives a node one named reading of how full it is — a stage, from one set of thresholds its operator configures, that decides whether the node is evicting, shedding, deleting or refusing (`StoragePressure` in `packages/db-p2p/src/storage/storage-pressure.ts`). An operator reading a breakdown of what fills a node wants the stage beside it: the four figures say what the bytes are, and the stage says what the node is doing about them. It costs nothing to add — the stage is the last sample, read synchronously with no measurement of its own.
