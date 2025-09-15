import { expect } from 'aegir/chai'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { startMesh } from './helpers/mesh.js'

// Simple e2e sanity check using the test-peer CLI to ensure multiple nodes can
// start, connect, and perform a distributed diary write/read cycle.

async function wait(ms: number) { return new Promise(r => setTimeout(r, ms)) }

describe.skip('FRET mesh sanity', function () {
	this.timeout(120_000)

	it('starts a 3-node mesh and performs a diary roundtrip', async () => {
		const mesh = await startMesh(3, 8211)
		try {
			// Give the mesh a brief moment to become healthy
			await wait(2000)

			// Use the first node as the actor to create a diary and add an entry
			const firstNodeInfoFile = mesh.infoFiles[0]!
			const firstNodeInfo = JSON.parse(fs.readFileSync(firstNodeInfoFile, 'utf-8')) as { multiaddrs: string[] }
			const bootstrap = firstNodeInfo.multiaddrs.join(',')

			const diaryName = 'mesh-sanity-' + Date.now()
			const entryContent = 'hello-from-mesh'

			function resolveCli(): string {
				const here = path.dirname(fileURLToPath(import.meta.url))
				let dir = here
				let repoRoot: string | null = null
				while (true) {
					const parent = path.dirname(dir)
					if (parent === dir) break
					if (path.basename(dir) === 'packages') { repoRoot = path.dirname(dir); break }
					dir = parent
				}
				const root = repoRoot ?? path.resolve(process.cwd(), '..', '..', '..')
				return path.join(root, 'packages', 'test-peer', 'dist', 'cli.js')
			}

			async function runPeer(args: string[]): Promise<{ code: number, output: string }>{
				const cli = resolveCli()
				return await new Promise(resolve => {
					const child = spawn('node', [cli, 'run', '--bootstrap', bootstrap, '--action', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
					let out = ''
					child.stdout.on('data', d => { out += String(d) })
					child.stderr.on('data', d => { out += String(d) })
					child.on('close', (code) => resolve({ code: code ?? 0, output: out }))
				})
			}

			// Create the diary
			{
				const res = await runPeer(['create-diary', '--diary', diaryName])
				expect(res.code).to.equal(0, res.output)
			}

			// Add an entry
			{
				const res = await runPeer(['add-entry', '--diary', diaryName, '--content', entryContent])
				expect(res.code).to.equal(0, res.output)
			}

			// Read diary (output is informational; success if command exits 0)
			{
				const res = await runPeer(['read-diary', '--diary', diaryName])
				expect(res.code).to.equal(0, res.output)
				// Basic sanity: output contains the content we wrote
				expect(res.output).to.contain(entryContent)
			}
		} finally {
			await mesh.stop()
		}
	})
})

