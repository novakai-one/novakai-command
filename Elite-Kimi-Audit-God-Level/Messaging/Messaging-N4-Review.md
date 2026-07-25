# N4 Review — Frontend (law-#6 audit record)

**Sealed:** 2026-07-26 · Branch `kimi/n4-frontend` · Commits `e40bb756` (backend live
dialect + human routes), `615cb748` (data plane + translator), `f185d2c2` (consumer
rewires), `a1bc96b8` (deletions, −3,671 LOC), `7458e1c1` (pre-audit dead-code
disposal), `453da0ac` (lint baseline 201→194), `c2e1b5a6` (audit dispositions),
`81da86c4` (/user/presence removal + baseline→192).
**Auditor:** fresh 0-context adversarial agent (read-only, elite-codebase-engineering
standard), diff `main...kimi/n4-frontend`. **Verdict: severely critical** — two
release-blockers, both real, both disposed at source before seal.

## What the slice delivered

The browser inbox runs on pushed capability events with ZERO REST polls: a
per-connection `messaging-v2-sub` frame on the existing app ws creates a
human-session subscription (MessageCommitted/DeliveryUpdated/PresenceChanged)
forwarded verbatim; cursor persisted client-side, dedupe by global sequence,
ended→backoff+refetch+resubscribe, manual teardown on socket close. Server-owned
human routes (`/api/messaging/v2/user/send|threads|messages`, no Bearer — the
server is the trust boundary). A frontend data plane translates capability truth
into the view layer's envelope shape under a strict honesty table (committed →
quiet 'delivered'; DeliveryUpdated{failed} → 'failed'; just-POSTed → 'queued';
NO invented states). Consumers rewired: Messages tab, Mission Control,
organization, studio/chat. DELETED at the root: the entire old surface —
GET /api/messages, POST /api/user/messages, GET|POST /api/user/rooms,
message-envelope/rooms-changed dialect, SendApi, MessageRouter, PtyDelivery,
TranscriptEffectConfirmer, MessageStore class, identity/actors/send/delivery/
confirm/router dirs, tunnel UI, tunnelModel messaging half, the N3 shims,
GET /api/identity, rooms.post/TranslatedEnvelope, /user/presence. ExternalSessions
SendExternal rewired to the capability. Core untouched. Gates: tsc clean; 85/85
tsx; lint 192 (baseline ratcheted 201→194→192); stores gates PASS; build ✓;
package 253/253 + NO DRIFT.

## Slice decisions (recorded per law #2)

- **D-N4-1** Browser = forwarded-frame subscriber over the existing app ws
  (per-connection sink/cursor/teardown). A ws presence transport for browser tabs
  (true per-screen delivery truth) is a recorded N5/N6 option; DEC-17 is N6's door.
- **D-N4-2** Data plane moves, view layer survives; the translator never claims a
  state the capability hasn't stated (the "Not delivered" heuristic is dead).
- **D-N4-3** Sends/reads are server-owned human sessions through the capability.
- **D-N4-4** Rooms in the UI are capability rooms (fleet/team/mission); free rooms
  and their creation flows leave the UI.
- **D-N4-5** Presence UI = PeopleHub liveness tiers (kept); the feed-derived
  "invented heuristic" is deleted. The capability presence surface (/user/presence,
  PresenceChanged rendering) was built, found unused, and DELETED — no museum.
- **R-N4-1 (for Chris — contract amendment question):** agent↔agent direct
  threads are party-only by the ratified contract (assertThreadMember has NO
  admin bypass — verified). The human no longer sees agent↔agent DM lanes;
  rooms/#team remain fully visible (he is in every roster). An owner read-override
  would be a CONTRACT amendment — surfaced, not built.

## Audit findings and dispositions (16 fixed, 1 accepted-partial)

1. **(severely critical) Feed mounted on an already-open socket NEVER subscribed**
   — the headline feature dead on its primary surface (the transition listener
   fired only for the always-mounted studio panel). FIXED — eager subscribe when
   already connected; red→green (fake socket opened pre-wire).
