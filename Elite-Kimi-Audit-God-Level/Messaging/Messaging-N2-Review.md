# N2 Review — Agent Direct Lane (law-#6 audit record)

**Sealed:** 2026-07-25 · Branch `kimi/n2-agent-lane` · Commits `ec6fb56e` (build),
`62008bab` (D-N2-5 contact bootstrap), `b29b928a` (audit dispositions).
**Auditor:** fresh 0-context adversarial agent (read-only, elite-codebase-engineering
standard), diff `main...kimi/n2-agent-lane`. **Verdict: severely critical** — two
blockers, both real, both disposed at source before seal.

## What the slice delivered

Two live agents converse 1-1 through the sealed `@novakai/messaging` capability in
the running app. Agents authenticate with `NVK_AGENT_ID` (durable agentId injected
into the PTY env at spawn — identity never from caller data); delivery rides a new
presence-transport adapter (`src/backend/messagingV2/transport/`, kind `pty`) bound
to the TerminalRuntime submit lane; `nvk-msg` is a thin client of authenticated v2
routes (`/api/messaging/v2/*`, Bearer token); `POST /api/messages` + `--from` +
`NVK_AGENT` + the old spawn briefing are DELETED. Core package untouched (verified
byte-identical twice). Gates: tsc clean; 92/92 tsx; lint at baseline (201, zero net
new); stores gates PASS; build ✓; package suite 253/253 + NO DRIFT.

## Slice decisions (recorded per law #2)

- **D-N2-1** Agent credential = durable agentId, env-injected at spawn; CLI takes
  `--token`/`NVK_AGENT_ID`, no self-claim path exists.
- **D-N2-2 (threat decision, N1 finding 3 — now ruled):** token=agentId is a public
  identifier; anyone who can read `agents.jsonl` can authenticate as that agent.
  Accepted for N2–N5: localhost same-user boundary, strictly stronger than the old
  bare-name claim. Real token issuance lands in N6. Recorded in the routes header.
- **D-N2-3** Effect semantics: `submit()===true` = `{kind:'effect'}` — "accepted
  into the live per-agent host lane", same honesty standard as the WS adapter's
  socket write. No transcript confirmer by design (the old one dies in N5).
- **D-N2-4** Presence lifecycle is glue-owned: launch/boot → authenticate →
  openPresence(clientLabel=agentId) → bind; exit → liveness onDisconnect.
- **D-N2-5** Team contact bootstrap is COMPOSITION POLICY: glue unions allowlists
  for team/mission co-members + the human principal, `defaultRule:'deny'` always
  re-asserted. DEC-14 deny-by-default stays the gate; strangers still 403.
- **A-N2-1 (amendment):** agent-originated old-router traffic dies in N2; the
  server-owned human route (`/api/user/messages` → SendApi → routeDirect →
  PtyDelivery → TranscriptEffectConfirmer) survives until N3/N4, then dies. No
  dual-running for agent lanes; no regression to Chris's UI.

## Audit findings and dispositions

1. **(severely critical) Studio chat composer POSTed the deleted `/api/messages`.**
   FIXED — repointed to `/api/user/messages`, `from` dropped (composer.tsx);
   tsc/build green; zero `/api/messages` POST references remain in src/frontend.
2. **(severely critical) `/api/user/messages` is unauthenticated — agents can
   stamp traffic as chris.** ACCEPTED with rationale: pre-existing hole inside the
   localhost same-user boundary (same boundary as D-N2-2); no fix exists that the
   browser can keep but a local agent cannot also read. Dies with the route in N4;
   real auth in N6. Same ruling covers `/api/rooms*` + `/api/mailboxes` residue
   (N3 debt).
3. **(moderate) Effect-at-acceptance vs "bytes into the PTY".** DISPOSED — header
   rewritten to the honest claim (accepted into live host lane; settle-window loss
   bounded by liveness; confirmer rejected by design). Corpse-dedupe edge FIXED in
   `TerminalManager.submit` (liveness before dedupe; regression test red→green).
