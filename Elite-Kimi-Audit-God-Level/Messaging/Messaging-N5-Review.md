# N5 Review — Kill the pollers (law-#6 audit record)

**Sealed:** 2026-07-26 · Branch `kimi/n5-kill-pollers` · 11 commits:
`e6ce7562` (delete watchdog; slack-mirror becomes a capability client),
`257492bd` (sender failure-truth, D-N5-3), `0f6d2ebf` (frozen-archive readers
repointed, D-N5-4), `05d262ce` + `5af6a0f2` (seat-watch revived in-app, D-N5-6),
`61ea9ca4` + `36b86c15` (F1 tick guard), `9a0ea1c2` (F2+F4), `374d225c` (F3+F8),
`ca546521` (F5+F7), `effef997` (F6 leftovers).
**Auditor:** fresh 0-context adversarial agent agent-39 (read-only,
elite-codebase-engineering standard), diff `main...kimi/n5-kill-pollers`.
**Verdict: MODERATE** — 10 findings, all disposed below. Diff: 26 files,
+1,907/−514. `packages/messaging/` byte-untouched (auditor-verified).

## What the slice delivered

- **D-N5-1 — the watchdog process is dead.** `scripts/nvk-watchdog.mjs` deleted;
  launchd `com.novakai.watchdog` booted out, plist removed from
  `~/Library/LaunchAgents` (full plist archived verbatim to
  `N5-watchdog-plist-archive.txt` — reversible). Its delivery checks were zombie
  work on the frozen journal; capability `DeliveryUpdated` replaced them.
- **D-N5-2 — slack-mirror is a capability client.** No more 2s byte-offset tail:
  backlog via the server-owned `/api/messaging/v2/user/*` routes, live events via
  the browser ws dialect (`messaging-v2-sub`, cursor resume, 500ms→8s backoff).
  New N7 seeds: `scripts/team/capabilityClient.mjs` + `scripts/team/slackFormat.mjs`.
- **D-N5-3 — agents hear their failures.** New `messagingV2/failureTruth/`: on a
  terminally-failed `DeliveryUpdated`, ONE `[nvk-msg failed: <reason> — <id>]`
  line is typed into the SENDER's PTY lane (sender-guard before dedupe — the
  blocked-recipient sink had been starving the sender's); no-lane senders drop
  quietly. Subscriptions are **live-only** (cursor seeded at journal tip — F2).
- **D-N5-4 — frozen-archive readers repointed.** New shared fold
  `messagingV2/journal/` (capability acceptance ops → envelope rows, torn-tolerant,
  last-wins, `NVK_MESSAGING_V2_STORE` honored). People liveness, missionView
  sources + snapshot refs, and `nvk-status.mjs` all read the capability journal.
- **D-N5-5 — `nvk-oversee.mjs` left** (zero journal contact, auditor-verified).
- **D-N5-6 (Chris's ruling, overrides D-N5-1's accepted loss) — the seat-watch is
  revived in-app** as `src/backend/terminal/seatWatch/`: transcript-mtime quiet
  detection with `.novakai-command/watchdog.json` boundaries (honored unchanged),
  the 16KiB `pendingPrompt` sniff (question-for-human / plan approval /
  permission stop), dead-seat detection with Codex pid fallback, recovery,
  alert-once + silent first-tick baseline. Alerts post to the fleet room through
  the capability as a durable `nvk-watchdog` ops identity that is **co-member of
  every team and mission** (F3); state annotated on `GET /api/agents/:id/health`.
  The watchdog's #team voice — dark since N2 killed `--from` — is back properly.

**Exit condition met:** no interval touches any journal (grep proof: only a doc
comment + test fixtures reference `messages.jsonl`; the only script interval is
nvk-oversee, journal-free). Failure truth is pushed `DeliveryUpdated` on browser
and agent lanes.

## Slice decisions (recorded per law #2 — in the plan's amendments)

D-N5-1..6 as above, plus **A-N5-1**: the app-side stores schema now allows an
agent to hold multiple team/mission refs (min 1, no max) — co-membership was
always union semantics in `messagingV2/policy/`; the validator's cardinality
check contradicted it. App-side change, core untouched.

## Audit findings and dispositions (7 fixed, 2 partial, 1 debt-only)

1. **(MODERATE) Unguarded seat-watch `setInterval` tick could kill the whole
   backend** (TOCTOU statSync ENOENT / config writeFileSync ENOSPC) — a
   regression vs the deleted script, which wrapped every tick. **FIXED** —
   `tickSafely` guards boot + interval ticks; red→green (throwing roster logs
   once, next tick runs).
