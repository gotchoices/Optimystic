import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
function resolveTestPeerCli() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let dir = here;
    let repoRoot = null;
    while (true) {
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        if (path.basename(dir) === 'packages') {
            repoRoot = path.dirname(dir);
            break;
        }
        dir = parent;
    }
    const root = repoRoot ?? path.resolve(process.cwd(), '..', '..', '..');
    return path.join(root, 'packages', 'test-peer', 'dist', 'cli.js');
}
function startNode(params) {
    const cli = resolveTestPeerCli();
    const args = [
        cli,
        'service',
        '--port', String(params.port),
        '--network', 'optimystic-test',
        ...(params.bootstrap ? ['--bootstrap', params.bootstrap] : []),
        '--storage', 'memory',
        '--announce-file', params.announceFile
    ];
    return spawn('node', args, { stdio: 'pipe' });
}
async function waitForFile(file, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (fs.existsSync(file))
            return;
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for ${file}`);
}
async function readNodeInfo(file) {
    const text = await fs.promises.readFile(file, 'utf-8');
    return JSON.parse(text);
}
export async function startMesh(n, basePort = 8111) {
    const workDir = path.join(process.cwd(), '.mesh-tests');
    fs.mkdirSync(workDir, { recursive: true });
    const files = Array.from({ length: n }, (_, i) => path.join(workDir, `node-${i + 1}.json`));
    const children = [];
    const info = [];
    // First node (no bootstrap)
    const port1 = basePort;
    const file1 = files[0];
    children.push(startNode({ port: port1, announceFile: file1 }));
    await waitForFile(file1, 20000);
    const info1 = await readNodeInfo(file1);
    info.push(info1);
    const bootstrap = info1.multiaddrs.join(',');
    // Remaining nodes
    for (let i = 1; i < n; i++) {
        const port = basePort + i;
        const file = files[i];
        children.push(startNode({ port, bootstrap, announceFile: file }));
        await waitForFile(file, 20000);
        info.push(await readNodeInfo(file));
    }
    async function stop() {
        await Promise.all(children.map(c => new Promise(resolve => {
            try {
                c.on('close', () => resolve());
                c.kill('SIGINT');
            }
            catch {
                resolve();
            }
        })));
    }
    return { children, infoFiles: files, info, stop };
}
//# sourceMappingURL=mesh.js.map