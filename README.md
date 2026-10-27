# Westy's skills

[Claude Code](https://claude.com/claude-code) skills, plus a board mod, for running a crew of coding agents
from one lead session.

| Skill | What it does |
|---|---|
| [`crew-lead`](skills/crew-lead/) | Run a crew of coding agents from one lead session: plan, score, brief, launch, watch, review, hand off. |
| [`context-relay`](skills/context-relay/) | Hand off to a fresh successor agent before a session's context passes its token cap. Ships a hook that warns you in time. |
| [`crew-board`](skills/crew-board/) | Add-on to crew-lead: every piece of the user's work becomes a numbered task in a durable store, with decisions, results and a Tasks board the user steers from. |
| [`nuisance-trip`](skills/nuisance-trip/) | Stop adding safety checks that fail when nothing is actually wrong. |

## Install (Claude Code)

Run these in your terminal:

```sh
claude plugin marketplace add Westy8/westys-skills
claude plugin install crew@westys-skills         # the four skills, the context-relay hook, the `tasks` CLI
claude plugin install crew-board@westys-skills   # optional: the Tasks board pane for crew-board
```

Or do the same from inside Claude Code with `/plugin marketplace add Westy8/westys-skills`, then
`/plugin install crew@westys-skills` (and `crew-board@westys-skills`). Restart Claude Code afterwards.

That's all: the plugin registers its own hooks, so you don't edit `settings.json`. Skills show up as
`crew:crew-lead`, `crew:context-relay` and so on; Claude also picks them up by description.

To update later: `claude plugin marketplace update westys-skills`, then `claude plugin update crew@westys-skills`
(and `crew-board@westys-skills`), then restart.

**Installed these skills the old way?** If you copied them into `~/.claude/skills/` and added the context-relay
hook to `settings.json` by hand, remove both before installing the plugin, or every skill and hook runs twice.

### What each plugin brings

- **`crew`**: the four skills, plus
  - the context-relay hook, which reads the real token count from the transcript and tells the agent to hand off
    past ~370k tokens. Tune it with the `CONTEXT_RELAY_TOKENS` (default 370000) and `CONTEXT_RELAY_CAP`
    (default 500000) environment variables;
  - `tasks`, the crew-board task store (a single Python file over SQLite, stdlib only, at `~/.tasks/tasks.db`
    unless you set `TASKS_DB`). It is on the agent's PATH while the plugin is on;
  - the crew-board prompt hook. It stays silent until you switch crew-board on for a repo:
    `tasks enable <repo>` (the repo's folder name).
- **`crew-board`**: the Tasks board, a pane beside the lead's chat (`/board`) showing every repo's tasks, results
  and decisions. You answer decisions and message the lead from it.

### Requirements

- `python3` on your PATH (for the hook and `tasks`).
- crew-lead is built around Orca for launching and watching workers, and around Codex for reviews. The board's "Start a lead" button needs Orca too.

## Other agents (Codex, OpenCode, …)

Every skill is a plain folder with a `SKILL.md`. Copy the ones you want into your agent's skills directory:

```sh
git clone https://github.com/Westy8/westys-skills.git
cp -R westys-skills/skills/* ~/.codex/skills/    # or your agent's skills folder
```

crew-board also needs the `tasks` CLI on your PATH, e.g.
`ln -s "$PWD/westys-skills/mod/crew-board/tasks.py" ~/.local/bin/tasks`. The context-relay hook
(`skills/context-relay/scripts/context_check.py`) is Claude Code-specific.

Use one install method per agent. If you install the `crew` plugin in Claude Code, don't also copy these skills
into `~/.claude/skills/`, or you'll get every skill twice and the hooks may run twice.
