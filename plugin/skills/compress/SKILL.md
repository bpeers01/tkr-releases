---
name: compress
description: Compress persistent markdown files (CLAUDE.md, memory, docs) to reduce input tokens.
triggers:
  - /compress
  - compress this file
  - reduce input tokens
---

# compress

Rewrites prose-heavy markdown files into compressed form to reduce input tokens on session start. Creates a `.original.md` backup before overwriting.

## Invocation

```
/compress <file-path>
/compress CLAUDE.md
/compress docs/runbook.md
```

If invoked without a file path, ask: "Which file should I compress?"

## Steps

1. **Read** the file at the provided path.
2. **Backup** — write contents to `<file>.original.md` in the same directory. If the backup already exists, skip (do not overwrite previous backup).
3. **Compress** — rewrite all prose sections using the rules below. Leave front matter, code blocks, tables, and headings structurally unchanged.
4. **Verify** — before writing, check every protected span from the original (each item under "Preserve exactly") appears byte-identical in the compressed draft. Restore any span that was dropped or altered; never write a draft that fails this check.
5. **Write** compressed content back to the original path.
6. **Report** — show original vs. compressed character count and estimated token savings.

## Compression Rules

**Drop from prose:**
- Articles: a, an, the (when removable without ambiguity)
- Filler: just, really, basically, actually, simply, very, quite, rather
- Pleasantries: sure, certainly, of course, great, awesome
- Hedging: it might be, it could be, potentially, arguably, perhaps
- Redundant phrasing: "in order to" → "to", "due to the fact that" → "because", "at this point in time" → "now"

**Preserve exactly:**
- Code blocks (` ```...``` `) and inline code (`` `...` ``)
- URLs and file paths
- Commands and CLI examples
- Technical terms, library names, error messages, symbol names
- Dates and version numbers
- YAML/TOML/JSON front matter
- Headings and document structure
- Table structure and content
- Bullet hierarchy and nesting

## Examples

| Original | Compressed |
|----------|------------|
| "In order to run the test suite, you should execute..." | "To run tests, execute..." |
| "This is basically just a wrapper that simply calls..." | "Wrapper that calls..." |
| "The configuration file can potentially be found at..." | "Config file at..." |
| "I've updated the authentication middleware to handle..." | "Updated auth middleware to handle..." |

## Status

**Active.** Claude executes compression directly — no CLI binary required. Pure skill, no backing Go command.
