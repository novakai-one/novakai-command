# Messaging Integration (N-Program) — Handover to the Next Agent

**Written:** 2026-07-25 by kimi-cli, at N-program kickoff (plan ratified, nothing built yet).
**You are:** the agent executing slice N1 or later. Read this first, every session.

---

## Where things stand

The Messaging pass-2 program is COMPLETE and sealed (S1–S4, P1–P6, 253/253 tests,
scorecard 97.0/100, merged to `main` via PR #59). The N-program — wiring that
capability into Novakai-Command and outward to Slack/Luke — is **ratified but not
started**. Your job starts at **slice N1 (Foundation)**.

## Read next (in this order)

All under `Elite-Kimi-Audit-God-Level/Messaging/` in the novakai-command repo:

1. `Messaging-Integration-Plan.md` — THE plan: promise, decisions D1–D8 (binding),
   architecture, slice table N1–N8 with exit conditions, risks, gates. Work derives
   from THIS file.
2. `Messaging-Integration-Roadmap.html` — the visual. Keep it current (law #4):
   strike slices as they seal.
3. `Messaging-HANDOVER.md` — the sealed program's handover: the six laws in full,
   the file map, the context-you-won't-find-in-files.
4. `contract/messaging-contract.json` — the frozen contract. The core does not
   change in this program; if a slice thinks it needs a core change, that is a new
   R-item + recorded amendment (law #2), surfaced to Chris, never a quiet edit.

## Current-state evidence for the integration

A full exploration of the app's existing messaging surface was run 2026-07-25 (what
to delete, where the integration points are, with file:line anchors). Its findings
are summarized in §2 of the plan. Key facts: ObjectModel (`agents/teams/missions/
threads.jsonl`) is the membership/identity authority; TerminalHost `submit` lane is
the PTY delivery seam; `broadcastEvent` is the browser push boundary; the old
surface is `src/backend/messaging/**` + Messages tab/tunnel UI + pollers.

## Standing rules for every N slice

- **The six laws apply unchanged** (see `Messaging-HANDOVER.md` §laws). Skills are
  mandatory at session start: `elite-codebase-engineering` + `codebase-design`;
  superpowers `verification-before-completion` + `requesting-code-review`;
  `handoff` when closing a slice.
- **Law #6:** before any slice seals, a fresh 0-context adversarial auditor
  pressure-tests the diff since the last auditor. Findings disposed AT THE SOURCE,
  recorded in a `Messaging-N<n>-Review.md`, then commit.
- **Gates that must stay green:** app side — `npx tsc --noEmit`, every
  `src/**/*.test.ts` via tsx, `npm run stores:test`, `npm run lint`,
  `npm run stores:gate`, `npm run build`; package side — `npm run build && npm test`
  in `packages/messaging/` (post-D2 move), drift guard while the map covers the
  contract.
- **No dual-running.** Each slice deletes the path it replaces in the same change
  when safe. No compatibility museum.
- **Commit per slice on a branch + PR** (main is protected — GH006). Never merge
  without Chris's say-so; he merges or delegates explicitly.
- **Phase gates:** N1–N5 seal before N6 starts; N6 before N7; N7 before N8.

## Context you will not find in the files

- Chris's end-state emotional target: "an agent from my team messages Luke." N8 is
  the moment the program exists for. Do not let Phase 1 perfectionism delay the
  phase gates.
- D8 is the only long-lead external dependency: Luke must accept a Slack Connect
  invite. Chris owns that conversation; remind him during Phase 1 if it hasn't
  happened.
- Chris spews words; compile them. Batch decisions with recommendations, never
  grill, silence = accepted. He is visual — the roadmap HTML is how he understands
  this program; update it as slices seal.
- The old messaging has one deliberate debt the new contract kills on contact:
  `POST /api/messages` trusts a client-supplied `from` string. N2 eliminates it;
  do not reintroduce caller-supplied identity anywhere.
