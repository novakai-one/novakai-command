# Messaging Integration — Current-State Map (the old surface)

**Captured:** 2026-07-25, from a full read-only exploration of the Novakai-Command
app (branch state: main `c6fa287d`+). This is the evidence base for N1–N5: what the
old messaging is, file by file, and where the new capability attaches. If any claim
here conflicts with the code, the code wins — re-verify before deleting anything.

Spec doc for the old system: `docs/agent-messaging.md`.

---

## 1. Backend messaging (the deletion core)

Everything under `src/backend/messaging/` (15 source files ~1,758 LOC; 13 test
files ~2,081 LOC). Persistence is its own JSONL journals under `.novakai-command/`
(NOT the gated `.novakai/stores/`).

- `store/index.ts:27` `MessageStore` — append-only `.novakai-command/messages.jsonl`
  (env override `NVK_MESSAGE_STORE`). Amendments append a copy, last line wins;
  in-memory index re-folds on outside writes (mtime/size probe `fresh()` `:92`).
- `types.ts:5` `MessageEnvelope` — `{id: msg_<uuid>, from, to, delivery:
  normal|interrupt, body, threadId?, createdAt, status:
  queued|accepted|delivered|partial|failed, outcome?, senderAgentId?,
  recipientAgentId?, missionId?}`. Also `Room`, `SendMessage`, `DeliveryReceipt`,
  `AgentAddress`, `MessageQuery`.
- `rooms/index.ts:6` `RoomStore` — `.novakai-command/rooms.jsonl`,
  `{roomId, name, members[], createdBy, createdAt, archived}`.
- `mailbox/index.ts:30` `MailboxRegistry` — `.novakai-command/mailboxes.jsonl`;
  seeds `chris` + `kimi`.
- `router/index.ts:81` `MessageRouter.route()` — stamps identity, appends, routes
  channel/room/direct. `#team` pull-only for agents but Chris's posts fan out to
  every live PTY (`routeChannel` `:148`). Interrupt rate limit 3/min. `reconcile()`
  retries queued once ~1.5 s after boot.
- `send/index.ts:27` `SendApi.send()` — validate → envelope(queued) → router.
- `delivery/index.ts:44` `PtyDelivery` — per-agent serialized lanes; types
  `[nvk-msg from <name> id <msgId>] <body>` into the PTY; Esc lead-in for
  interrupts. `MailboxDeliveryAdapter` `:177` is a no-op (journal + ws broadcast IS
  the delivery).
- `confirm/index.ts:173` `TranscriptEffectConfirmer` — polls the recipient's
  provider transcript every 500 ms up to 15 s for the `[nvk-msg …]` marker, then
  amends to delivered. **This dies in N5** — delivery truth comes from transport
  EffectReports.
- `index.ts:81` `MessagingHub` — wires everything; broadcasts `message-envelope`
  on every append (`:100`), `rooms-changed` (`:101`); spawn briefing typed into new
  agents' PTYs (`handleAgentSpawned` `:262`, text in `address/briefing.ts:7`).
  Built in `src/backend/server/index.ts:153`; spawn hook `:168`.
- `threads/index.ts:14` — POST /api/threads writes a `thread_*` block into the
  GATED `.novakai/stores/threads.jsonl` (room↔mission link). Keep — stores-gated.

External journal readers (repoint, don't break): `people/index.ts:84` (liveness
from last-activity), `missionView/sources/index.ts:169` (read-only history),
watchdog + slack-mirror scripts (§4).

## 2. Wire protocol (old)

REST (registered in `MessagingHub.registerRoutes`, `messaging/index.ts:151`):
`POST /api/messages` (**trusts client `from` — SECURITY DEBT, noted at `:279`;
dies in N2**), `POST /api/user/messages`, `GET /api/messages` (history),
`GET /api/identity`, `GET /api/messaging/address-book`, `POST /api/mailboxes`,
`POST /api/rooms`, `POST /api/user/rooms`, `GET /api/rooms`,
`POST /api/rooms/:roomId/members`, `POST /api/threads`.
WS: one shared socket; messaging events are `message-envelope` + `rooms-changed`
broadcasts via `broadcastEvent` (`server/index.ts:529`). Frontend client:
`src/frontend/lib/agentSocket/index.ts` (singleton, routes those at `:135–136`,
refetch-on-reconnect).

## 3. Frontend messaging UI

