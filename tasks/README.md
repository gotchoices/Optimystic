# Task Runner

Processes outstanding tasks through the pipeline by invoking an agentic CLI, one stage at a time.

## Key Design Choices

**Snapshot, not re-scan** — The task list is captured once at startup. Tasks the agent creates during the run (next-stage files) are not picked up until the next invocation. This guarantees each task advances exactly one stage per run.

**Agent owns the transition** — The agent is responsible for the full stage transition:
1. Create next-stage file(s) in the appropriate `tasks/` subfolder
2. Delete the original source task file
3. Commit everything

This means the agent can split one plan into multiple implement tasks, adjust priorities, or restructure as needed. The runner just picks the next task and invokes the agent.

**Commit per task** — The agent is instructed to commit when done (e.g. `task(plan): short description`). This gives the human a clean commit history to review between runs.

**Human reviews between runs** — The script is non-interactive. Run it with `--max` or `--once` to process a batch, review the commits, then run again.

## Usage

```bash
# Dry run — see what would be processed at priority >= 3
node tasks/run-tasks.mjs --dry-run

# Process all tasks priority >= 4 (default agent: claude)
node tasks/run-tasks.mjs --min-priority 4

# Process just one task
node tasks/run-tasks.mjs --once

# Only review + test stages, priority >= 3
node tasks/run-tasks.mjs --stages review,test

# Process at most 5 tasks
node tasks/run-tasks.mjs --max 5

# Use a different agent CLI
node tasks/run-tasks.mjs --agent auggie
```

## Logs

Agent output is captured in `tasks/.logs/` (git-ignored). Each run produces a log file named:

```
<task-name>.<stage>.<timestamp>.log
```

For example, `4-camera-improvements.plan.2026-02-15T14-30-00-000Z.log`. Logs accumulate across stages, so you can trace a task's full history:

```
4-camera-improvements.plan.2026-02-15T14-30-00-000Z.log
4-camera-improvements.implement.2026-02-16T09-00-00-000Z.log
4-camera-improvements.review.2026-02-17T11-00-00-000Z.log
```

## Agent Adapters

The `agents` object at the top of `run-tasks.mjs` maps agent names to `{ cmd, args }` spawn configs. Each adapter receives the path to a temp instruction file containing the full prompt. To add a new CLI, add an entry and use `--agent <name>`:

- **claude** - Claude Code CLI (default)
- **auggie** - Augment Code
- **cursor** - Cursor CLI
