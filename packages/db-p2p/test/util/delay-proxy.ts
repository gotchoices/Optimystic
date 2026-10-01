import net from 'node:net';

/**
 * A loopback TCP proxy that forwards each chunk to `targetPort` after `oneWayMs`, in both
 * directions, so a link through it has a round trip of twice that. Accepting the socket is not
 * delayed: only bytes are.
 */
export async function listenDelayProxy(targetPort: number, oneWayMs: number): Promise<net.Server> {
	const server = net.createServer(inbound => {
		const outbound = net.connect(targetPort, '127.0.0.1');
		const forward = (from: net.Socket, to: net.Socket) => from.on('data', chunk => {
			setTimeout(() => { if (!to.destroyed) to.write(chunk); }, oneWayMs);
		});
		forward(inbound, outbound);
		forward(outbound, inbound);
		const teardown = () => { inbound.destroy(); outbound.destroy(); };
		for (const socket of [inbound, outbound]) {
			socket.on('close', teardown);
			socket.on('error', teardown);
		}
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return server;
}

/** The port a proxy from {@link listenDelayProxy} accepts on. */
export function proxyPort(proxy: net.Server): number {
	return (proxy.address() as net.AddressInfo).port;
}
