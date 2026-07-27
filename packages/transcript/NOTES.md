# packages/transcript — NOTES (S2b)

Copy-only watchers for provider session dirs (TRN-001). Raw copies under
`.novakai/transcripts/` are evidence blobs EXEMPT from the envelope law
(§22 ruling 6). Ingestion/dedup/`transcriptLine` = S3, not built here.

## OD-S2-7 spike (verified 2026-07-28 on Chris's machine)
- kimi:   `~/.kimi-code` — `server/events/session_*.jsonl`; recursive scan covers future layouts
- claude: `~/.claude/projects` — `<proj>/<session>.jsonl` + `<proj>/<session>/subagents/agent-*.jsonl` (subagent files CONFIRMED real)
- codex:  `~/.codex` — `archived_sessions/*.jsonl`, `visualizations/**`, `session_index.jsonl`
Defaults = existing dirs only (`defaultSources()`); list is configurable via `WatcherOptions.sources`.

## Deviations / decisions
- **Poll-based** (default 1s), not fs.watch — atomic editor writes make watch events flaky; polling is the honest mechanism for copy custody.
- **Truncate-then-regrow detection**: inode+size regression alone misses
  same-inode truncation followed by regrowth past the cursor (found by RED
  test). Checkpoints store a sha256 of the last ≤64 copied bytes; a tail
  mismatch → full re-copy into a `.rescan-<n>` record. Original copies are
  never mutated; duplicate raws tolerated in S2 (§13.4).
- node_modules is a symlink to ../agents/node_modules (same devDeps:
  typescript + @types/node only; zero runtime deps). Replace with a real
  install if the package gains its own dependencies.
- TRN-005 (`.novakai/` gitignored) already satisfied — root .gitignore line 15.
