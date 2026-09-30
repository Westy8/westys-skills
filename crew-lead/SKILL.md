---
name: crew-lead
description: Run a crew of coding agents from one lead session, in any repo. The lead plans, picks each agent's effort level and review plan with a scorecard, briefs and launches Claude or Codex workers in their own worktrees, watches them, relays results to the user in plain language, and relays itself to a fresh successor near the context cap. Use when the user wants one agent coordinating several others, says "be the orchestrator/lead", "spawn agents for this", "take over as orchestrator", or hands you an orchestrator handoff. Builds on Orca's `orchestration` skill for the mechanics and on `context-relay` for handoffs.
---

# Crew lead

You coordinate; you don't do the workers' jobs. You plan, brief, launch, watch, review, relay
to the user, clean up, and hand off before your own context cap.

**Load first:**
- `orca skills get orchestration`. This is the version-matched mechanics: Runs, `worker-start`,
  `check --wait`, `ask`/`reply`, gates and release. Follow its safety floor.
- The `context-relay` skill. It applies to you and to every worker.
- The project's CLAUDE.md/AGENTS.md. **Project safety rules always win**, including merge, deploy
  and restart permission.

## Start or take over

- **New:** `orca orchestration run-create --objective "<goal>"`.
- **Taking over from another lead:**
  1. Read its handoff note.
  2. Run `orca orchestration run-use --id <run_id>`. This fences the old lead out of the Run.
  3. Arm the wait loop.
  4. Don't message workers about the takeover. Workers started the Orca way report to the Run, which `run-use` already gave you. Never message an agent just to announce yourself. Each message makes it re-read its whole history, which costs money. Close only finished windows that you or an earlier lead launched; leave everything else alone.
  5. Tell the user in one line that you took over.
- **Standing approvals:** read them from the handoff or memory before asking the user anything.
  Re-asking for something already approved is the fastest way to annoy them. When the user grants
  a new standing approval, save it to memory and the next handoff right away.

## Plan, then score each task

When launching more than one agent at once, show the user a short plan first (who does what,
effort, review plan, why) and wait for "go". A single agent the user asked for can start directly.

Score every task before launching it. **You** decide effort and review; the worker doesn't.

| Question | 0 | 1 | 2 |
|---|---|---|---|
| **Difficulty:** how hard is the change? | docs, read-only lookup | normal bug fix or feature | cross-cutting design, unclear root cause |
| **Blast radius:** what breaks if it's wrong? | nothing (docs, analysis) | code behind review/tests | live/production systems, user or customer data, money, security, schema or migrations |
| **Reasoning:** how much judgment is needed? | follow clear steps | some tradeoffs | open-ended diagnosis or architecture |

**Effort** (by total score):

| Total | Effort |
|---|---|
| 0–1 | medium |
| 2–4 | high (the default for builders) |
| 5–6 | xhigh |

Any task with Blast radius 2 gets at least high. Never use low for anything that writes to live
systems or data.

**Review plan** (by Blast radius):

| Blast radius | Review |
|---|---|
| 0 | none |
| 1 | code review after building, if Difficulty ≥ 1 |
| 2 | plan review before building, and code review after |

For audit findings, an **independent verifier** greenlights each fix before a builder starts.
Reviews stop at approval. Iterate on real defects only, never on nitpick loops.
Reviewers often "fix" things by adding guards and re-checks that fail when nothing is wrong.
Every review prompt says: "No guards or re-checks that can fail on healthy input". Before a builder
applies any finding that adds a guard, re-check, readback or fail-closed check, it runs that finding
through the `nuisance-trip` skill and rejects it if the check could trip when nothing is wrong.

## Brief (always a file)

Write the brief to your scratchpad and launch with a one-line spec:
`Read your full brief: <path>`. Long text typed into a terminal loses its beginning; the Orca
message queue and files don't.

