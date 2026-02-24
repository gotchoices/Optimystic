#!/usr/bin/env node
/**
 * Task Runner — processes outstanding tasks through the pipeline stages
 * by invoking an agentic CLI tool for each one.
 *
 * Version: 1.0.2
 *
 * Key design choices:
 *   - The task list is snapshotted once at startup.  Tasks created by the agent
 *     during this run are NOT picked up, ensuring each task advances exactly one
 *     stage per invocation of the runner.
 *   - The agent owns the full stage transition: it creates next-stage file(s),
 *     deletes the source task file, and commits everything.  This allows the agent
 *     to split one task into multiple next-stage tasks, adjust priorities, etc.
 *   - Agent logs are captured in tasks/.logs/ (git-ignored), one per task per stage.
 *
 * Usage:
 *   node tasks/run-tasks.mjs [options]
 *
 * Options:
 *   --min-priority <n>   Default min priority for all stages  (default: 3)
 *   --stages <list>      Comma-separated stages to process, optionally with per-stage
 *                        min priority as  stage:n  (default: fix,plan,implement,review)
 *                        Examples:
 *                          --stages fix,implement
 *                          --stages review:5,implement:3
 *                          --stages fix:4,implement,review:5  (uses --min-priority for bare names)
 *   --agent <name>       Agent adapter to use: claude | auggie | cursor  (default: claude)
 *   --dry-run            List tasks that would be processed, don't invoke agent
 *   --help               Show this help
 */

