---
name: context-relay
description: Hand off to a fresh successor agent before this agent's context passes the 500k-token cap. Use when a context-relay hook warning appears, when context is near ~370k tokens, when a session feels long and cluttered, or when an orchestrator asks an agent to rotate. Covers the handoff note, starting the successor in the same place, the takeover confirmation, and orchestrators relaying themselves. Works for Claude Code and Codex agents, with or without Orca.
---

# Context relay

No agent works past **500k tokens** of context. Around **370k** it finishes what it is doing,
writes a handoff, starts a fresh successor that takes its exact spot, and stops.
Orchestrators follow the same rule for themselves.

**Relay only if work remains.** An agent that is idle or finished does not relay, even past
370k, even when a message wakes it. It answers briefly, says it is done, and stays idle; its lead
decides who takes any new work. Relaying an idle agent just burns money on a copy with
nothing to do.

## When

- **Claude Code:** the `context_check.py` hook (in this skill's `scripts/`) warns you past 370k with
  the real token count. Without the hook, the count is the last `usage` entry in your transcript
  (`input + cache_creation_input + cache_read_input + output` tokens).
  Status-line percentages are often rescaled for the auto-compact buffer, so don't use them as the
  token count.
- **Smaller context windows:** lower `CONTEXT_RELAY_TOKENS` / `CONTEXT_RELAY_CAP` (env) for models
  whose window is under ~600k. Otherwise auto-compact fires before the relay does.
- **Codex:** the footer shows `Context N% used`. Your orchestrator watches it; relay when asked,
  or when you judge you are near the same size.
- **Relay early** if new work arrives, your context is cluttered with a finished task, and you
  judge a fresh agent would do it better.

## Order of operations

1. **Finish the user's current request first.** Answer the question you were asked and finish the
   step you're in. Never leave a half-written reply or a half-applied change behind.
2. **Write the handoff note** (template below). Put it where the project keeps handoffs (check
   CLAUDE.md/AGENTS.md). If it has none, use a `docs/handoff/` file on your own branch, or the
   scratchpad path your orchestrator gave you. Commit it if it lives in the repo.
3. **Start the successor** in the same worktree with the same agent, model and effort you were
   launched with.
   - With Orca, open it in a vertical split beside you, in the same worktree:
     `orca terminal split --terminal "$ORCA_TERMINAL_HANDLE" --direction vertical --command '<your launch command>' --json`.
     Capture the successor's handle (`result.split.handle`) and
     pass `--terminal <handle>` to every `wait`/`send`/`read`. Without it they target the
     *active* terminal, which may be you. Then run
     `orca terminal wait --terminal <handle> --for tui-idle`.
   - Put its first prompt in a file and send one line:
     `Read your takeover prompt: <path>`. Send `--text` without `--enter`, then a bare `--enter`,
     because long text sent through a terminal gets its start cut off.
   - The takeover prompt **starts with**: "Load the `context-relay` skill (plus `crew-lead` if you are
     a lead, and any repo skill named in the handoff)." Then it says who you are replacing, which
     handoff to read, who to report to, and "confirm takeover".
4. **Wait for the takeover confirmation.** The successor tells the orchestrator (or the user if
   there is no orchestrator) "I've taken over from <old handle>". Check its screen once to be sure
   it started.
5. **Stop.** Tell your orchestrator or the user in one line, then go idle. Whoever launched you
   closes your terminal. For a lead with no one above it, the successor does (see below).

### Supervised Orca workers (you have a Task/Dispatch preamble)

Your lifecycle IDs can't pass to another terminal, so don't start the successor yourself.
- Write the handoff to the **handoff path named in your brief** (none named: put it next to your
  progress file, or in your scratchpad). Then send
  `worker_done --outcome failed`, subject `HANDOFF: context cap`, with `--report-path <that path>`.
- The coordinator retries the **same** Task, so dependents stay attached, with the same placement and
  launch options:
  `worker-start --task <task_id> --retry-of <dispatch_id> --worktree id:<same worktree> --agent <same> --model <same> --effort <same>`,
  plus `--on <environment>` if the original ran on a remote Orca server. For Codex workers, use
  crew-lead's warm-up then `dispatch --task <task_id> --to <handle> --inject` instead, because
  `worker-start` deadlocks for Codex.
  The brief tells every worker to read the handoff path first if it exists.

### Orchestrators relaying themselves

Same steps, plus:
- The successor runs `orca orchestration run-use --id <run_id>`, which makes it the coordinator
  of the same Run with all its tasks and messages.
- Once the predecessor has said it stopped, the successor closes the predecessor's terminal
  (`orca terminal close --terminal <old handle>`).
- It re-arms the waiting loop immediately. A lapse once left an agent waiting 12 hours.
- It tells the user in one line that it took over. Don't message workers about the takeover. Workers started the Orca way report to the Run, which `run-use` already gave you. Never message an agent just to announce yourself. Each message makes it re-read its whole history, which costs money. Close only finished windows that you or an earlier lead launched; leave everything else alone.

## Handoff note template

Keep it short. **Link, don't copy.** Plans, PRs, commits, diffs and issues get a path or URL,
not a paste. **Redact** secrets, keys, passwords and personal data; the note becomes the next
agent's prompt.

```markdown
# Handoff: <role/task> — <date> (from <handle>, at ~<N>k tokens)
Read first: <project CLAUDE.md/AGENTS.md>, <earlier handoffs still in force>
## Goal
## State: done (with evidence: PR/commit/test output) / in progress / not started
## Running agents or processes (worktree name, Orca Task/Dispatch IDs if any, terminal handle, what it's doing, what it waits on)
## Standing approvals and rules from the user (quote + date; the successor must not re-ask)
## Open decisions waiting on the user
## Next steps (numbered, concrete)
## Suggested skills (which skills the successor should load)
## Gotchas learned this session
```

## Progress file

If your brief names a progress file, append one line per finished step
(`<time> <step> <result/evidence>`). The orchestrator reads it without scraping your screen, and
it is the first draft of your handoff. Never commit it.
