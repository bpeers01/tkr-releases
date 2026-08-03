---
name: search
description: Hybrid search for code, docs, and project knowledge. BM25 lexical search with trust-ranked results.
triggers:
  - /search
  - search the project
  - find in codebase
---

# search

Hybrid search engine that combines BM25 lexical retrieval with a 4-tier trust model. Returns compact, deduplicated, trust-annotated results from project code, documentation, and diagrams.

## Usage

```bash
tkr search "query"                        # Search (JSON output)
tkr search "query" --human                # Human-readable output
tkr search "query" --type code            # Filter by doc type
tkr search "query" --path "docs/*"        # Filter by path
tkr search "query" --context-pack         # Multi-source context bundle
tkr search "query" --compact              # Shorter snippets, fewer results
tkr search --build-index                  # Build project index
tkr search --refresh                      # Incremental index update
tkr search --stats                        # Index statistics
```

## When to Use

- **Starting a task** — orient before exploring
- **Finding patterns** — how does this project handle X?
- **Locating related code** — tests, docs, implementations for a concept
- **Unsure which files matter** — search returns ranked, trust-annotated results

## When NOT to Use

- You already know the exact file path → use Read
- You need a specific line range → use Read with offset
- You need exact string matching → use Grep

## Cap Awareness

Native search tools have hard caps that silently truncate when hit:

| Tool | Cap | Sort | On hit |
|------|-----|------|--------|
| Glob | 100 files | mtime newest first | "(Results are truncated...)" appended |
| Grep | 250 lines (default `head_limit`) | mtime newest first | "[Showing results with pagination = limit: 250]" appended |

When you see those markers, the result is **incomplete by mtime** — files older than the cutoff are absent. `tkr search` has no such cap and ranks by trust + lexical relevance instead of mtime. Reach for it whenever exploration is broad.

## Trust Tiers

Results carry trust annotations. Follow the higher-trust source when conflicts are noted.

| Tier | Source | Trust Level |
|------|--------|-------------|
| 1 | Repo-local docs (ADRs, READMEs) | Authoritative |
| 2 | Code (with body) | Ground truth |
| 3 | Diagrams | Verified |
| 4 | Docstrings only | Descriptive |

## Status

**Implemented.** BM25 search engine ported to Go. Run `tkr search --build-index` to index your project.