import { readdir, readFile, access, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';

/**
 * Format stream-json lines to readable text.
 * Returns { text, done? } — when done is true the agent has emitted its
 * final result and the runner should stop waiting for a clean exit.
 */
function formatClaudeJsonLine(line) {
	try {
		const obj = JSON.parse(line);
		if (obj.type === 'system' && obj.subtype === 'init') {
			return { text: `[session ${obj.session_id ?? '?'}]\n` };
		}
		if (obj.type === 'assistant') {
			const content = obj.message?.content ?? [];
			const parts = [];
			for (const block of content) {
				if (block.type === 'text' && block.text) {
					parts.push(`\n[ASSISTANT]\n${block.text}\n`);
				} else if (block.type === 'tool_use') {
					const inputStr = typeof block.input === 'object'
						? JSON.stringify(block.input).slice(0, 200)
						: String(block.input ?? '');
					parts.push(`\n[TOOL:${block.name}] ${inputStr}\n`);
				}
			}
			return { text: parts.join('') || '' };
		}
		if (obj.type === 'user') {
			const content = obj.message?.content ?? [];
			const parts = [];
			for (const block of content) {
				if (block.type === 'tool_result') {
					const text = Array.isArray(block.content)
						? block.content.map(c => c.text ?? '').join('')
						: String(block.content ?? '');
					parts.push(`  ✓ ${text.slice(0, 200)}\n`);
				} else if (block.type === 'text' && block.text) {
					parts.push(`\n[USER]\n${block.text}\n`);
				}
			}
			return { text: parts.join('') || '' };
		}
		if (obj.type === 'result') {
			const status = obj.is_error ? '✗ ERROR' : '✓ DONE';
			const cost = obj.total_cost_usd != null ? ` | cost $${obj.total_cost_usd.toFixed(4)}` : '';
			const dur = obj.duration_ms != null ? ` | ${(obj.duration_ms / 1000).toFixed(1)}s` : '';
			return {
				text: `\n[RESULT ${status}${dur}${cost}]\n${obj.result ?? ''}\n`,
				done: true,
				exitCode: obj.is_error ? 1 : 0,
			};
		}
	} catch {
		/* not JSON, pass through */
	}
	const text = line.endsWith('\n') ? line : line + '\n';
	return { text };
}

function formatCursorJsonLine(line) {
	try {
		const obj = JSON.parse(line);
		if (obj.type === 'user') {
			const t = obj.message?.content?.[0]?.text ?? '';
			return { text: `\n[USER]\n${t}\n` };
		}
		if (obj.type === 'assistant') {
			const t = obj.message?.content?.[0]?.text ?? '';
			return { text: `\n[ASSISTANT]\n${t}\n` };
		}
		if (obj.type === 'tool_call' && obj.subtype === 'started') {
			const tc = obj.tool_call ?? {};
			if (tc.shellToolCall) return { text: `\n[SHELL] ${tc.shellToolCall.args?.command ?? ''}\n` };
			if (tc.readToolCall) return { text: `\n[READ] ${tc.readToolCall.args?.path ?? ''}\n` };
			if (tc.editToolCall) return { text: `\n[EDIT] ${tc.editToolCall.args?.path ?? ''}\n` };
			if (tc.writeToolCall) return { text: `\n[WRITE] ${tc.writeToolCall.args?.path ?? ''}\n` };
			if (tc.grepToolCall) return { text: `\n[GREP] ${tc.grepToolCall.args?.pattern ?? ''} in ${tc.grepToolCall.args?.path ?? ''}\n` };
			if (tc.lsToolCall) return { text: `\n[LS] ${tc.lsToolCall.args?.path ?? ''}\n` };
			if (tc.deleteToolCall) return { text: `\n[DELETE] ${tc.deleteToolCall.args?.path ?? ''}\n` };
			return { text: `\n[TOOL] ${Object.keys(tc)[0] ?? '?'}\n` };
		}
		if (obj.type === 'tool_call' && obj.subtype === 'completed') {
			const tc = obj.tool_call ?? {};
			const ok = (r) => r?.success != null;
			if (tc.shellToolCall) return { text: ok(tc.shellToolCall.result) ? `  ✓ exit ${tc.shellToolCall.result.success?.exitCode ?? 0}\n` : `  ✗ failed\n` };
			if (tc.readToolCall) return { text: ok(tc.readToolCall.result) ? `  ✓ read ${tc.readToolCall.result.success?.totalLines ?? 0} lines\n` : `  ✗ failed\n` };
			if (tc.editToolCall || tc.writeToolCall || tc.deleteToolCall) return { text: ok(Object.values(tc)[0]?.result) ? `  ✓ done\n` : `  ✗ failed\n` };
			return { text: `  ✓ done\n` };
		}
	} catch {
		/* not JSON, pass through */
	}
	const text = line.endsWith('\n') ? line : line + '\n';
	return { text };
}

// ─── Agent adapters ────────────────────────────────────────────────────────────
// Each adapter returns { cmd, args } or { shellCmd } for spawning the agent process.
// `instructionFile` is the path to a temp file containing the full prompt.
// When shellCmd is set, it is passed as a single string to avoid DEP0190 (Windows + shell:true).

const agents = {
	claude: (instructionFile, _prompt, { stage }) => {
		const effort = (stage === 'fix' || stage === 'plan' || stage === 'review') ? 'high' : 'medium';
		return {
			cmd: 'claude',
			args: [
				'-p',
				'--dangerously-skip-permissions',
				'--verbose',
				'--no-session-persistence',
				'--output-format', 'stream-json',
				'--effort', effort,
				'--append-system-prompt-file', instructionFile,
				'Work the task as described in the appended system prompt.',
			],
			formatStream: formatClaudeJsonLine,
		};
	},

	auggie: (instructionFile, _prompt) => ({
		cmd: 'auggie',
		args: ['--print', '--instruction', instructionFile],
	}),

	cursor: (instructionFile, _prompt, { cwd }) => {
		const relPath = relative(cwd, instructionFile).replace(/\\/g, '/');
		const prompt = `Read and follow all instructions in the file: ${relPath}`;
		return {
			shellCmd: `agent --print -f --trust --output-format stream-json --workspace "${cwd}" "${prompt}"`,
			formatStream: formatCursorJsonLine,
		};
	},
};

/** Stages from which to pull tasks. */
const PENDING_STAGES = ['fix', 'review', 'implement', 'plan' ];

/** Map from stage → next stage(s) in the pipeline (for prompt context). */
const NEXT_STAGE = {
	fix: 'implement',
	plan: 'implement',
	implement: 'review',
	review: 'complete',
	test: 'complete',
};

// ─── Task discovery ────────────────────────────────────────────────────────────

const PRIORITY_PREFIX = /^(\d+)-/;
/** Parse priority number from filename like "3-some-task.md" → 3. Returns 0 if unparseable. */
function parsePriority(filename) {
	const match = basename(filename).match(PRIORITY_PREFIX);
	return match ? parseInt(match[1], 10) : 0;
}

/** Discover all .md task files in a stage folder, filtered by min priority. */
async function discoverTasks(tasksDir, stage, minPriority) {
	const stageDir = join(tasksDir, stage);
	try {
		await access(stageDir, constants.R_OK);
	} catch {
		return [];
	}

	const entries = await readdir(stageDir);
	const tasks = [];

	for (const entry of entries) {
		if (!entry.endsWith('.md') || !PRIORITY_PREFIX.test(entry)) continue;

		const priority = parsePriority(entry);
		if (priority < minPriority) continue;

		tasks.push({
			file: entry,
			path: join(stageDir, entry),
			stage,
			priority,
		});
	}

	// Sort descending by priority (highest first)
	tasks.sort((a, b) => b.priority - a.priority);
	return tasks;
}

// ─── Logging ───────────────────────────────────────────────────────────────────
// Logs are kept in tasks/.logs/<task-name>.<stage>.<timestamp>.log
// so each stage of a task's lifecycle is preserved.

/** Return the .logs dir path, ensuring it exists. */
async function ensureLogsDir(tasksDir) {
	const logsDir = join(tasksDir, '.logs');
	await mkdir(logsDir, { recursive: true });
	return logsDir;
}

/** Build a log file path for a task run. */
function logPath(logsDir, task) {
	const name = task.file.replace(/\.md$/, '');
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	return join(logsDir, `${name}.${task.stage}.${ts}.log`);
}

// ─── Agent invocation ──────────────────────────────────────────────────────────

/** Build the full prompt for a task. */
async function buildPrompt(task, tasksDir) {
	const [content, agentsMd] = await Promise.all([
		readFile(task.path, 'utf-8'),
		readFile(join(tasksDir, 'AGENTS.md'), 'utf-8'),
	]);
	return [
		`# Task: ${task.file} (stage: ${task.stage}, priority: ${task.priority})`,
		`# Next stage: ${NEXT_STAGE[task.stage]}`,
		'',
		'## Contents of `tasks/AGENTS.md`:',
		'',
		agentsMd,
		'',
		'## Contents of `' + task.path + '`:',
		'',
		content,
		'',
		'## End',
		'Work the task as described above.  Follow the project conventions in /AGENTS.md.',
		'When you are done, commit everything with a message like: "task(<stage>): <short description>"',
	].join('\n');
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes with no output → assume hung

/** Write prompt to a temp instruction file, spawn the agent, tee output to log. Returns exit code. */
async function runAgent(agentName, prompt, cwd, logFile, { stage } = {}) {
	const adapter = agents[agentName];
	if (!adapter) {
		console.error(`Unknown agent: ${agentName}. Available: ${Object.keys(agents).join(', ')}`);
		process.exit(1);
	}

	// Write prompt to a temp file so we don't hit command-line length limits
	const instructionFile = logFile.replace(/\.log$/, '.prompt.md');
	await writeFile(instructionFile, prompt, 'utf-8');

	const adapterResult = adapter(instructionFile, prompt, { cwd, stage });
	const logStream = createWriteStream(logFile, { flags: 'a' });
	const { cmd, args, shellCmd, formatStream } = adapterResult;

	const spawnArgs = shellCmd
		? [shellCmd, [], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true }]
		: [cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false }];

	try {
		return await new Promise((resolve, reject) => {
			const child = spawn(...spawnArgs);
			let idleTimer = null;
			let resultExitCode = null;  // set when stream-json emits a result event
			let settled = false;

			function settle(code) {
				if (settled) return;
				settled = true;
				clearTimeout(idleTimer);
				logStream.end(`\n[runner] Agent exited with code ${code}\n`);
				logStream.once('finish', () => resolve(code));
				logStream.once('error', () => resolve(code));
			}

			function resetIdleTimer() {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					const msg = `\n[runner] Agent idle for ${IDLE_TIMEOUT_MS / 60000}min — killing as hung.\n`;
					process.stderr.write(msg);
					logStream.write(msg);
					child.kill();
				}, IDLE_TIMEOUT_MS);
			}

			resetIdleTimer();

			function writeOut(text) {
				process.stdout.write(text);
				if (!logStream.write(text)) {
					child.stdout.pause();
					logStream.once('drain', () => child.stdout.resume());
				}
			}

			function processLine(line) {
				if (!formatStream) { writeOut(line + '\n'); return; }
				const result = formatStream(line);
				if (result.text) writeOut(result.text);
				if (result.done) {
					resultExitCode = result.exitCode ?? 0;
					// Known CLI bug: process may hang after result event.
					// Give it a short grace period then kill and resolve.
					clearTimeout(idleTimer);
					idleTimer = setTimeout(() => {
						const msg = `\n[runner] Agent sent result but didn't exit — killing stale process.\n`;
						process.stderr.write(msg);
						logStream.write(msg);
						child.kill();
					}, 30_000);
				}
			}

			let buf = '';
			child.stdout.on('data', (chunk) => {
				if (resultExitCode == null) resetIdleTimer();
				buf += chunk.toString();
				const lines = buf.split('\n');
				buf = lines.pop() ?? '';
				for (const line of lines) processLine(line);
			});

			child.stderr.on('data', (chunk) => {
				if (resultExitCode == null) resetIdleTimer();
				process.stderr.write(chunk);
				logStream.write(chunk);
			});

			child.on('error', (err) => {
				const label = shellCmd ? 'agent' : cmd;
				console.error(`Failed to spawn ${label}: ${err.message}`);
				logStream.end(`\n[runner] Agent spawn error: ${err.message}\n`);
				logStream.once('finish', () => reject(err));
				logStream.once('error', () => reject(err));
			});

			child.on('close', (code) => {
				if (buf) processLine(buf.trimEnd());
				// Prefer the exit code extracted from the result event (the
				// OS code can be bogus, e.g. 0xFFFFFFFF after kill).
				settle(resultExitCode ?? code ?? 1);
			});
		});
	} finally {
		// Clean up the temp instruction file
		await unlink(instructionFile).catch(() => {});
	}
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

