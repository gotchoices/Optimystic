/**
 * Child-process half of `test/module-load-globals.spec.ts`. That spec runs this file as its own Node
 * process (with this package's `register.mjs`); nothing imports it, and it is not a `.spec.ts` so
 * mocha's glob never loads it. It has to be a fresh process: the question is what a module does
 * while it *loads*, and inside mocha every module was already loaded by some other spec.
 *
 * It wraps the two globals Hermes (React Native's engine) lacks — `TextDecoder` and
 * `structuredClone` — so that every use is recorded along with the source file that made it, while
 * still delegating to Node's real implementation. Then it loads the React Native entry and, once
 * loaded, exercises the storage codec. It prints one line, `RESULT_PREFIX` + JSON, on stdout.
 *
 * Wrap-and-record rather than delete the globals: third-party dependencies (multiformats, cborg)
 * construct `TextDecoder` at their own module load, so with the global deleted the import throws in
 * THEIR code before any first-party module is reached, and the run could say nothing about ours.
 */

import { fileURLToPath } from 'node:url';

const RESULT_PREFIX = 'module-load-globals-probe:';

type Phase = 'load' | 'calibrate' | 'use';
type GlobalUse = { global: 'TextDecoder' | 'structuredClone'; phase: Phase; file: string };

const uses: GlobalUse[] = [];
let phase: Phase = 'load';

/** The file that called `skip` — the first stack frame above it. A frame with no file URL (a Node
 *  internal) comes back as its raw text, which the spec never classifies as first-party. */
function callerFile(skip: Function): string {
	const holder: { stack?: string } = {};
	Error.captureStackTrace(holder, skip);
	const frame = holder.stack?.split('\n')[1]?.trim() ?? '';
	const url = /(file:\/\/\/.+?):\d+:\d+\)?$/.exec(frame)?.[1];
	return url !== undefined ? fileURLToPath(url) : frame;
}

const NativeTextDecoder = globalThis.TextDecoder;
class RecordingTextDecoder extends NativeTextDecoder {
	constructor(...args: ConstructorParameters<typeof TextDecoder>) {
		super(...args);
		uses.push({ global: 'TextDecoder', phase, file: callerFile(RecordingTextDecoder) });
	}
}
globalThis.TextDecoder = RecordingTextDecoder;

const nativeStructuredClone = globalThis.structuredClone;
function recordingStructuredClone<T>(value: T, options?: Parameters<typeof structuredClone>[1]): T {
	uses.push({ global: 'structuredClone', phase, file: callerFile(recordingStructuredClone) });
	return nativeStructuredClone(value, options);
}
globalThis.structuredClone = recordingStructuredClone;

// Everything the React Native entry evaluates while loading.
await import('../../src/rn.js');

// Proves the wrappers see a use and attribute it to the file that made it: the spec expects exactly
// these two, attributed to this file. Without it, a wrapper that silently stopped recording would
// make every "no first-party use" assertion pass vacuously.
phase = 'calibrate';
new TextDecoder();
structuredClone({});

// The codec builds its decoder lazily: expect one construction across repeated calls, not one per call.
phase = 'use';
const codec = await import('../../src/storage/raw-store-codec.js');
const encoded = codec.encodeJson({ n: 1, list: ['a', 'b'] });
const decoded = [codec.decodeJson(encoded), codec.decodeJson(encoded), codec.decodeJson(encoded)];
const actionId = codec.decodeActionId(codec.encodeActionId('probe-action' as Parameters<typeof codec.encodeActionId>[0]));

process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({ uses, decoded, actionId })}\n`, () => process.exit(0));