4. **(moderate) nvk-msg absorbed unknown flags into the body.** FIXED — unknown
   `--*` tokens and `--thread` hard-fail exit 1; paging note on full pages.
   Manual CLI runs pasted in the disposition commit.
5. **(moderate) nvk-watchdog + nvk-live dark until N3.** ACCEPTED — recorded here
   and in the handoff; watchdog delivery checks die in N5 regardless, rooms are
   N3's. Chris: the watchdog going quiet is expected, not a crash.
6. **(moderate) Policy-sync failure could kill the capability at boot + false
   "unavailable" briefing.** FIXED — per-session failure collection; sync decoupled
   from lane/boot success. Three regression tests red→green (poisoned session,
   glue, boot).
7. **(low-moderate) GET messages bypassed NotAuthenticated eviction.** FIXED —
   errors route through the same eviction path; red→green with an auth-spy test.
8. **(low→moderate latent) personId→agentId reverse-map used single-dash
   `replace`.** FIXED with a ruled deviation: literal `replaceAll` provably
   regressed uuid agentIds (the forward map folds only underscores), so the
   transport roster-matches BOTH fold candidates; multi-underscore ids resolve,
   uuid ids keep resolving; red→green. Debt comment: authority-owned
   personId→name query is the right fix (later slice).
9. **(low) Boot race between openBootLanes and onLaunch registration.** FIXED —
   hook registered before boot lanes; idempotence dedupes overlap.
10. **(low-moderate) Presence-close/relaunch race can leave a relaunched agent
    laneless until next launch.** ACCEPTED (60% confidence, self-heals) — noted
    for liveness hardening.
11. **(low) `spawn()` exceeded the 20-line ratchet.** FIXED — helpers extracted;
    lint at baseline.
12. **(low) Stale detached host spawns agents without NVK_AGENT_ID after an
    upgrade.** ACCEPTED — fails honestly (CLI exit 1, receive works); ops note:
    restart the terminal host on upgrade when no agents are running.
13. **Non-issues cleared by the auditor (not to be re-litigated):** session cache
    cannot cross-leak identity; DEC-14 intact (union-only, deny re-asserted, 403
    mapped); bind/liveness discipline matches the seam; push no-op can't strand
    subscriptions today (see follow-up 4); multi-listener onExit conversion was
    necessary and correct; no dangling references to deleted code (docs banner
    added to `docs/agent-messaging.md` — SUPERSEDED); package core untouched.

## Follow-up debt (the watching brief for N3+)

1. **N3/N4:** delete the surviving human-route stack (`/api/user/messages`,
   SendApi, routeDirect agent arm, PtyDelivery, TranscriptEffectConfirmer) per
   A-N2-1; the frontend composers already migrated are the reference shape.
2. **N3:** rooms — `POST /api/rooms*` + nvk-live still trust caller `from`
   (finding 2 residue); watchdog/nvk-live sends come back online as room Threads.
3. **Honesty:** if N4+ ever needs stronger-than-lane-acceptance delivery truth,
   the seam supports it (an acking transport), not a resurrected poller.
4. **Subscription push to `pty` presences reports effect without typing** — fine
   for observations today; must be a recorded decision when subscriptions land
   (auditor flag for the N4 implementer).
5. **Liveness hardening:** relaunch race (finding 10); authority revalidate is a
   full disk scan (N1 finding 12) — presence churn makes it hot; watch, don't
   prematurely optimize.
6. **Ops:** restart the terminal host on upgrade (finding 12); watchdog quiet
   until N3 (finding 5).
7. **N6:** real token issuance retires D-N2-2; `/api/user/messages`-class routes
   get real auth or die in N4.

## Interim regressions (accepted, self-healing as slices land)

- Agents can't post to `#team` until N3 (read works via old GET).
- Agent→chris DMs land in the capability inbox, invisible in the Messages tab
  until N4 (readable via `nvk-msg read` meanwhile). Chris→agent from the tab
  unchanged.
- Plain (non-mission) spawns have no durable record → messaging unavailable
  until N6 registration. The briefing says so honestly.
