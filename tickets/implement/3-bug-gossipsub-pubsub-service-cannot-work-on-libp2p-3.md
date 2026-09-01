description: Every node this project builds registers a message-broadcast service that is provably dead — it was written for an older version of the networking library and fails on the first outbound message. Nothing here uses it, but we ship it in the default set, so anyone reaching for it gets silence. Remove it.
files:
  - packages/db-p2p/src/libp2p-node-base.ts:8 (the `gossipsub` import), :580 (`pubsub: gossipsub({...})`)
  - packages/db-p2p/test/node-service-set.spec.ts:39 (doc bullet), :56 (`'pubsub'` in the expected key set)
  - packages/db-p2p/package.json:51 (`"gossipsub"` keyword), :73 (`@chainsafe/libp2p-gossipsub`)
  - packages/quereus-plugin-optimystic/package.json:53 (same dependency, unused there)
  - packages/db-p2p/test/foreign-peer-interop.integration.spec.ts:71 (comment listing `/meshsub/…`)
  - packages/db-p2p/docs/repo.md:237 (same list, in prose)
difficulty: easy
repro: verified
----

# Remove the dead `pubsub` (gossipsub) service from the default node service set

Decision taken at the fix stage: **option 1 from the source ticket — remove it.** The service is not
merely suspect, it is verified non-functional on this repo's own installed dependency tree, and
nothing in this repository publishes or subscribes. The evidence that settles it is below; an
implementer inclined to deviate should read *If you want to keep the key instead* first.

## Verified at HEAD (2026-08-31)

Two reproductions were run against `packages/db-p2p/node_modules` as installed.

**End to end.** Two real TCP libp2p nodes, both with `gossipsub` as their only pubsub service, both
subscribed to the same topic, connected to each other, given 3 seconds to settle:

```
connections a->b: 1
a outbound gossipsub streams: 0
a peers known to gossipsub: 1
b subscribers seen by a for topic: 0
publish recipients: 0
messages received by b: 0
```

The peers see each other. Gossipsub knows about the peer. It never opens an outbound stream, so it
never sends its subscription list, so neither side ever learns the other is subscribed, so `publish`
reaches nobody — and reports zero recipients rather than raising.

**The mechanism, isolated.** Constructing gossipsub's `OutboundStream` directly on a real libp2p 3
stream reproduces the reported stack exactly:

```
stream has .sink: false  .source: false  asyncIterable: true
OutboundStream THREW: TypeError: fns.shift(...) is not a function
    at rawPipe (.../it-pipe/dist/src/index.js:37:26)
    at pipe  (.../it-pipe/dist/src/index.js:32:12)
    at new OutboundStream (.../@chainsafe/libp2p-gossipsub/dist/src/stream.js:20:9)
```

Both probe scripts were temporary and have been deleted; the working tree is clean.

## Why it fails

`it-pipe` decides what a pipeline stage is by **structure**, not by type:

```js
const isDuplex = (obj) => obj != null && obj.sink != null && obj.source != null
```

- Under libp2p 2, `Stream extends Duplex<...>` — it has `.sink` and `.source`, so `it-pipe`
  recognises the last stage and substitutes `stage.sink`, which is a function.
- Under libp2p 3, `Stream extends MessageStream`, which is a `TypedEventTarget` plus
  `AsyncIterable`. No `.sink`, no `.source`.

`it-pipe` only falls back to the iterable check for the **first** stage. For the last stage it
checks `isDuplex` and nothing else, so the raw stream object survives into `rawPipe`, which does
`fns.shift()(res)` on it — hence `fns.shift(...) is not a function`.

The throw is synchronous out of the `OutboundStream` constructor, before `.catch(errCallback)` can
attach. Gossipsub catches it one level up and only logs:

```js
catch (e) { this.log.error('createOutboundStream error', e) }
```

So `streamsOutbound` stays empty, `sendSubscriptions` never runs, and the service reports as running
while delivering nothing.