- `components/workspace/messages/` — 19 files ~4,721 LOC: 3-pane MessagesView,
  `model.ts` (delivery grammar, presence tones, rail capping, windowed thread,
  restore state machine), `flows/`, `rail/`, `thread/`, `composer/`, `context/`.
- `lib/tunnelModel/` (~655 LOC) — the read model: `useTunnelFeed` (one REST pull +
  ws upserts + per-lane pulls), `useTunnelRooms`, lane derivation, DM overlays.
- `components/studio/chat/tunnel/` (~953 LOC) — older tunnel UI, same feed.
- `missionControl/index.tsx` + `panels/` — consumes the same feed/rooms; own
  composer POSTs `/api/user/messages`; room creation POST `/api/user/rooms`.
- `organization/index.tsx:200` — draws traffic wires/stats from the feed.
- Cross-cutting: `lib/attention` (amber queue from failed envelopes),
  `lib/readCursor` (per-lane unread in localStorage), `lib/mentions`,
  `lib/composerDraft`.

## 4. Pollers (N5 kills these)

- `scripts/nvk-watchdog.mjs` — 60 s interval re-reading the journal, delivery
  alerts to #team; launchd job.
- `scripts/nvk-slack-mirror.mjs` — interval tail of the journal → Slack webhook
  (repoint to a capability subscription per D5, don't revive the tail).
- `scripts/nvk-oversee.mjs` — fleet oversight interval.
- Agent-side pull is by CONVENTION: the spawn briefing tells agents to run
  `nvk-msg read` "at natural pauses" — every read is a CLI poll.
- `TranscriptEffectConfirmer` 500 ms transcript scan per interrupt (§1).

## 5. PTY / terminal (the N2 transport seam)

- `terminal/manager.ts:92` `TerminalManager` — owns PTYs; `write()` `:207`;
  host-owned `submit` job `:224` (type → settle → `\r` → optional flush `\r`,
  serialized per agent, deduped by messageId). **This is the seam the N2
  presence-transport adapter binds to** — same shape as the package's PTY adapter
  contract (effect on confirmed write, dead lane → presence-gone).
- `terminal/host/launch/index.ts:151` — production runs a detached host process
  (PTYs survive backend restarts); protocol `HostCommand`
  create/write/submit/resize/rename/kill/archive (`terminal/host/protocol/`).
- `terminal/nudge/` — separate stall-recovery write path, not messaging.

## 6. Identity & membership truth (the N1 adapter sources)

- Durable agents: `.novakai/stores/agents.jsonl` via ObjectModel — `{id:
  agent_<uuid>, kind, ts, name, provider, status, sessionId?, sessions?, refs:
  [{kind: team|mission, value}]}`. Written ONLY through ObjectModel on the
  locked/CAS store engine.
- Membership: derives from agent `refs` (single authority — teams.jsonl holds NO
  member lists). Read APIs: `ObjectModel.missionAgents()` `:224`,
  `missionForRoom()` `:205`, `missionForAgent()` `:198`.
- People directory: `GET /api/people` (`people/index.ts`) joins durable ∪ runtime
  with liveness tiers — the natural read seam for the authority adapter.
- Roles (Chief/Manager/etc.) are display-name CONVENTIONS only — no schema field.
  D4 stands: role→grant mapping in authority-adapter config, no schema change.
- Mailbox identities: `{id: user:chris|orchestrator:<slug>, role:
  owner|orchestrator, permissions[]}` — the only role/permission enum today.

## 7. Gates that must stay green (every N slice)

`npx tsc --noEmit`; every `src/**/*.test.ts` individually via `npx tsx <file>` (no
test runner); `npm run stores:test`; `npm run lint` (structural ratchet —
max 2 code files per directory!); `npm run stores:gate`; `npm run build`.
Note: messaging journals are NOT covered by stores:gate; `threads.jsonl` IS.

## 8. Deletion candidates (per slice, per the plan)

- N2: router direct path, `PtyDelivery`, `POST /api/messages`; `nvk-msg` CLI
  becomes a thin adapter (D3).
- N3: `RoomStore`, `routeChannel` fan-out.
- N4: `tunnelModel` messaging half, `message-envelope`/`rooms-changed` dialect,
  tunnel UI; Messages tab rewired to capability events.
- N5: watchdog delivery checks, `TranscriptEffectConfirmer`, mailbox-scan
  briefing text; slack-mirror repointed (D5).
- ExternalSessions (`externalSessions/index.ts`, 226 LOC) composes the old send
  seam — evaluate at N2; likely rewires rather than deletes (external sessions
  are an N6 concern too).