2. **(severely critical) `visibleLanesFor` pruned incoming-only DM lanes** — the
   exact "agent DMs Chris while his browser is closed" scenario produced no
   visible lane. FIXED — the `chrisParty` rule deleted (served lanes are
   human-party by contract); red→green.
3. **(moderate) Incoming DM rows rendered "<name> → <name>".** FIXED — incoming
   renders the bare sender; both directions tested.
4. **(moderate) Failed POST left a permanent 'queued' ghost.** FIXED — row
   marked 'failed' (feeds the amber flow); red→green.
5. **(moderate) No-backoff reload storm when the capability is down.** FIXED —
   500ms→8s doubling backoff; dependency-lost before first success never
   refetches; red→green (0 reloads, delays [500,1000,2000]).
6. **(moderate) Subscription handle overwrite leak** (activated by the F1 fix).
   FIXED — supersede closes the prior handle; red→green (no doubled echoes).
7. **(moderate) Reload lost-update race wiped live rows.** FIXED — mergeFeed
   folds history under live; red→green (mid-reload frame survives).
8. **(moderate) Delivery facts skippable by a message-only cursor.** FIXED (8a) —
   cursor advances on ALL sequenced frames; red→green ('s_42'). ACCEPTED (8b) —
   the sub-tip failure on a disconnected tab renders quiet until next activity
   (tiny, self-healing; no REST-side delivery enrichment built).
9. **(moderate) Sends to offline/mailbox agents 404'd.** FIXED — resolution
   falls back to durable-by-name; the capability decides deliverability (delivery
   pends honestly). The fix EXPOSED a real D-N2-5 gap: never-live durable agents
   weren't policy-bootstrapped — fixed at the bootstrap (every active durable
   agent gets policy sessions), host policy, red→green (403→201).
10. **(moderate) Dead script arms.** FIXED — nvk-msg's `room_` INTERIM branch
    deleted; nvk-live's room arms deleted (roster + agent send survive).
11. **(low) Dead presence surface.** FIXED — frontend fetch/hook deleted;
    /user/presence route then found unused and deleted too (seal commit).
12. **(low) Unknown-thread live frames mis-filed.** FIXED — refetch threads on
    unknown threadId; red→green.
13. **(low) Duplicated rosterAgents fabrication.** FIXED — one shared helper;
    fabricated `person_<name>` ids gone.
14. **(low) Circular import index ↔ compat.** FIXED — one value direction.
15. **(low) Stale docs/comments.** FIXED — SUPERSEDED banner on
    docs/plans/messaging-ui-rebuild.md; headers corrected.
16. **(low) Silent empty inbox on capability-down.** FIXED — load-error state +
    "messaging unavailable — retrying" affordance; red→green.

## Verified clean by the auditor

Identity (sender only from the held human session; `to` resolution unspoofable);
sink honesty (effect only on real writes; dead socket ends the subscription);
dedupe/cursor correctness; deletion completeness in src/; missionView/people
archive readers faithful (frozen archive — no new writes, accepted); ratchet held.

## Follow-up debt (N5's inheritance)

1. Watchdog / nvk-live / slack-mirror: still dark/quiet — N5's repoint (D5) and
   deletion work. The old journal is now a FROZEN archive (no writers at all).
2. N2 follow-up 4 (subscription push to pty presences reports effect without
   typing) — N4's browser path uses the forwarded-frame dialect, not transport
   push; the recorded decision still stands for any future transport-push use.
3. F8b (accepted): sub-tip delivery failures on disconnected tabs render quiet
   until next activity.
4. Browser presence transport (per-screen delivery truth) — the N5/N6 option.
5. ExternalSessions allowlist timing: a fresh external's announce can 403 until
   the next bootstrap sync (recorded at build; N5's call).

## Interim-permanent notes

- Old DM/room history is a frozen archive (D1) — not displayed in the UI.
- Push latency floor ~500 ms (bus tail) — inside the <1 s budget (MSG-023).
- Agent↔agent DM lanes are private by contract (R-N4-1 with Chris).
