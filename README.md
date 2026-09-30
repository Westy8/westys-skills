# Westy's skills

A few [Claude Code](https://claude.com/claude-code) / agent skills I use to run coding agents.

Each folder is a self-contained skill (a `SKILL.md`, plus scripts where needed). Drop a folder
into your `~/.claude/skills/` (or your agent's skills directory) to use it.

| Skill | What it does |
|---|---|
| [`crew-lead`](crew-lead/) | Run a crew of coding agents from one lead session — plan, score, brief, launch, watch, review, hand off. |
| [`context-relay`](context-relay/) | Hand off to a fresh successor agent before a session's context passes its token cap. Includes a Claude Code hook script. |
| [`nuisance-trip`](nuisance-trip/) | Stop adding safety checks that fail when nothing is actually wrong. |

## Install

```sh
git clone https://github.com/Westy8/westys-skills.git
cp -R westys-skills/crew-lead westys-skills/context-relay westys-skills/nuisance-trip ~/.claude/skills/
```

## Enabling the context-relay hook

The `context-relay` skill ships a Claude Code hook, `context-relay/scripts/context_check.py`.
The skill text alone won't fire it — a script does nothing until it's registered as a hook.
It reads the real token count from the transcript and nudges you to hand off past ~370k tokens.

Add it to your `~/.claude/settings.json` under `hooks`, on both `UserPromptSubmit` and
`PostToolUse` (so the count is checked as work happens):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [
        { "type": "command",
          "command": "python3 \"$HOME/.claude/skills/context-relay/scripts/context_check.py\"",
          "timeout": 10 }
      ] }
    ],
    "PostToolUse": [
      { "hooks": [
        { "type": "command",
          "command": "python3 \"$HOME/.claude/skills/context-relay/scripts/context_check.py\"",
          "timeout": 10 }
      ] }
    ]
  }
}
```

If you already have hooks for those events, add this command as another entry in the existing
array rather than replacing it. Tune the thresholds with the `CONTEXT_RELAY_TOKENS` (default
370000) and `CONTEXT_RELAY_CAP` (default 500000) environment variables. Restart Claude Code
after editing settings.
