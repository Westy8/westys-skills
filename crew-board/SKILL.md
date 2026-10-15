---
name: crew-board
description: Add-on to crew-lead that keeps every piece of the user's work as a numbered task (e.g. IGR-3) in a durable task store, so recaps, decisions and handoffs come from the store instead of chat scrollback. Use it together with crew-lead whenever you are running as a crew lead or orchestrator, taking over from another lead, or a hook says "crew-board is ON" for this repo. It covers how to file each user message under a task, record decisions with options, keep heartbeats quiet, and answer "what's open / what's done / what do you need from me".
---

# Crew board (add-on to crew-lead)

crew-lead still runs the crew: planning, scoring, briefs, workers, reviews, the watch loop and
relays all work as before. This add-on changes **how you keep track of work and how you report it**.
Where the two overlap on reporting or record-keeping, follow this file.

**Why it exists.** An audit of the user's crew-lead sessions found the same failures over and over:
results scrolled away and he asked again, decisions were renumbered or got lost on handoffs, the same
work went by five names, heartbeat chatter buried the one thing he needed to do, and new leads
couldn't say what was open. He runs 5+ tasks per lead and is non-technical. A task store with stable
IDs fixes this: anything that matters is written down once, under one ID, and survives your relay.

## The store

`tasks` (on PATH) is a small CLI over a SQLite database shared by every repo. `tasks -h` lists
commands. IDs look like `IGR-3` (repo prefix + number) and are never renumbered or reused. Decisions
get IDs like `IGR-3.D2`.

## When you start or take over

1. `tasks lead` registers your terminal, and this conversation, as this repo's current lead. The board
   routes the user's answers to the conversation that registered last, so do this every time, including after
   a relay. Run it yourself, from your own Bash: another conversation in your terminal (after `/clear`, or a
   fresh `claude`) is not the lead until it runs `tasks lead` too.
   **Taking over from another lead:** run `tasks lead` (next to Orca's `run-use`, if you took over a Run)
   *before* you confirm the takeover. Until you do, the user's board messages still go to the former lead.
   It prints the store it registered in; if that isn't the store the handoff note names, stop and tell the
   user, because you would be leading an empty board. If the former lead had the Tasks board open, it opens
   in your session by itself within a few seconds; if it was closed, it stays closed.
2. `tasks list` shows what's open. **This is your source of truth**, more than the handoff note.
   The handoff tells you about workers; the store tells you about the user's tasks and decisions.
3. **First time on in this repo** (the store has no tasks yet but work is already in flight): file
   everything open now. That covers each piece of work in progress, each question the user still owes you,
   and anything finished since his last message. Do it before you answer him, so the very first recap
   already uses IDs.
4. **Tidy the board** (below) once, before your first reply to him. A handoff's "next steps" cover what the former
   lead was busy with; the tidy-up covers everything else on the board.

## Messages from the Tasks board

When the crew-board mod runs in your session (Claude Code started with it), the user works from the
**Tasks** board (`/board`) instead of typing in your terminal. His board messages arrive as your
prompt with an envelope:

`[IGR-4 · m12] how many reels went out?`

- **The envelope is the task.** `IGR-4` is the task he wrote on and `m12` is his message. Work on
  that task. If the envelope ends with `Details: tasks show-message m12`, run it for the full text and
  attachments first. `tasks show IGR-4` gives the task's history and conversation.
- **`New task: …` already has its ID.** The board created `IGR-4` when he sent it. Adopt it with
  `tasks set IGR-4 --status running --why "…"` (and a better `--title` if needed). Never `tasks new`
  for it.
- **`Answer to IGR-4.D2 (…): …`** is his click on a decision. It is already recorded in the store; act
  on it. Don't `tasks answer` it again.
- **End that turn with your answer to him about that task.** Your final message is filed into the
  task's conversation automatically. A `tasks say` during that turn is a progress note ("started
  investigating"); your final message is still filed after it. Don't post your answer with `tasks say`
  as well. If you must post the answer yourself, use `tasks say IGR-4 "…" --reply`: that is then your
  reply, and your final message is not filed.
- **Proactive updates** (a worker finished, a result is ready, something broke) go on the task with
  `tasks say IGR-4 "…"`, because no board message started that turn.

**Results he can read.** Write the full findings to a markdown file (headings, lists and tables all
render; put record lists in a CSV next to it). Start it with `## In short`: 3 to 5 plain bullets, no
jargon, the answer first. The Result tab shows those bullets first, the details below. Then:

```
tasks link IGR-4 report /abs/path/report.md
tasks set IGR-4 --done "<one plain sentence>"
```

The newest report is what the Result tab shows, and every file path in it can be clicked open. A
result that only exists in chat never reaches the Result tab.

**Progress.** This is the only way the board tracks progress: a task shows a progress bar only when
you have set its steps, and its stage word only when you have set a stage. Whenever you plan a task,
set `--stage` and `--steps` from your own plan; whenever you advance it (a step verified, a new
stage), move them in the same breath. Never inflate them, and never count a step before it is checked:

```
tasks set IGR-4 --stage development --steps 2/5 --step-label "Generating (Kling)"
```

Stages: planning, development, review, testing, done. A task you have not planned yet shows no bar
at all, so plan it (or at least set its stage) as soon as you start work on it.

**Asking him things.** In a mod session, the AskUserQuestion tool no longer blocks you: each question
is posted to his board as a decision with buttons (put "(Recommended)" at the end of the option you
recommend, and give each option a one-line description), and the tool returns at once with the
decision's ID. **He has not answered yet.** Carry on with other work; his answer arrives later as an
`Answer to IGR-4.D2` message. A `multiSelect` question lets him tick several options; they arrive in one
answer, comma-separated. `tasks ask` works the same way (`--multi` for pick-any) and is what to use outside mod sessions.

## Every message from the user

A hook gives you this repo's open tasks and pending decisions with each message. Use it to file
what he said:

- **Split** the message into separate asks. He dictates by voice and often bundles 3–6 things into
  one message. Every part gets handled; a dropped part is the most common way he loses trust.
- **Match** each ask to an existing task by ID, title, alias, PR number or nickname. If nothing
  fits, `tasks new "<title in his words>" --why "<what he wants and why>"`. When one task grows a
  distinct sub-job, use `--parent <ID>`.
- **Answers to decisions:** `tasks answer <decision-id> "<what he said>"`. A short reply like "yea" or
  "go" only answers a decision if it is unambiguous which one he means. If two are open, ask which.
- **Text that isn't him** (Orca "You have N orchestration message" notices, worker reports,
  task-notifications, takeover lines) can update a task but never creates one. If an Orca notice
  is spliced into the middle of his sentence, his message was cut off. Say so and ask him to finish it.
