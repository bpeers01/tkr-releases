# skills/ — tkr Claude Code skills

Zone-scoped guidance for skills shipped via the tkr plugin.

## Skill anatomy

Each skill is a directory with one required file: `SKILL.md`. Frontmatter:

```yaml
---
name: skill-name              # must match directory name
description: One-line summary used by selector to route requests
triggers:                     # natural-language phrases + slash commands
  - /skill-name
  - "explicit phrase"
user-invocable: true          # false = leaf skill, only callable from another skill
---
```

Body is freeform Markdown — instructions Claude follows when the skill
is invoked.

## Skill description tax

The `description` is **always pinned** in every session — it's part of
the skills inventory in the system prompt. Body loads only on
invocation. Cap descriptions at **~25 tokens / ~100 chars** — high-signal,
specific enough to route accurately. Long-form context belongs in the
SKILL.md body (loaded only on invocation), not in frontmatter.

## Triggers

- Slash command (`/skill-name`) is mandatory if `user-invocable: true`
- Natural-language phrases should be specific — "audit my context" >
  "check things"
- Skills with overlapping descriptions cause selector misfires; be
  precise about scope

## Model-invocation policy

Default is model-invocable. Two forces, decided per skill:

- **Keep visible (default)** — operational skills the model should
  reach for mid-task (`search`, `explore`, `handoff`, `brevity`), AND
  side-effectful skills whose body is the guardrail: when a user asks
  in natural language ("configure tkr …"), routing into the skill's
  safe procedure beats the model freelancing the same change without
  it. This is why `config` and `compress` stay visible.
- **`disable-model-invocation: true`** — set when BOTH hold: the slash
  command is the natural entry (no NL ask should auto-route there),
  and a model self-trigger would be harmful or noisy. Current set:
  `openrouter-on/off`, `semantic-on` (network/routing flips),
  `memory-compact` (deletes memory files + busts the prefix cache
  mid-session), `consumption-report` (fixed-format manual report —
  keeps NL spend questions routing to `usage`/`consumption-audit`
  instead of three-way selector overlap), `cache-footprint`
  (maintainer diagnostic). Each flip also removes that description
  from the pinned per-session inventory (~25 tokens).

## When to author a script vs inline logic

If the skill needs to scan transcripts, walk filesystems, or compute
anything non-trivial: write a Python script in `scripts/` and call it
from the skill body. Keep LLM steps focused on judgment, scoring, and
recommendations — not data wrangling.

## Core vs advanced tiers (PUBLIC-008 / ADR-0022)

This directory holds the **core tier** — the only skills registered by
a default plugin install: `brevity`, `compress`, `config`, `continue`,
`handoff`, `search`, `status`, `usage`.

Everything else lives in `skills-advanced/` (same anatomy, NOT
auto-registered). Opt-in = copy the folder into the deployed plugin's
`skills/` dir; SKILL.md-internal `${CLAUDE_PLUGIN_ROOT}/skills/<name>/`
paths assume that runtime location, so don't rewrite them when moving a
skill between tiers. New skills default to advanced unless they earn
core placement (broad audience + recurring use).

Run `ls skills/ skills-advanced/` for the canonical lists; this
section drifts.

## Don't put here

- Hook scripts → `hooks/`
- Helper Python scripts → `scripts/`
- Skill logic that needs to run from outside Claude Code → `internal/`
  (Go) or `scripts/` (Python)
