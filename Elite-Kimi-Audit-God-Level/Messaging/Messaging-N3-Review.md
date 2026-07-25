# N3 Review — Rooms (law-#6 audit record)

**Sealed:** 2026-07-26 · Branch `kimi/n3-rooms` · Commits `18c07000` (fleet authority,
provisioning), `5c266018` (#team through capability, shims, deletions), `bd7a4eb5`
(tests — exit condition + R4 proof), `4464e600` (audit dispositions).
**Auditor:** fresh 0-context adversarial agent (read-only, elite-codebase-engineering
standard), diff `main...kimi/n3-rooms`. **Verdict: severely critical** — one
ship-blocker + two structural shim defects, all disposed at source before seal.

## What the slice delivered

`#team` and rooms are capability room Threads. One write path for #team: Chris's
posts (`POST /api/user/messages` to `#team`) go through the capability as the human
principal and the capability's own delivery reproduces the old PTY fan-out;
`routeChannel`/`routeRoom`/`deliverRoomMembers`/`RoomStore` and the agent room
routes (`POST /api/rooms`, members — trusted caller `from`) are DELETED. Agents
send/read `#team` + `#mission` via the v2 routes; PTY receive convention
`[nvk-room <label> from <name> id <msgId>]` preserved (D3). Room Threads provisioned
for the fleet + every team + every mission (get-or-create at boot and on launch).
Membership adapter serves a new adapter-owned `fleet` authority (all active durable
agents + human; human in EVERY roster — owner policy). Browser kept working via a
server-side shim (read translation + live rebroadcast) until N4. Free-floating old
rooms (one real: design-guild) are browser-only archive via a fold shim until N4.
Core package untouched (verified). Gates: tsc clean; 93/93 tsx; lint baseline;
stores gates PASS; build ✓; package 253/253 + NO DRIFT.

## Slice decisions (recorded per law #2)

- **D-N3-1** `#team` = room Thread `{threadKind:'team', authority:'fleet',
  externalId:'team'}`; fleet roster = active durable agents + human principal.
  ONE home — the old journal sees zero new #team writes (test-asserted).
- **D-N3-2** Human principal is a member of every roster the membership adapter
  serves (owner host policy — authorizes Chris's sends and reads everywhere).
- **D-N3-3** Provisioning is host-owned (`createRoomThread`, get-or-create) at boot
  BEFORE lanes open (audit F6) and on agent launch for late-created teams/missions.
- **D-N3-4 (amended by audit F1)** The browser shim required ONE frontend line:
  `historyPath` #team → `/api/messages?withAgent=%23team`. The "zero frontend
  changes" claim is amended; everything else browser-side is untouched.
- **D-N3-5** Urgent-to-room stays rejected at the routes (old `ChannelInterruptError`
  parity) though the core would allow it (MSG-010) — route comment records it.
- **D-N3-6** Sender-receives-own-room-post is accepted core truth (the core includes
  the sender in room recipients; chat-system semantics; no machinery loop — audited).

## Audit findings and dispositions

1. **(severely critical) Read shim unreachable — the real client pulls #team via
   the parameterless `GET /api/messages`.** Fresh page loads would have lost ALL
   capability-era #team history while the archive served as if current. FIXED —
   one-line frontend repoint + a real-client-shape route test (red→green: pre-fix
   the capability post was invisible, the archive line visible). Grep verified no
   other frontend consumer folds #team from the parameterless feed.
2. **(moderate) Live shim leaked team/mission commits into browser DM lanes**
   (phantom `dm:#<label>` conversations). FIXED — rebroadcast filtered to the
   fleet thread only (red→green: team-room commit → 0 broadcasts).
3. **(moderate) Shim subscription: boot replay storm + silent permanent death at
   256 room messages.** FIXED — scoped `threads:[fleet]`, `since`-seeded, and —
   discovery during the fix — the core's watermark initializes to 0, so the cursor
   alone couldn't stop the live-tail flood; the audit-sanctioned createdAt-drop
   fallback was applied and documented. `ended` frames now log loudly (red→green:
   206 flooded frames → 0; `ended{auth-lost}` → asserted log line).
4. **(low latent) Room reads served the OLDEST 200 messages forever.** FIXED —
   trailing-window reads (accumulate + slice to newest 200) for both the shim and
   the v2 route (red→green: 205 seeded → newest 200 served).
5. **(low-moderate) Briefing overpromised whole-fleet push.** DEC-14 stays the
   gate — fleet = shared history all can READ; push reaches co-members + chris.
   FIXED at the briefing text (red→green honesty regexes); behavior accepted.
6. **(low) Boot-window format mislabel (rooms provisioned after the lane sweep).**
   FIXED — `ensureAllRooms()` runs before `openBootLanes()`.
7. **(low) Send-shim nicks.** FIXED — empty #team body → 400 (was 502),
   `DependencyUnavailable` → 503; human added to the v2 address-book (`humans[]`)
   so CLIs render `chris`, not `person_user-chris` (red→green each).
   ACCEPTED-RECORDED: free-room composer 404s until N4 (N4 must disable or
   repoint it); #team lane 503 when terminals/humanToken absent (desktop always
   has terminals); CLI read display cosmetics.

## Verified clean by the auditor (not to be re-litigated)

Single #team write path; R4/DEC-14 exact (blocked members terminal-fail at
acceptance, never a send error); no new caller-trusted identity; provisioning
idempotent across restarts; sender-echo can't loop; late-created teams provision
on next launch; design-guild archive shim tolerant and read-only; lint ratchet
held; deletions complete (only comment-level references remain).

## Follow-up debt (N4's inheritance)

1. **Kill the shim + the surviving human-route stack** (`/api/user/messages`,
   SendApi, routeDirect, PtyDelivery, TranscriptEffectConfirmer, free-room fold
   shim, `message-envelope` dialect) — the frontend moves to capability
   events/queries; `/api/user/messages` gets real auth or dies (N2 finding 2).
2. **Free-room composer** 404s today — disable or repoint it in N4.
3. **Team/mission room lanes** are invisible in the browser (fleet-only shim) —
   N4's frontend surfaces them properly.
4. **Trailing-window reads** are O(pages) per call — fine at shim scale; N4's
   event-driven feed makes it moot.
5. **Watchdog / nvk-live / slack-mirror** still dark/quiet — N5 (D5 repoint).
6. **Subscription push to `pty` presences reports effect without typing** —
   recorded decision needed when N4 wires subscriptions (N2 follow-up 4).

## Interim regressions (accepted, self-healing)

- Browser #team history shows capability-era only (old #team history = archive, D1).
- Free rooms: readable/creatable in the browser; sends 404 until N4.
- Agents can't create rooms (free-room concept is browser-only until N4).