The *inbound* half incidentally still lines up structurally — `pipe(this.rawStream, decode)` puts
the stream first, where the `AsyncIterable` fallback does apply — but that is academic: without the
outbound handshake no peer is ever grafted into the mesh, so there is nothing to receive.

## Why the package manager does not catch it

`@chainsafe/libp2p-gossipsub` declares `@libp2p/interface: ^2.0.0` as a **regular dependency**
rather than a peer dependency. So the resolver installs a nested v2 copy beside the host's v3 and
reports no conflict. The v2 subtree in this repo hangs entirely off gossipsub — confirmed by
`yarn why` on each member:

| package | version | sole parent chain |
| --- | --- | --- |
| `@libp2p/pubsub` | 10.1.18 | gossipsub |
| `@libp2p/interface-internal` | 2.3.19 | gossipsub, `@libp2p/pubsub` |
| `@libp2p/peer-collections` | 6.0.35 | `@libp2p/interface-internal@2`, `@libp2p/pubsub` |
| `@libp2p/utils` | 6.7.2 | `@libp2p/peer-collections@6` |
| `@libp2p/logger` | 5.2.0 | `@libp2p/utils@6` |
| `@libp2p/peer-id` | 5.1.9 | gossipsub, `@libp2p/peer-collections@6`, `@libp2p/pubsub` |
| `@libp2p/interface` | **2.11.0** | all of the above |

Removing gossipsub removes that whole subtree.

## There is nothing to upgrade to

`npm view @chainsafe/libp2p-gossipsub versions` ends at **`14.1.2`** — the version already
installed. No 15.x exists. Fixing gossipsub itself is upstream work in ChainSafe's repository and
would need a release before it helps anyone here, so it is out of scope.

## Nothing here uses it

`grep -rn "pubsub" packages/*/src` returns exactly one production hit: the registration itself.
`grep -rn "services\.pubsub"` across the monorepo returns nothing. Cohort-topic gossip, push-state
gossip and every other broadcast path in Optimystic use their own protocols registered through
`node.handle`, not pubsub. `@chainsafe/libp2p-gossipsub` is also a dependency of
`quereus-plugin-optimystic`, which never imports it.

This is why the failure is invisible to the suite: `node-service-set.spec.ts` asserts that `pubsub`
is *present* in the service map, and it is. That spec says as much about itself — "This one only
proves the map is intact."

## What the removal is NOT

Do **not** assume this lets you drop the narrow cast on the `services` field at
`libp2p-node-base.ts:544`. Its `NOTE:` invites removal "if that dedups", and it is tempting to read
this ticket as that moment. It is not. Enumerating every `@libp2p/interface` copy under
`packages/db-p2p/node_modules` shows the cast is caused by a **3.x-against-3.x minor split**, not by
gossipsub's v2:

```
3.1.0   packages/db-p2p/node_modules/@libp2p/interface          <- what db-p2p pins (^3.1.0)
3.2.3   .../@libp2p/crypto/node_modules/@libp2p/interface       <- the cast's actual cause
3.2.3   .../@libp2p/autonat/node_modules/@libp2p/interface
3.2.3   .../@libp2p/dcutr/node_modules/@libp2p/interface
2.11.0  .../@chainsafe/libp2p-gossipsub/node_modules/@libp2p/interface   <- goes away here
3.0.2   .../@chainsafe/libp2p-gossipsub/node_modules/@libp2p/crypto/...  <- goes away here
2.11.0  .../@libp2p/pubsub/node_modules/@libp2p/interface                <- goes away here
3.0.2   .../@libp2p/pubsub/node_modules/@libp2p/crypto/...              <- goes away here
```

Leave the cast and its `NOTE:` exactly as they are. Closing the minor split is tracked separately as
`debt-libp2p-interface-version-drift-guard`.

## If you want to keep the key instead

