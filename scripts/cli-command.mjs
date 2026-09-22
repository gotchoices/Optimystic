/**
 * Running a package-manager CLI (`yarn`, `npm`) from a repository script, on every platform.
 *
 * Shared by `scripts/libp2p-majors.mjs` and `scripts/published-visibility.mjs`. Nothing here runs
 * anything: it builds the executable-plus-arguments pair that `execFile` / `execFileSync` take.
 */
import { env, platform } from 'node:process';

/** An npm package name, optionally scoped. */
export const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

/**
 * `cli` with `args`, as an executable plus an argument array.
 *
 * On Windows `yarn` and `npm` are `.cmd` shims, which Node refuses to spawn directly (since the fix
 * for CVE-2024-27980), and `shell: true` with an argument array is deprecated because it joins the
 * arguments unescaped. Running the shim through `cmd.exe` is the route Node's documentation gives for
 * batch files. That is safe only for arguments carrying no character cmd.exe interprets, so every
 * caller validates what it passes — package names against `PACKAGE_NAME_RE`, versions against a
 * strict version pattern — before building a command.
 *
 * @param {string} cli
 * @param {string[]} args
 * @param {string} [os]  `process.platform`, injectable for tests.
 * @returns {{ file: string, args: string[] }}
 */
export function cliCommand(cli, args, os = platform) {
	return os === 'win32'
		? { file: env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', cli, ...args] }
		: { file: cli, args };
}
