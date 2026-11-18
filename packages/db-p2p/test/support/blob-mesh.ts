/** Helpers the blob specs share over real nodes on loopback TCP. */
import type { OptimysticNode } from '../../src/optimystic-node.js';

export async function* streamOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
	yield bytes;
}

export async function concat(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	for await (const chunk of chunks) parts.push(chunk);
	return Buffer.concat(parts);
}

export function localTcpAddr(node: OptimysticNode): string {
	const local = node.getMultiaddrs().map(a => a.toString()).find(a => a.startsWith('/ip4/127.0.0.1/tcp/') && a.includes('/p2p/'));
	if (!local) throw new Error('No loopback TCP multiaddr on node');
	return local;
}

export async function until(condition: () => Promise<boolean>, what: string, withinMs = 15_000): Promise<void> {
	const deadline = Date.now() + withinMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
		await new Promise(resolve => setTimeout(resolve, 50));
	}
}