function printHelp() {
	const lines = [
		'Task Runner — process outstanding tasks via agentic CLI',
		'',
		'The task list is snapshotted once at startup — tasks created by the agent',
		'during this run are NOT picked up until the next run.  This ensures each',
		'task advances exactly one stage per run.',
		'',
		'Usage: node tasks/run-tasks.mjs [options]',
		'',
		'Options:',
		'  --min-priority <n>   Default min priority for all stages  (default: 3)',
		'  --stages <list>      Comma-separated stages, optionally with per-stage min priority',
		'                       as  stage:n  (default: fix,plan,implement,review)',
		'                       e.g.  --stages review:5,implement:3,fix',
		'  --agent <name>       claude | auggie | cursor              (default: claude)',
		'  --dry-run            List tasks without invoking agent',
		'  --help               Show this help',
	];
	console.log(lines.join('\n'));
}

/**
 * Parse --stages value into an ordered array of { stage, minPriority } entries.
 * Bare stage names use the global defaultMin.
 */
function parseStages(raw, defaultMin) {
	return raw.split(',').map(token => {
		const [stage, pStr] = token.trim().split(':');
		const minPriority = pStr !== undefined ? parseInt(pStr, 10) : defaultMin;
		return { stage, minPriority };
	});
}

function parseArgs(argv) {
	const opts = {
		minPriority: 3,
		agent: 'claude',
		dryRun: false,
		stagesRaw: null,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--min-priority':
				opts.minPriority = parseInt(argv[++i], 10);
				break;
			case '--agent':
				opts.agent = argv[++i];
				break;
			case '--dry-run':
				opts.dryRun = true;
				break;
			case '--stages':
				opts.stagesRaw = argv[++i];
				break;
			case '--help':
				printHelp();
				process.exit(0);
		}
	}

	const stagesRaw = opts.stagesRaw ?? PENDING_STAGES.join(',');
	const stages = parseStages(stagesRaw, opts.minPriority);

	for (const { stage } of stages) {
		if (!PENDING_STAGES.includes(stage)) {
			console.error(`Unknown stage: "${stage}". Valid stages: ${PENDING_STAGES.join(', ')}`);
			process.exit(1);
		}
	}

	return { ...opts, stages };
}