The brief contains:
- **Target, Change, Constraints, Ownership, Observable acceptance.** These are Orca's task-spec
  contract.
- **Effort and review plan** from the scorecard, with the reviewer launch command.
- **Evidence** you already have (logs, counts, file:line), so the worker doesn't redo your research.
- **Rules:** project safety rules (point to the file), no merge/deploy unless you say so, and
  git hygiene (own branch, small commits, clean tree, open a PR).
- **Context:** follow `context-relay` (hand off near 370k, hard cap 500k).
- **Progress file:** `<path>`, one line per finished step.
- **Handoff path:** `<path>`. If it exists when you start, read it first; you are a successor.
- **Reviewers** write only to the plan file or `REVIEW.md` named in their brief, never code: the
  builder applies fixes and doesn't commit `REVIEW.md` unless the project keeps review notes. They skip the progress and handoff files.
- **Reviewer launch:** paste the "Reviewer in a split pane" recipe below into the brief. The
  builder opens its own reviewer beside itself. Never write "one-shot codex exec" into a brief:
  the user wants to watch every reviewer in its own Orca pane.
- **Report:** use `ask` for questions and never a local menu; send `worker_done` with a short
  plain-language summary and `--report-path` to a full report.

## Launch

**Claude workers** (tested):

```text
orca worktree create --repo <repo> --name <short-name> --json        # own worktree per builder
orca orchestration worker-start --spec "Read your full brief: <path>" \
  --worktree id:<worktree id> --agent claude --model <model> --effort <effort> \
  --task-title "<title>" --json
```

**Codex workers and reviewers (warm-up, then inject; tested 2026-09-29):**
`worker-start --agent codex` deadlocks with Orca 1.4.215 and Codex 0.158. Codex only reports its
status after its first prompt, and Orca waits for that status before sending the prompt, so the
start times out at `agent_readiness` / `missing_status`. Retest `worker-start` after upgrading
either tool. Until then:

```text
orca terminal create --worktree id:<id> --title <t> --command '<codex command>' --json
orca terminal wait --terminal <h> --for tui-idle --timeout-ms 60000
# "Trust this folder?" on first launch in a folder: send a bare --enter
orca terminal send --terminal <h> --text "Reply ok and wait for a task." ; orca terminal send --terminal <h> --enter
orca orchestration task-create --spec "Read your full brief: <path>" --task-title "<title>" --json
orca orchestration dispatch --task <task_id> --to <h> --inject --json
```

- The worker then gets its IDs and uses `ask` and `worker_done` like any other worker.
- Orca lists this worker as "unsupervised", so `worker-stop`/`worker-release` don't apply. Close
  it with `orca terminal close` after it settles.
- Codex's footer shows `Context N% used`; rotate it per `context-relay`.
- The reviewer model comes from the user's global instructions (CLAUDE.md/AGENTS.md). Orca terminals
  already run Codex on Orca's active account.
  - If Codex says the model is "not supported", the active account's plan lacks it: switch
    accounts (`orca account list`).
**Reviewer in a split pane (every review, one round or many; tested 2026-09-29).** The builder
runs this itself. `$ORCA_TERMINAL_HANDLE` is the builder's own pane, so the reviewer opens beside
it in the builder's worktree:

```text
orca terminal split --terminal "$ORCA_TERMINAL_HANDLE" --direction vertical \
  --command 'codex --model <reviewer model> -c model_reasoning_effort=<effort> --sandbox workspace-write' --json
# reviewer handle = result.split.handle
orca terminal read --terminal <h> --limit 40
# repeat the read every few seconds until you see the "›" prompt; `wait --for tui-idle` times out on Codex
# "Trust this folder?" showing: send a bare --enter first
# write the review prompt to a file, then:
orca terminal send --terminal <h> --text "Read and follow: <prompt file>" ; orca terminal send --terminal <h> --enter
```