The source ticket offered two alternatives. Both are worse here, and neither should be adopted
without a human saying so:

- **Keep it and make the failure loud** — a service that throws at startup on a stack we already
  know it cannot work on is a registration we control. Deleting the registration is the same
  information, delivered earlier, with less code.
- **Make it opt-in, off by default** — this preserves the key for a consumer who has verified their
  own stack, but no such stack exists: the incompatibility is gossipsub 14 against libp2p 3, and
  this package requires `libp2p: ^3.1.3`. The option would preserve a switch that can only ever be
  turned on into a broken state.

If a human overrides this and picks opt-in anyway, the spec change below becomes "assert `pubsub` is
absent by default and present when the new option is set" — still a deliberate change to the
literal, never a deleted assertion.

## Consumer impact

`@optimystic/db-p2p` is published. A downstream consumer reading `node.services.pubsub` today gets
an object that silently drops every message; after this change they get `undefined`, which is at
least diagnosable. That is a breaking change to the published service map and must be stated in the
release notes. `docs/releasing.md` generates notes from commit history
(`gh release create v{version} --generate-notes`), so the change has to be visible in the commit
message. The implementer does not commit here, so **say this explicitly in the review handoff**, and
whoever commits should carry a `BREAKING CHANGE:` note naming the removed `services.pubsub` key.

## TODO

- [ ] Remove the `gossipsub` import at `libp2p-node-base.ts:8` and the `pubsub: gossipsub({...})`
      entry at `:580`. Leave the surrounding `dcutr`/`autoNAT` comment block intact — it documents
      those two services, not this one.
- [ ] Leave the `services:` cast at `:544` and its `NOTE:` untouched (see *What the removal is NOT*).
- [ ] Add a short `NOTE:` where the entry was, so the next person does not re-add it: gossipsub 14
      is the newest published version and cannot work on libp2p 3 (`Stream` lost `.sink`/`.source`,
      so `it-pipe` no longer recognises it as a duplex); re-add only against a gossipsub release
      built for libp2p 3. Reference issue #9.
- [ ] `node-service-set.spec.ts`: drop `'pubsub'` from `EXPECTED_SERVICE_KEYS` (`:56`) and the
      `- pubsub — gossipsub.` bullet from the header comment (`:39`). Change the literal
      deliberately — do not delete or weaken the assertion, and do not derive the list from the code
      under test. Add one line to the header comment recording that pubsub was removed and why.
- [ ] Drop `@chainsafe/libp2p-gossipsub` from `packages/db-p2p/package.json` (`:73`) and
      `packages/quereus-plugin-optimystic/package.json` (`:53`); drop the now-false `"gossipsub"`
      keyword from `packages/db-p2p/package.json` (`:51`).
- [ ] Refresh `yarn.lock` (`yarn install`) and confirm with `yarn why @libp2p/interface` that no
      2.x copy remains. The 3.2.3-against-3.1.0 minor split will still be there — expected, and out
      of scope.
- [ ] Correct the two stale prose references to the advertised protocol list, both of which name
      `/meshsub/…` as something an Optimystic node advertises:
      `packages/db-p2p/test/foreign-peer-interop.integration.spec.ts:71` and
      `packages/db-p2p/docs/repo.md:237`.
- [ ] Run `yarn lint`, `yarn build`, `yarn typecheck`, `yarn test` (`node-service-set.spec.ts` is
      the spec that must move), then `yarn test:integration` for the real-socket suites. Run each in
      the foreground with no output redirection.
- [ ] In the review handoff, state the breaking change in the terms above so the commit carries it
      into the generated release notes.
- [ ] **Human action — do not do this from an agent:** reply on GitHub issue #9
      (gotchoices/Optimystic, reporter `aarashrestha`) with the decision, confirmation that the
      mechanism they diagnosed is exactly right, and the note that gossipsub 14.1.2 is the newest
      published version so there is nothing to upgrade to. Flag it in the handoff as outstanding.