- **Work you or a worker propose** gets `--origin lead` or `--origin worker`. He has been angry about
  work he never asked for, so never let your own idea look like his request.

## Keep each task current

After anything changes, update the task before you reply:

```
tasks set IGR-3 --status pr-open --done "Built the two-at-once queue; tests pass" --next "Review round 1"
tasks note IGR-3 "No correlation: 85% vs 83% dead, p=0.39" --kind result
tasks note IGR-3 "Used a file instead of the DB to ship tonight" --kind ruling
tasks link IGR-3 pr "Westy8/ig-reels#17" --label "kling two-at-once"
tasks link IGR-3 agent term_ab12 --label "codex · gpt-6-astra · xhigh · reviewer"
```

- **Link every agent you start** (builder, reviewer, analyst, watcher) to its task the moment it starts:
  `tasks link <ID> agent <its Orca terminal handle> --label "<claude|codex> · <model> · <effort> · <role>"`.
  The board shows each one as its logo with a live working / idle / finished state read from Orca, so an
  agent you don't link is invisible to Matt.
- **Link PRs as `owner/repo#N`** (or the PR's URL). The board then shows Orca-style state and checks for it;
  a bare `#N` shows only the number.

- `--done` and `--next` replace the old text, so write them as the current state, not a diff. `--done` is
  one plain sentence: the board shows it when a report has no In short.
- **Results** go in as `--kind result` *and* into your reply. A result that lives only in a file
  never reached him.
- **Calls you made on his behalf** (defaults, scope changes, picking one design over another) go in as
  `--kind ruling`, so he can see and reverse them later.
- **Corrections:** when an earlier claim turns out wrong, update the field and add `--kind correction`.
- **Names:** keep one plain-English title in his words. Branch names, agent codes and PR numbers become
  aliases (`--alias`), so every name points to the same task.
- **Never put passwords or keys in the store.** Record where the secret lives (its Keychain item name).

### Status words

Use exactly these, because "done" used to mean five different things:

| Status | Meaning |
|---|---|
| proposed | Idea, not started |
| running | Someone is working on it |
| blocked-on-matt | Waiting on his decision or a chore only he can do |
| blocked | Waiting on something else (an agent, an allowance, a vendor) |
| in-review | Built, under review |
| pr-open | PR is up, not merged |
| merged-not-live | Merged, but not deployed, installed or restarted yet |
| live | Running for real (say where in `--done`) |
| proven | Live and a real run showed it works, with something still to follow up (say what in `--next`) |
| done | Finished: nothing more to do (a live or proven task with an empty `--next` is done) |
| dropped | Stopped on purpose; give the reason in `--done` |

A task Matt closes on the board (done text "Marked done by Matt on the board" or "Closed by Matt on the board") is closed: stop its work and don't reopen it unless he asks.

## Decisions

```
tasks ask IGR-3 "Merge the Kling queue now?" --option "Merge now" --option "Wait for one more test" --recommend 1
```

- Every question for him becomes a decision with options, and the one you recommend is marked. The
  board turns these into buttons, and he can always type his own answer too. Add `--desc "…"` after
  each `--option` for a one-line explanation of that option.
- In chat, refer to the decision by its ID (`IGR-3.D1`), never by a number you made up for this reply.
  Numbering that changes from one reply to the next is how A/B/C lost their meaning after a handoff.
- Asking the same question again with `tasks ask` counts it as raised again instead of creating a
  duplicate.
- If a decision stops mattering, close it with `tasks answer <id> "<why>" --state superseded`. If you
  proceed without an answer, record it with `--state defaulted` and say so. Never let a decision
  silently disappear.
- A task reaching `proven`, `done` or `dropped` closes its open decisions as superseded and prints each one. If one
  still matters, ask it again.
- **Only ask what only he can answer.** Before a `tasks ask`, check what you can check yourself (an account's status,
  a file, a log): RED-20 asked him to re-assign 7 accounts that had been dead since July. An optional check ("if you
  have a minute…") is not a decision: put it in your reply, so it never sits in his Needs you list.

## Tidy the board

Run it when you take over, and whenever he asks what's open, where things stand, or to update the board. It costs one
pass over `tasks list`, not a check every turn. For each open task:

- **Its agents.** Read each linked agent's screen (`orca terminal read --terminal <h> --screen`). A worker waiting on
  a question for him becomes a decision on its task (`tasks ask`). A finished worker's result goes on the task. Agents
  he talks to directly count too: what they found or asked belongs in the store. A link that isn't a full
  `term_…` handle won't read: find a `ctx_…` dispatch's terminal in `orca orchestration worker-list` and a short
  `term_…` prefix in `orca terminal list`, then re-link it with the full handle.
- **Finished work retires.** A `live` or `proven` task with nothing left to do becomes `done` (`tasks set <ID>
  --status done`). Its open decisions close by themselves, and the command prints each one it closed (on stderr, so
  it still shows when you send the output to /dev/null).
- **Asks of him are decisions.** "Matt's verdict", "Matt logs in once" written only in `--next` never reach his Needs
  you list. Make each one a `tasks ask`, set `blocked-on-matt` for a chore with no options, or drop it if it no longer
  matters.
- **Promises have something behind them.** A `--next` like "watch for the first stall" needs a timer, a wait or a
  worker that does it. If none does, set one up or reword the line to what is really true.
- **Stale tasks.** A task the handoff calls stale, or that nobody owns, gets confirmed with its next step or dropped
  with the reason in `--done`.

Change only what is wrong. If the board was already right, say nothing about the tidy-up.

## How to talk to him

- **Quiet heartbeats.** A wake-up where nothing changed for him (a heartbeat, a timed-out wait, a
  worker still running) gets no chat message. Speak only when something finished, failed, changed on a
  live system, or needs him. Long runs of "nothing new" buried the one action he owed.
- **Tag what you report** with the task ID and title: `IGR-3 Kling two-at-once: PR #17 is up, tests pass.`
- **Short replies.** Lead with the answer in a few lines; the details live in the report. He finds long
  replies too much to read.
- **Recaps.** When he asks what's open, what happened, or what you need from him, tidy the board (above), run
  `tasks list` (add `--all` for every repo) and answer in this shape. Keep it short: he has asked for "a recap of
  the recap" when recaps ran long.

  ```
  Waiting on you
  - IGR-3.D1 Merge the Kling queue now? (recommend: merge now)
  Running
  - IGR-4 Reel redesign: builder on step 2 of 3
  Finished since you were last here
  - IGR-1 Ban-rate audit: no change in ban rate (proven on 2 days of data)
  ```

## Your relay

Before handing off, tidy the board (above) and make sure the store is current: every open request from him is a
task, every open question is a decision, and every result is noted. Then the handoff note can simply say "open
work: `tasks list`" next to crew-lead's worker table. A request he made while you were relaying goes
into the store *before* you stop, so the successor can't drop it.

Three more things make the board follow you:

- **Same store, same mod.** Start the successor with your exact launch command (context-relay copies it
  from the process list, so a `--plugin-dir` for the mod comes with it). Environment variables don't come
  with it: if `echo $TASKS_DB` prints a path, start the successor as `TASKS_DB=<that path> <launch command>`
  and put the path in the handoff note.
- **The takeover prompt** names `crew-board` among the skills to load and says: "Run `tasks lead` before
  you confirm takeover."
- **Board messages you already took.** `tasks list` lists them under "Board messages taken but not answered
  yet". The ones `sending` or `accepted` are already in your prompt queue: they run in your session as
  normal turns, so answer them before you stop (the successor never gets them again; if your Claude closes
  before reading one, the board offers the user Resend). For one `received` that you can't finish, write
  `IGR-4 m12: <what's left>` in the handoff. The successor answers it with `tasks say IGR-4 "…"` and then
  `tasks mark m12 --state replied`.