2. **(MODERATE) failureTruth dedupe expired on restart** — in-memory `seen` +
   replay-from-0 meant every deploy re-typed every historical failure into live
   agent PTYs. **FIXED** — subscriptions seed `since` at the journal tip
   (live-only); red→green (history types nothing, post-watch failure types once).
3. **(MODERATE) `nvk-watchdog` identity vs deny-by-default contact policy** —
   attached to an arbitrary first mission, so fleet alerts terminally-failed for
   most recipients AND each failure became a `✗ failed` Slack line. **FIXED** —
   unioned into every team/mission (new `server/watchdogIdentity/`, A-N5-1);
   e2e: 2 missions + 2 teams, ZERO failed deliveries. Mid-run-created
   teams/missions join the union on restart (recorded).
4. **(MODERATE-LOW) Aged-out trailing-window failures dropped silently** —
   **FIXED** — one trace line; F2 makes the path rare.
5. **(LOW-MODERATE) `--backlog 0` flooded Slack with full history** — **FIXED** —
   cursor seeded at tip (live-only); verified against the Live server (pre-fix
   7 history posts in 12s; post-fix 0). SEEN_MAX eviction re-post bound
   documented.
6. **(LOW-MODERATE) Deletion leftovers** — `scripts/com.novakai.watchdog.plist`
   (a KeepAlive crash-loop trap) git-rm'd; `docs/exe-template.md` updated;
   `docs/operations/SLACK-MIRROR.md` rewritten for the capability-client reality;
   dead permission lines removed from local (gitignored) settings. **FIXED.**
7. **(LOW) Mirror identity degradation** — **PARTIAL**: failure attribution no
   longer blames the human ('unknown'); roster/lanes re-resolve every 5 min via
   route poll; the `agentIdForPersonId` inverse is marked FRAGILE; DM-lane
   raw-threadId fallback recorded as accepted debt.
8. **(LOW) `nvk-watchdog` durable pollution** — **PARTIAL**: one cached alert
   session (per-alert auth leak fixed); directory presence is semantically
   honest for an ops service; `spawning` status accepted (AgentBlock has no
   service value — recorded).
9. **(LOW) Journal fold scales with total history per request** — **DEBT ONLY.**
   Pre-existing pattern worsened by the repoint; journal rotation/query surface
   is a core-package concern → N6+ debt (R-item if it bites).
10. **(note) `⚠ partial` mirror line dropped** — **DEBT**: no `partial` delivery
    state exists (`pending|held|delivered|failed`); restoring is not one
    formatter branch. Noted in `slackFormat.mjs` for the N7 bridge.

**Auditor signed off:** sender-guard-before-dedupe sound and atomic; cursor
semantics coherent (sequence IS the global journal sequence); security posture
unchanged (loopback bind; user routes a ratified N4 decision); seatWatch
semantics a faithful port; frozen core untouched; journal fold tolerance as
claimed.

## Gates at seal (all personally re-verified by the orchestrator)

tsc clean · **90/90** src test files via tsx + all scripts .mjs tests · lint
**192 at baseline** (zero net new; two would-be regressions fixed at source) ·
stores:test pass · stores:gate PASS (57 fingerprints, 381 ids) · build ✓ ·
package **253/253 + NO DRIFT** (60 suites).

## Follow-up debt (N6's inheritance)

- Journal fold growth (finding 9) — core-side rotation/query surface question.
- Mid-run-created teams/missions: watchdog union refreshes on restart only.
- Slack-mirror: DM-lane raw-threadId fallback; FRAGILE agentId inverse; no `⚠`
  partial line (F7/F10 above).
- Carried from N4: ExternalSessions allowlist timing; F8b quiet sub-tip
  failures; browser presence transport (N6 option); N1 authority revalidate is
  a full disk scan; token=agentId until N6 (D-N2-2).
- **R-N4-1 is RULED (PR #72, Chris 2026-07-26: YES)** — the owner MUST see
  agent↔agent DM lanes. Contract amendment (assertThreadMember + subscription
  filtering) scheduled as its own slice after N5 seals — never a quiet edit.
- **For Chris at this seal:** (1) Slack app provisioning click-steps for N7
  (bot token + Socket Mode — the webhook is post-only, cannot read or create
  channels); (2) final D8 reminder — Luke's Slack Connect acceptance.
