description: Our React Native check only proves the code can be bundled and compiled for the phone's JavaScript engine; it never runs it, so code that assumes something the phone lacks (like Node's Buffer) still slips through. Extend the check to actually run the bundle on that engine and do one small write and read-back.
prereq: rn-bundle-and-hermes-compile-check
files:
  - packages/rn-bundle-check/ (created by the prereq; the run step would extend its script, entry and shims)
  - packages/db-p2p/readme.md (§ React Native polyfill table — the run step would execute it literally)
  - ../sereus/packages/reference-app-rn/polyfills/hermes.js (read-only reference: working polyfill implementations)
tradeoffs: The only Hermes runtime available for Windows is a 2024 GitHub-release download that is older than the engine on phones, so this adds a network-fetched binary plus a polyfill harness to maintain, and a failure may be an artifact of the old engine rather than a real defect.
----

# What is wanted

`yarn check:rn` (from `rn-bundle-and-hermes-compile-check`) bundles the React Native entry with Metro and compiles it with legacy `hermesc`. Nothing executes, so an assumption about the runtime environment still passes. The Node-only `Buffer` global in block transfer (`complete/1-block-transfer-uses-node-only-buffer-global`) is the known instance. So is a dependency that constructs `TextDecoder` at module load, which Hermes on bare React Native lacks.

The run step would execute the compiled bundle under a Hermes runtime. The only globals would be the ones Hermes itself provides, the ones React Native's startup code installs, and the polyfills our db-p2p readme documents. Two levels:

1. **Load:** evaluate every module the entry reaches. This catches globals used at module scope.
2. **Smoke:** create a solo node (no peers, in-memory storage), append one entry to a `Diary` and read it back, then stop the node. This catches globals used on a common code path. A deliberately reintroduced `Buffer.from` on that path must make it fail.

# What planning established (spike, 2026-09-15, Windows)

**Available Hermes runtimes.** `hermes-compiler` on npm ships only the compiler. The standalone runtime (`hermes` / `hermes.exe`) comes from:
- GitHub release `facebook/hermes` v0.13.0 (August 2024, asset `hermes-cli-windows.tar.gz`, plus Linux and macOS). This is the newest runtime published for Windows.
- npm `hermes-engine-cli@0.12.0` (2022). It is older, but installs through Yarn with a lockfile pin.
- `react-native`'s own `sdks/hermesc/osx-bin` includes a `hermes` runtime on macOS only.

No Hermes V1 runtime (the engine in React Native 0.84+) is published for Windows.

**Bytecode compatibility.** Bytecode from `hermes-compiler@0.14.1` (bytecode version 96) runs on the v0.13.0 runtime. Bytecode from the newer `250829098.x` compiler (version 98) does not: "Wrong bytecode version. Expected 96 but got 98".

**Load level works.** An entry that imports a polyfill module first (the readme table applied literally, plus the React Native core globals below), then `@optimystic/db-p2p/rn` and `@optimystic/db-p2p-storage-rn`, bundled with the React Native 0.83 toolchain and compiled with `hermesc` 0.14.1, runs on Hermes CLI v0.13 and prints all 252 exports.

The polyfills it needed beyond the readme table:
- `TextDecoder`. The readme lists it as built-in for Expo SDK 52+, and the prereq ticket fixes that readme entry.
- Globals React Native's startup code normally installs: `setInterval` and `clearInterval` (Hermes CLI has `setTimeout` and `setImmediate` but not these), `queueMicrotask`, and `AbortController` / `AbortSignal` (React Native installs the `abort-controller` package).

The CLI also lacks `Intl` entirely, so the readme's `Intl.PluralRules` shim has to create `Intl` first.

**Smoke level did not come up yet.** The first failure was in the harness, not the library. The timer `.ref()`/`.unref()` wrapper from the readme table wraps the original `setInterval`, and Hermes CLI has none, so libp2p's connection monitor hit `undefined is not a function` at start. What fails after a `setInterval` shim is unknown. Also unknown: whether the CLI's event loop exits cleanly once `node.stop()` clears every timer. A lingering interval would hang the process, so the harness needs a hard timeout that counts as a failure.

**Alternatives looked at and why they are weaker:**
- **Evaluate the bundle in Node's `vm` module with a Hermes-like global set.** The load level worked. The smoke level failed on a cross-realm artifact: a host-realm `TextEncoder` returned a host-realm `Uint8Array`, and libp2p's `instanceof Uint8Array` check rejected it ("Metadata value must be a Uint8Array"). Then the run hung, because the node never stopped. More fundamentally, V8 has built-ins that legacy Hermes lacks (for example `Promise.withResolvers`), so a missing polyfill for them would be masked. Cheap, but low fidelity.
- **Use the newer compiler's "variable was not declared" warnings** as a list of free globals. On the full bundle it listed only `AbortController`, `AbortSignal`, `Event`, `EventTarget`, `CustomEvent`, `setInterval` and `clearInterval`. It did not list `TextDecoder`, even though loading the bundle fails on it. Incomplete, so not a substitute.

# Open questions for whoever picks this up

- **Binary sourcing.** Either download the v0.13.0 GitHub asset on first run (pinned URL plus SHA-256, cached under `node_modules/.cache`, network needed once), or use npm `hermes-engine-cli@0.12.0` (offline and lockfile-pinned, but two years older; confirm it accepts `hermesc` 0.14.1 bytecode or its own source compile of the bundle).
- **Placement.** The load level is well under a second, but the download and smoke run could push it out of `yarn check`. Measure before deciding.
- **Fidelity statement.** The script output should say the runtime is legacy Hermes v0.13, not the engine on a current phone.