// ─── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	// Resolve repo root (tasks/ is a direct child)
	const tasksDir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
	const repoRoot = join(tasksDir, '..');

	// Snapshot the task list once — tasks created by the agent during this run
	// are NOT picked up, ensuring each task advances exactly one stage.
	const allTasks = [];
	for (const { stage, minPriority } of opts.stages) {
		const tasks = await discoverTasks(tasksDir, stage, minPriority);
		allTasks.push(...tasks);
	}

	if (allTasks.length === 0) {
		const stageSummary = opts.stages.map(({ stage, minPriority }) => `${stage}(>=${minPriority})`).join(', ');
		console.log(`No tasks found in stages: ${stageSummary}`);
		return;
	}

	// Sort: stage order first (as given in opts.stages), then priority descending
	const stageOrder = new Map(opts.stages.map(({ stage }, i) => [stage, i]));
	allTasks.sort((a, b) => {
		const sa = stageOrder.get(a.stage) ?? 999;
		const sb = stageOrder.get(b.stage) ?? 999;
		if (sa !== sb) return sa - sb;
		return b.priority - a.priority;
	});

	if (opts.dryRun) {
		const stageSummary = opts.stages.map(({ stage, minPriority }) => `${stage}(>=${minPriority})`).join(', ');
		console.log(`\nPending tasks in: ${stageSummary}\n`);
		for (const t of allTasks) {
			console.log(`  [${t.stage.padEnd(9)}] P${t.priority}  ${t.file}`);
		}
		console.log(`\n${allTasks.length} task(s) would be processed.`);
		return;
	}

	console.log(`\nSnapshotted ${allTasks.length} task(s) to process.\n`);
	const logsDir = await ensureLogsDir(tasksDir);

	for (let i = 0; i < allTasks.length; i++) {
		const task = allTasks[i];
		const currentLog = logPath(logsDir, task);

		const banner = [
			`${'═'.repeat(72)}`,
			`  [${i + 1}/${allTasks.length}] ${task.file}`,
			`  Stage: ${task.stage} → ${NEXT_STAGE[task.stage]}  |  Priority: ${task.priority}`,
			`  Log: ${currentLog}`,
			`${'═'.repeat(72)}`,
		].join('\n');
		console.log(banner);

		// Write header to log file
		await writeFile(currentLog, [
			`Task: ${task.file}`,
			`Stage: ${task.stage} → ${NEXT_STAGE[task.stage]}`,
			`Priority: ${task.priority}`,
			`Agent: ${opts.agent}`,
			`Started: ${new Date().toISOString()}`,
			'═'.repeat(72),
			'',
		].join('\n'));

		const prompt = await buildPrompt(task, tasksDir);
		const exitCode = await runAgent(opts.agent, prompt, repoRoot, currentLog, { stage: task.stage });

		if (exitCode !== 0) {
			console.error(`\nAgent exited with code ${exitCode} on task: ${task.file}`);
			console.error(`Log: ${currentLog}`);
			console.error('Stopping to avoid cascading failures. Re-run to retry.');
			process.exit(exitCode);
		}

		console.log(`\n  [${i + 1}/${allTasks.length}] Complete: ${task.file}\n`);

		// Brief pause between tasks to let file system settle
		if (i < allTasks.length - 1) {
			await new Promise(r => setTimeout(r, 500));
		}
	}

	console.log(`\nDone — ${allTasks.length} task(s) processed.`);
}

main().catch((err) => {
	console.error('Task runner failed:', err);
	process.exit(1);
});
