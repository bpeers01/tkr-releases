---
name: config
description: Configure tkr plugin settings — thresholds, tracking, dedup, and output limits.
triggers:
  - /config
  - configure tkr
  - tkr settings
---

# config

View and modify tkr configuration. Config files use TOML format, merged
field-by-field in precedence order:

1. **Managed** (org policy, highest — read-only, MDM-deployed)
2. **Project-local**: `<project-root>/.tkr/config.toml`
3. **User-global (state dir)**: `~/.tkr/config.toml` — same path on every
   OS (honors `TKR_STATE_DIR`). This is where `--global` writes.
4. **User-global (platform config dir)**: `~/.config/tkr/config.toml` on
   Linux, `~/Library/Application Support/tkr/config.toml` on macOS,
   `%APPDATA%\tkr\config.toml` on Windows. NEVER write the Unix-style
   `~/.config/tkr/` path on macOS or Windows — the binary does not read
   it there and the file is silently ignored.

Project root is discovered by walking upward from cwd until a `.tkr/` directory is found.

## Usage

```
/config                         # Show current effective config
/config <key> <value>           # Set a value in project-local config
/config --global <key> <value>  # Set a value in user-global config
/config --reset                 # Delete project-local config (restores defaults)
```

## Steps

### Show config (no args)
Run `tkr config` and display output. This shows the effective merged config.

### Set a value
1. Determine config file:
   - Default: `.tkr/config.toml` relative to the nearest project root
   - With `--global`: `~/.tkr/config.toml` (`TKR_STATE_DIR` if set) —
     platform-uniform, so it works identically on Linux/macOS/Windows
2. Read existing file, or start with empty content if it doesn't exist.
3. Set `<key> = <value>`. Use bare `true`/`false` for booleans, bare integers for ints.
4. Write the file.
5. Run `tkr config` to confirm the new effective values.

### Reset
Delete `.tkr/config.toml` if it exists. Defaults are restored automatically on next run.

## Config Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `status_max_files` | int | 20 | Max files per group in git status output |
| `status_max_untracked` | int | 10 | Max untracked files in git status output |
| `grep_max_per_file` | int | 10 | Max matches per file in grep output |
| `diff_max_hunk_lines` | int | 100 | Max lines per hunk in git diff output |
| `log_default_limit` | int | 10 | Default commit count in git log |
| `tracking_enabled` | bool | true | Record token usage to SQLite |
| `tracking_retention_days` | int | 90 | Days to keep tracking data |
| `dedup_enabled` | bool | true | Deduplicate repeated output within a session |
| `tee_on_failure` | bool | true | Save raw output when a command fails |

## Example config.toml

```toml
status_max_files = 10
grep_max_per_file = 5
log_default_limit = 20
tracking_enabled = true
dedup_enabled = false
```

## Hook advisor config (`~/.tkr/config.json`)

The UserPromptSubmit hooks read a separate JSON config at
`~/.tkr/config.json` (honors `TKR_STATE_DIR`), distinct from the TOML keys
above. The session-shape advisor (L7) lives under `advisor.shape.*` and
nudges `/tkr:handoff` + `/clear` when a session's shape makes a fresh prefix
cheaper.

| Key (`advisor.shape.*`) | Type | Default | Description |
|-------------------------|------|---------|-------------|
| `enabled` | bool | true | Master toggle for the shape advisor |
| `tool_result_kb` | int | 100 | Trigger A: KB of accumulated tool_result output before nudging |
| `min_ctx_k` | int | 50 | Trigger A: minimum last-turn context (K tokens) to nudge |
| `tail_turns` | int | 60 | Trigger B: turn-count position proxy for a "deep" session |
| `tail_ctx_k` | int | 140 | Trigger B: context-size position proxy (K tokens) |
| `tail_cap_mult` | float | 2.0 | Trigger B: per-turn cap-unit burn ≥ this × session avg fires |
| `min_turns_for_avg` | int | 20 | Trigger B: minimum turns before the session average is trusted |
| `healthy_7d_pct` | int | 30 | Suppress both triggers when 7d cap % is below this AND miss is cheap |
| `cheap_miss_cents` | int | 25 | Suppress both triggers when projected cache-miss (cents) is below this AND 7d is healthy |

Env kill switch: `TKR_SHAPE_ADVISOR_DISABLED=1` disables the detector for a
session (the `/tkr:handoff` skill stays user-invocable).

Example `~/.tkr/config.json`:

```json
{
  "advisor": {
    "shape": { "tool_result_kb": 140, "tail_cap_mult": 2.5 }
  }
}
```

## Status

**Active.** Backed by `internal/config/config.go` and the `tkr config` CLI command.
