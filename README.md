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