- The prompt names the one file it may write (the plan file or `REVIEW.md`) and asks for a final
  line of exactly `VERDICT: APPROVED` or `VERDICT: REVISE`.
- Read its answer from that file, or with `orca terminal read --terminal <h> --limit 400` (screen mode only shows about 45 lines).
- On REVISE, fix and send "Re-review: <what changed>" to the same pane, so it keeps its memory.
- On APPROVED, `orca terminal close --terminal <h>`.
- `codex exec` from a shell is only a fallback when `$ORCA_TERMINAL_HANDLE` is unset (outside
  Orca): prefix `CODEX_HOME="$ORCA_CODEX_HOME"`, add `-o <out.txt>`, and close stdin with `< /dev/null`, or it hangs.

## Watch loop (never let it lapse)

```text
orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
# after processing EVERY message in the batch:
orca orchestration check --ack <delivery_id> --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
```

- Without `--ack`, the same batch replays forever.
- A `worker_done` with outcome failed and subject `HANDOFF: context cap` is not a failure. The worker
  hit its cap mid-task: retry the same Task per `context-relay`, and don't report it as failed. If the
  brief had no handoff path, first add its `--report-path` to the brief file as the handoff path.
- Process every message, then re-arm immediately with the `--ack`. Answer questions with `reply`.
- After each wake, and after three empty waits in a row:
  - `worker-list --json`: act on `projection.attention`.
  - Read the screen of each of **your** Codex terminals and silent workers. Reading a screen is free;
    sending a message wakes the agent and costs money. Look for their own permission
    or approval menus (`❯ 1.`, `☐`, "Approve?"). Answer only with an approval the user already
    gave; otherwise ask the user.
  - Check context: Claude workers get the hook warning; Codex footers show
    `Context N% used`. Rotate only agents near the cap that still have open work, and don't interrupt
    mid-step. An idle agent near the cap is not rotated: close it when its work is settled, if your
    crew launched it.
- Don't trust a missing report. Reports can fail to arrive, so read the screen or the progress
  file.

## When a worker finishes

1. Verify its evidence: PR, tests, output. Don't just take the summary.
2. Relay to the user in plain language: what was wrong, what was done, whether it's fixed and how
   that was verified. Lead with that and skip jargon.
3. Settle the terminal: reuse it for an immediate follow-up, retain it, or `worker-release`.
   Who takes follow-up work is your call: the agent that already knows the area, or a fresh one
   if its context is cluttered or near the cap.
4. **Close its reviewers when the review is over.** Keep a reviewer open through REVISE rounds, so it
   re-checks the fixes with its memory of the earlier rounds. Close its terminal (`orca terminal close`)
   once it says APPROVED, or once the work is dropped or merged. Finished reviewers left open pile up
   and get woken by later messages.
5. Merge, deploy or restart only under the project's rules and the user's approval.
6. Clean up merged worktrees your crew created:
   - Only for worktrees with no live, reused or retained worker terminal.
   - First check `git status --porcelain` and ignored files. Confirm the branch's PR is merged
     (`gh pr view <branch> --json state,headRefOid`) and nothing was committed after it
     (`git rev-list <headRefOid>..HEAD` is empty). Commit ancestry alone misleads after squash
     merges and with bases other than `main`.
   - Then run `orca terminal close --worktree id:<id> --all` and
     `orca worktree rm --worktree id:<id> --force`.
   - Never remove a worktree with unmerged or uncommitted work that isn't yours.

## Your own relay

Follow `context-relay`. Before writing the handoff, close your finished reviewers and workers
so your successor inherits only live work. Your handoff note adds:
- the Run id;
- the live worker table (worktree name, Task and Dispatch IDs, terminal handle, state, next step).
  Terminal handles only live as long as the terminal; the IDs and worktree names persist;
- open user decisions;
- standing approvals (quoted).

Your successor starts in your worktree, runs `run-use`, re-arms the wait loop and confirms. You
stop once it confirms, and it closes your terminal.
