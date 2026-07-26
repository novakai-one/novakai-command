# N7 Review — Slack grows up (own workspace)

**Sealed:** 2026-07-26 · branch `kimi/n7-slack-rooms` · commits `0c2ab355`
(slice + orchestrator-caught identity fix) + `269254a3` (audit disposals) ·
the frozen core is untouched (zero files under `packages/messaging`).

## What shipped

The v0 Slack bridge generalized **in place** (D-BRIDGE-1 — no rewrite; the
one-way mirror untouched): one Slack channel ↔ one room Thread joins the
agent↔chris DM lanes, echo-safe, both directions durable.

- **D-N7-1 — transports stay.** The bridge remains a CLIENT of Messaging
  over the embedded surface (browser dialect + user routes); the DEC-17
  door migration is unnecessary for a co-located launchd daemon.
- **D-N7-2 — channel ↔ room map.** Config `channels:[{slackChannelId,
  room}]`, resolved to threadIds at boot via the `/user/threads` label
  enrichment (label → `authority:externalId` → unambiguous-bare-only, after
  audit F4). **ABSENT/empty = fully dormant — production runs exactly that
  until Chris's click-work lands** (proven by test).
- **D-N7-3 — rooms go top-level.** Mapped-room messages post top-level to
  the channel with the roster-stamped `*name* · HH:MM` header + echo tag;
  per-message bridge line promoted vlog→log; `<@U…>` mentions decoded
  (users.info, bounded cache).
- **D-N7-4 — inbound, owner-only.** Channel messages bridge as the human
  via the existing `#label` room route; **any other Slack user drops with
  one loud line** (external principals are N8's mechanism). Pre-audit the
  design carried a `userMap` whose sends would have stamped chris's name on
  another user's words — caught on orchestrator review, removed RED-first
  (the test asserts a non-owner's message never lands AS chris).
- **D-N7-5 — echo-safe.** The three guards (bot_id, own user, metadata tag)
  apply to every lane; the loop hunt is extended both directions including
  redelivery, the human-echo room path, and the edit-note path.
- **D-N7-6 — edit/delete → follow-up note, sizes, rate limits.** Edits and
  deletes become `[edited on Slack] …` / `[deleted on Slack]` notes (new
  messages — history is immutable, never a mutation). 32 KiB: outbound
  chunking with `(i/n)` markers + **mid-chunk resume** (audit F3); inbound
  too-big gets a posted note (byte-measured, audit F7). 429s: Retry-After +
  jitter, 3 bounded attempts, capped at 30 s (audit F6).
- **D-N7-7 — health.** `health` block in the state file (additive; the
  bridge is the only writer) + `GET /api/agents/slack-bridge/health`
  (404 absent, 503 stale >5 min, NaN-guarded). Liveness = the daemon
  persisting state (audit F1 — staleness no longer inverts on idle).

## Audit (law #6 — fresh 0-context auditor, elite-engineering lens)

**Verdict: MODERATE** — no SEVERE; the slice's #1 risk (echo loops) was
traced clean in every direction, identity honesty verified owner-only, and
dormancy proven by construction and test. Nine findings, ALL disposed at
source:

- **F1 (MODERATE):** health staleness inverted — an idle/outbound-only
  bridge read as down. `saveState` refreshes `updatedAt` on every persist;
  room outbound sets `lastBridgedAt`. (RED-first.)
- **F2 (MODERATE):** `resolveChannels` hard-failed boot when the app was
  down — would have crash-looped both lanes behind the click-work. Now:
  loud warn, dormant, re-resolves on every app-ws (re)connect. (RED-first.)
- **F3 (MODERATE):** chunk partial failure silently truncated a settled
  message (id-level dedupe swallowed the rest). `postedMessages` tracks
  `partsPosted`/`complete`; replay resumes mid-chunk; the cursor advances
  only at completion. (RED-first: part 1 never reposted, parts 2–3 land.)
- **F4 (MODERATE):** room resolution ignored `authority` — the durable key
  is composite; the fleet room `{fleet, team}` could collide with a team
  room `externalId:'team'`, and `find` binds first-listed (same config →
  different rooms across restarts; a split-brain lane vs the `#team` send
  special-case). Now label-first, `authority:externalId` form, bare only
  when unambiguous; duplicate channel entries refused loudly. (RED-first.)
- **F5–F9 (LOW):** jammed line + trailing newline; Retry-After capped 30 s
  (head-of-line); too-big guard in bytes not chars; health route NaN guard;
  mention-matching on raw wire text before unescaping.

## Verification evidence (personally re-run by the orchestrator)

- Bridge suite **26 → 46 checks** (loop hunt, identity-never-as-chris,
  dormancy, chunk resume, 429 timing, authority collision, health,
  edit/delete notes) — RED-first evidence captured for the identity fix
  and F1–F4.
- Full src tsx sweep **93/93**; scripts sweep **7/7**; `npx tsc --noEmit`
  clean; `npm run lint` **192 at baseline**; stores:test + stores:gate
  PASS; build green; package **263/263 + NO DRIFT** (untouched).
- Live-fire (post-click-work, with Chris): a real channel ↔ the fleet room.
  Until then production runs dormant — DM lanes unaffected.

## Chris's click-work (surfaced at the seal — Slack app "Novakai Mirror")

1. Bot scopes: add `channels:read`, `channels:join`, `channels:manage`,
   `channels:history` (`users:read` already works).
2. Bot events: subscribe to `message.channels`.
3. Create/pick the channel; invite the bot (and, when it's time,
   PartnerChris).
4. Tell the orchestrator the channel id → one line into
   `.novakai-command/slack-bridge.json` `channels` + bridge restart.

## Follow-up debt for N8+

- Bridge thread-reply visibility for DM lanes (agents' answers still hide
  in Slack DM threads — top-level/broadcast decision) — parked.
- UI surface for the new bridge-health route — parked.
- nvk-connect queue-until-ready + door bind log line (N6 polish) — parked.
- The N6/R-N4-1 carryovers (F4 doorStack Pick-shape, F7 door close race,
  boot-mint growth, jsonl restart-fold test, journal fold growth, N1
  revalidate disk scan, mirror raw-threadId/FRAGILE-inverse).
