description: Nothing in this repository checks that our React Native entry point can actually be bundled and run the way a phone app does, so problems only show up when someone builds an app on a device, often days later and in someone else's project. Add an automated check that bundles the React Native entry with the same tooling a phone app uses and compiles it for the phone's JavaScript engine, so those problems fail here first.
files:
  - packages/db-p2p/package.json (the `./rn` export and the `react-native` condition, both pointing at `dist/src/rn.js`)
  - packages/db-p2p/src/rn.ts, packages/db-p2p/src/libp2p-node-rn.ts (the Node-free entry)
  - packages/db-p2p-storage-rn (the React Native storage adapter; `rn-leveldb` is a peer dependency supplied by the host app)
  - packages/db-p2p/test/entry-parity.spec.ts (today's only RN guard: first-party exports parity, and "reaches no Node builtin from the React Native entry" for first-party code only)
  - eslint.config.js (`NO_STATIC_BLOCK`, added after the RN debugging session hit a Metro failure; and the `no-restricted-globals` Buffer rule from `implement/1-block-transfer-uses-node-only-buffer-global`)
  - packages/db-p2p/readme.md (§ React Native: the polyfill and Metro alias checklist hosts are told to follow)
  - ../sereus/packages/reference-app-rn/metro.config.js and ../sereus/packages/reference-app-rn/polyfills/ (a working host configuration to model the check on; read-only reference, different repository)
difficulty: medium
----

# Why

The maintainer's goal for the next release is solid React Native support. Today every test here runs on Node. React Native differs in three ways that Node cannot show:

1. **Bundling.** Metro, with the React Native Babel preset, must be able to resolve and transform every module the entry reaches. On 2026-09-14 the RN debugging session found a class `static { }` block in `packages/db-p2p/src/storage/block-latch.ts` that Metro could not transform. It failed the whole app bundle at load. A lint rule now bans that one construct, but the class is "syntax or module shapes Metro cannot handle", and lint only knows the instances someone has already met.
2. **Engine.** Hermes has no JIT and lacks some globals Node provides: no global `Buffer`, and no native `TextDecoder` or `structuredClone` on the Hermes versions downstream users report. A dependency, first-party or third-party, that assumes one of them passes every Node test.
3. **Third-party reach.** `entry-parity.spec.ts` checks that first-party code under the RN entry imports no Node builtin. A third-party package the entry pulls in is not checked, and that is where downstream reporters have hit problems (GitHub #8 thread: a missing `path` shim once `node:path` was imported by a dependency).

Downstream users have asked what our suite exercises that a real RN app does not (GitHub #8, comments of 2026-09-11). The honest answer today is "anything specific to React Native".

# What to decide in planning

The check should be as close to a phone app's build as practical without a device or emulator, and cheap enough to run in `yarn check`, or at least in an explicit script named in `docs/releasing.md`.

- **Bundle step.** Run Metro (or its programmatic API) over a tiny entry that imports `@optimystic/db-p2p/rn` and `@optimystic/db-p2p-storage-rn`, using a Metro config that mirrors the Metro aliases our readme tells hosts to set, and no more. A module that only bundles with an extra alias not in the readme is a readme gap; report it that way. Decide whether to depend on `metro` and `@react-native/babel-preset` as devDependencies here, or reuse an existing installation; state the install cost.
- **Compile step.** Compile the bundle with the Hermes compiler (`hermesc`, published with `hermes-compiler` or react-native), so syntax Hermes rejects fails the check.
- **Run step (evaluate, do not assume).** Whether the bundle can be executed under the standalone Hermes CLI with only the readme's documented polyfills. Even a smoke run that constructs a solo node over an in-memory store, writes one block and reads it back would catch global-assumption defects like the `Buffer` one. If this needs a libp2p transport stub or is not feasible, say why and scope it out into a backlog ticket rather than dropping it silently.
- **Placement.** A root script beside `scripts/check-libp2p-majors.mjs`, wired like `lint:deps`, or a separate `test:rn` script. Pick based on measured runtime; if it is more than about a minute, keep it out of `yarn check` and add it to the release checklist instead.

# Edge cases & interactions

- **The check must fail on the known instances.** Temporarily reintroduce a `static { }` block and confirm the bundle or compile step fails. If a run step exists, temporarily reintroduce a bare `Buffer.from` on a path the smoke run reaches and confirm it fails. Revert both. A guard nobody has seen fail is not known to work.
- **Build freshness.** The check bundles `dist/` output, so it must run after `yarn build`, and it should use the same stale-build guard as the test suites (`test-harness/build-freshness.mjs`) or document why not.
- **Portal-linked siblings.** `@quereus/quereus` and `p2p-fret` resolve through `portal:` links to sibling checkouts; Metro's resolver must follow them the way a host app's would through npm. Note any difference.
- **Windows and POSIX.** Maintainers run this on Windows; invoke tools with argument arrays, not composed shell strings.
- **Not a device test.** Native `rn-leveldb`, real Hermes on a phone, and native bridge costs stay out of scope; say so in the script's output so a green check is not read as "works on a phone".

# Tests to plan for

- Bundle plus compile of the RN entry succeeds on a clean build.
- Reintroduced static block: fails, with a message naming the file.
- If a run step is in scope: solo write and read-back under Hermes succeeds; a reintroduced `Buffer` global use fails.
