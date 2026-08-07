# packages/transcript — NOTES (S2b)

Copy-only watchers for provider session dirs (TRN-001). Raw copies under
`.novakai/transcripts/` are evidence blobs EXEMPT from the envelope law
(§22 ruling 6). B2b adds Transcript-owned normalization, deduplication,
checkpoints, journal entries, and read-only queries behind the separate
source-adapter seam; watcher custody remains unchanged.

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

## Pass-2 schema amendment

`sourceAttribution.authorRef` remains deliberately absent in B2b. Pass 2 must
amend the Foundation-owned `SourceAttribution` schema before Transcript can
persist that durable author reference. B2b preserves only explicitly exposed
`agentId`/`parentAgentId`; provider-native session, sidechain, thread, and
subagent strings are never promoted to durable Novakai identity.

The B2b audit disposal amends the R3-14 fallback identity to
`hash(content + offset + parent-id + sourceId)`. The opaque `sourceId` keeps
identical position/content tuples from different custody files distinct while
preserving deterministic replay identity within one source.

## linesBySession coverage ruling (controller [Kimi proposal 3], 2026-07-29)

`linesBySession` resolves sessions registered in `providerSession` — i.e.
sessions spawned through the server after B2b goes live. Historical imported
sessions (custody copies predating registration) resolve as typed absence, and
claude/codex coverage follows the same rule. Historical reconciliation is a
Pass-2 item.

## Deferred to Pass 2 (controller ruling, Chris directive 2026-07-29: log, don't fix)

- **F9-CLI durable status:** `nvk transcript status` reports the CLI process's
  own in-memory constant, not the worker's durable status. Fix = transcript-owned
  status record the worker writes and CLI reads (NVK-KIMI-011 finding F9 partial).
- **N5:** `readTraces()` returns the engine's live internal array; no current
  caller mutates it. Fix = copy/frozen view + mutation-safety test.
- **N6:** server host creates identity resolvers but never `replace`s them
  (inert; worker owns ingestion). Fix = wire or remove with honest comment.
- **Audit LOWs from NVK-KIMI-011/009 not listed here are logged in those reports.**
- **Whole-repo standards conformance** (Novakai-Analytics STANDARDS.md, score
  51/100: cycles, complexity, giant files, dead exports) — ratchet per Chris's
  standing rule: vendor standards + gates BEFORE the next build; new/changed
  code only, no retrofit.
