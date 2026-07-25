# Messaging Integration (N-Program) — Handover to the Next Agent

**Written:** 2026-07-25 by kimi-cli, at N-program kickoff.
**Updated:** 2026-07-26 by kimi-cli — **slices N1, N2, N3 (+N3.1), N4 SEALED, merged,
and deployed** (each after its own law-#6 0-context adversarial audit with findings
disposed at source — see `Messaging-N1/N2/N3/N4-Review.md`). Next: **slice N5 (Kill
the pollers)**. **You are:** the agent executing slice N5 or later. Read this first,
every session.

---

## Where things stand

The Messaging pass-2 program is COMPLETE (S1–S4, P1–P6, 253/253 tests, scorecard
97.0/100, PR #59). The N-program is PAST THE HALFWAY MARK:

- **N1 (Foundation)** — sealed, merged (PRs #63–#66). The capability lives at
  `packages/messaging/`, embedded in the backend (`src/backend/messagingV2/`).
- **N2 (Agent direct lane)** — sealed, merged (PR #67). Agents authenticate with
  `NVK_AGENT_ID` (durable agentId, env-injected at spawn — identity never
  caller-supplied); PTY delivery via the terminal-host presence transport;
  `nvk-msg` is a thin client of the v2 Bearer routes; `POST /api/messages` and
  `--from` are dead.
- **N3 + N3.1 (Rooms)** — sealed, merged (PRs #68/#69). `#team` = fleet room
  thread; team/mission rooms provisioned from ObjectModel; the human principal
  is in every roster and self-mints (N3.1 — no env var required). #team verified
  LIVE end-to-end in production.
- **N4 (Frontend)** — sealed, merged (PR #70). The browser runs on pushed
  capability events (per-connection `messaging-v2-sub` dialect over the app ws,
  cursor replay, zero REST polls); server-owned human routes
  (`/api/messaging/v2/user/send|threads|messages`); the ENTIRE old messaging
  surface deleted at the root (−3,671 LOC: SendApi, MessageRouter, PtyDelivery,
  TranscriptEffectConfirmer, MessageStore, tunnel UI, tunnelModel messaging half,
  message-envelope dialect, the N3 shims). Lint baseline ratcheted 201→192.
- **Your job starts at slice N5 (Kill the pollers).**

## N5's inheritance (read the review records' follow-up debt sections)

- `Messaging-N4-Review.md` §follow-up debt: watchdog/nvk-live/slack-mirror are
  dark/quiet and are N5's to repoint (D5) or delete; `.novakai-command/
  messages.jsonl` is a FROZEN archive (no writers — direct file readers survive:
  people liveness, missionView); ExternalSessions allowlist timing; F8b.
- **R-N4-1 is OPEN with Chris:** agent↔agent direct threads are party-only by the
  ratified contract — the human no longer sees agent↔agent DM lanes. An owner
  read-override would be a CONTRACT amendment (assertThreadMember + subscription
  filtering) — surfaced, not built. If Chris rules on it, record the amendment.
- N1 debt still watched: authority revalidate is a full disk scan (presence
  heartbeats make it hot); token=agentId until N6's real issuance (D-N2-2).

## Read next (in this order)

All under `Elite-Kimi-Audit-God-Level/Messaging/`:

1. `Messaging-Integration-Plan.md` — THE plan: promise, decisions D1–D8 +
   Recorded amendments (A-N2-1, D-N2, D-N3/A-N3, D-N4, R-N4-1). Work derives
   from THIS file. N5 row (§5) is the done-definition: no interval touches any
   journal; failure truth is pushed DeliveryUpdated.
2. `Messaging-Integration-Roadmap.html` — the visual (law #4): N1–N4 struck;
   strike N5 when it seals.
3. `Messaging-Integration-CurrentState.md` — the old-surface map. NOTE: most of
   its N2–N4 deletion targets are now deleted; re-verify against code before
   trusting any anchor (it says so itself: "the code wins").
4. `Messaging-HANDOVER.md` — the sealed program's handover: the six laws in full,
   the file map, the context-you-won't-find-in-files.
5. `contract/messaging-contract.json` — the frozen contract. The core does not
   change in this program; a core change is a new R-item + recorded amendment
   (law #2), surfaced to Chris, never a quiet edit.

## Live surface today (post-N4)

- Agents: `scripts/nvk-msg.mjs` — token from `NVK_AGENT_ID` env (injected at
  spawn); `send --to <name>|'#team'|'#mission'`, `read <name>`, `names`.
  v2 Bearer routes: `/api/messaging/v2/{send,inbox,messages,address-book}`.
- Browser: `/api/messaging/v2/user/send|threads|messages` (server-owned human
  principal, no Bearer) + ws dialect `{type:'messaging-v2-sub', since?}` →
  `{event:'messaging-v2', payload}` (MessageCommitted/DeliveryUpdated/
  PresenceChanged, cursor replay).
- Rooms: fleet (`#team`) + one per team + one per mission, provisioned at boot
  and on launch; membership from ObjectModel refs (+ human in every roster).
- Deploy: `npm run redeploy` (snapshot → SIGHUP swap). Verify :3030/:3031 +
  route guards after every deploy. The serve runs under launchd
  (`com.novakai.prod`) with NO NVK_* env vars — the human token self-mints.

## Standing rules for every N slice

- **The six laws apply unchanged** (`Messaging-HANDOVER.md` §laws). Skills are
  mandatory at session start: `elite-codebase-engineering` + `codebase-design`;
  superpowers `verification-before-completion` + `requesting-code-review`;
  `handoff` when closing a slice.
- **Law #6:** before any slice seals, a FRESH 0-context adversarial auditor
  pressure-tests the diff since the last auditor (elite-engineering-briefed).
  Findings disposed AT THE SOURCE with regression tests shown RED pre-fix.
  Record: `Messaging-N<n>-Review.md`.
- **Gates that must stay green:** `npx tsc --noEmit`; every `src/**/*.test.ts`
  via `npx tsx <file>`; `npm run stores:test`; `npm run lint` (ratchet — ≤2
  files per src/ dir incl. tests, ≤20-line functions, zero net new warnings;
  `npm run lint -- --update` ratchets the baseline DOWN after deletions);
  `npm run stores:gate`; `npm run build`; package side `npm run messaging:test`
  (253/253 + drift guard).
- **No dual-running.** Each slice deletes the path it replaces in the same
  change when safe. No compatibility museum (dead surface gets deleted, not
  kept "just in case" — see /user/presence at N4).
- **Commit at every checkpoint** on a branch + PR (main protected — GH006).
  Explicit-path `git add` only, NEVER `git add -A`. **CI green BEFORE merge,
  always.** Merge is delegated to the running agent when green (Chris, 2026-07-25:
  "keep committing and merging"). Redeploy + verify live after every merge.
- **Phase gates:** N1–N5 seal before N6 starts; N6 before N7; N7 before N8.

## Context you will not find in the files

- Chris's end-state emotional target: "an agent from my team messages Luke."
  N8 is the moment the program exists for. Do not let Phase 1 perfectionism
  delay the phase gates.
- D8 is the only long-lead external dependency: Luke must accept a Slack
  Connect invite. Chris owns that conversation; he was reminded at the N2 seal.
  Remind ONCE more at the N5 seal if it hasn't happened. Then stop.
- Slack-for-Chris is N7 (own workspace first; Luke = N8). Terminal→Slack always
  flows terminal → capability → bridge → Slack, never a direct wire.
- Chris spews words; compile them. Batch decisions with recommendations, never
  grill, silence = accepted. He is visual — the roadmap HTML is how he
  understands this program; keep it current.
- Accepted behaviors (don't "fix" them): agent↔agent DMs invisible to the human
  (R-N4-1, contract truth); push latency ~500 ms (bus tail, inside MSG-023's
  <1 s); old DM history not displayed (frozen archive, D1).
