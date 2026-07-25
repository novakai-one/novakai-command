# Messages Tab UI Rebuild — Implementation Plan

> **SUPERSEDED** — the agent messaging contract is being replaced by the
> @novakai/messaging capability (N-program). As of N4 the Messages tab,
> Mission Control inbox, and the data plane run on the capability
> (messagingV2 feed, zero REST polls); the tunnel/ envelope model this plan
> built on is deleted. See
> Elite-Kimi-Audit-God-Level/Messaging/Messaging-Integration-Plan.md.

**Date:** 2026-07-19 · **Branch:** `kimi/messaging-ui` (worktree `Novakai-Command-kimi-messaging-ui`, base 77f8e251)
**Strategy:** TEAR OUT the current Messages tab UI and build fresh against the storyboard vision.
Backend plumbing (store index/cache, actor registry, delivery adapters, record-first composer,
kimi provider) is **untouched** — it was reworked and tested on 2026-07-19 (night shift #1).

**Design sources (read before building):**
- `/Users/christopherdasca/Documents/kimi/workspace/messaging-design-spec/tokens.css`
- `…/scene-1-structure.md` (messaging home: room selected, Summary right rail)
- `…/scene-2-structure.md` (DM selected, Tasks/Stats/Settings right rail)
- `…/spec-notes.md` (states, gaps, scale quirk)
- `…/reference-export.html` (ground-truth export for pixel comparison)
- `…/messagingHome.png`, `…/scene2.png` (vision screenshots)

---

## 1. Scope

**In scope — one responsive Messages tab containing:**

- **Scene 1 (room view):** left rail (MISSION ROOMS / TEAMS / DIRECT MESSAGES), center thread
  (day pill, message rows, delegation card, reply context, "Agent working…", composer),
  right rail = Summary (NOTIFICATIONS / RECAP / CURRENT / TASKS / ARTEFACTS / LINKS).
- **Scene 2 (DM view):** same shell; right rail = person context with Tasks / Stats / Settings tabs.
- All net-new client behavior: selection, tab switching, record-first send, unread badges,
  presence dots, working indicator, hover/focus states, responsive collapse.

**Explicitly OUT of scope:**

- Any backend change (`src/backend/**`, `src/shared/**`). The UI speaks the existing contract only.
- Any other tab (Mission Control, Organization, Files, Canvas, Analytics, Design, Agents,
  Transcript, Ruleset, Debug) and the Studio shell chrome (top nav, rails, AI panel).
- The **AI panel "Tunnel" tab** (`src/frontend/components/studio/chat/tunnel/**`) — it shares
  components with the old Messages tab but is a separate surface; it stays as-is.
- Stats/Settings tab **content** (never designed) — tasteful placeholders only.
- TEAMS section data (no backend concept of "team") — see §9, decision D2.
- Storyboard hero block ("MESSAGING HOME · VISION" + h1) — storyboard chrome, dropped.

---

## 2. Recon findings (the wiring map)

### 2.1 What exists today

The Messages tab is `src/frontend/components/workspace/messages/index.tsx` (113 lines) +
`index.css` (185 lines). It is a 3-column grid (`62px workspaces strip | messenger | 280px
inspector`) that embeds the **shared** `TunnelMessenger`:

- `MessagesView` (`workspace/messages/index.tsx:33`) — owns `useTunnelFeed()`, attention-queue
  updates, and renders `TunnelMessenger` plus a hand-rolled inspector (Room activity / Live
  squad / Shared work).
- `TunnelMessenger` (`studio/chat/tunnel/index.tsx:71`) — selection state, unread derivation,
  `POST /api/user/rooms` (startChat), `POST /api/user/messages` (send, record-first — server
  forces `from: chris`, records the envelope, then delivers).
- `MessengerRail` (`studio/chat/tunnel/rail/index.tsx`) — search + kind chips + Needs
  you/Unread/Recent/All sections + New-room picker.
- `Transcript` / `MessengerComposer` (`studio/chat/tunnel/transcript/index.tsx`) — scroll-anchor
  restore, ReadCursor advance-on-genuine-visibility, draft persistence, markdown + mentions.

**The "UI shit sandwich":** the tab renders the app shell's immersive frame, then its own
workspaces strip, then the tunnel's own rail — two left panels, three visual languages.

### 2.2 What the shell expects

- `DashboardShell` (`src/frontend/components/index.tsx:433`) renders
  `<MessagesView agents={…} projects={…} project={…} />` when `viewMode === 'messages'`.
- `'messages'` is an **immersive** view (`index.tsx:141`): no StudioRail, no StudioChatPanel —
  the tab owns the entire content area below the top nav. The new 3-rail layout drops in cleanly.
- Top nav tabs are `VIEW_TABS` in `studio/index.tsx:15-27`; **no change needed** — the Messages
  tab keeps its slot. The storyboard top bar (brand lockup, gear) is already the app's actual
  top bar; we do NOT rebuild it inside the tab.
- `MessagesViewProps.openRequest` (`workspace/messages/index.tsx:23`) is part of the exported
  interface — keep it (currently unused by the shell, but it is the cross-view navigation seam).

### 2.3 Backend contract (DO NOT change)

REST (`src/backend/messaging/index.ts:84-96`):

| Endpoint | Use |
|---|---|
| `POST /api/user/messages` `{to, delivery, body}` | Human send. Record-first; 201 `{envelope}`. Errors: 400 invalid, 404 unknown recipient (`{error, roster}`), 403 not a room member, 429 interrupt rate limit, 502 delivery failed |
| `GET /api/messages?withAgent=&withRoom=&threadId=&since=&limit=` | History → `{messages: MessageEnvelope[]}`. `withAgent` = DM lane vs one name; `withRoom` = room lane; bare = full pull |
| `GET /api/rooms` | `{rooms: Room[]}` (includes `archived` flag) |
| `POST /api/user/rooms` `{name, members}` | Create room; server adds `chris`; 201 `{room}` |
| `POST /api/rooms/:roomId/members` `{from, add[]}` | Add members (403 if `from` not a member) |
| `GET /api/identity` | `{identity}` — the server-owned `chris` principal |
| `GET /api/agents` | `{agents: AgentInfo[]}` — roster/presence source |

WS dialect (same `/ws` socket; the `{event, payload}` broadcast dialect — one of the 3 known
dialects, see night report "Known debts"):

- `{event:'message-envelope', payload: MessageEnvelope}` — every appended envelope, sends AND
  status amendments; fold by `id`, later wins (`agentSocket/index.ts:122`, `tunnelModel/index.ts:22`).
- `{event:'rooms-changed', payload:{rooms: Room[]}}` — full roster snapshot per append
  (`agentSocket/index.ts:123`).
- `{type:'agents-changed', agents: AgentInfo[]}` — presence (`agentSocket/index.ts:97`).

Types: `MessageEnvelope` = `{id: msg_<uuid>, from, to, delivery: normal|interrupt, body,
threadId?, createdAt: ISO, status: queued|delivered|failed}` (`src/backend/messaging/types.ts:5`).
ConversationId = `'room_<id>' | '#team' | 'dm:<agentName>'` (`tunnelModel/index.ts:61`).
Presence reality check: `AgentInfo.status` is only `'running' | 'exited'` — there is **no**
online/idle/notification presence concept in the backend (§9, D3).

### 2.4 Clean libs that STAY (reuse, do not rewrite)

| Lib | Exports used | Notes |
|---|---|---|
| `lib/tunnelModel/index.ts` | `useTunnelFeed`, `useTunnelRooms`, `buildConversations`, `messagesFor`, `conversationIdsFor`, `liveRoster`, `latestChrisQuestion`, types | The canonical feed/read model. Tested (`tunnelModel.test.ts`) |
| `lib/readCursor/index.ts` | `useReadCursors`, `unreadCountFor`, `advanceCursor`, `anchorFor`, `saveAnchor`, `saveLane`, `savedLane` | Monotonic cursors, unread derived, localStorage persistence (C21) |
| `lib/composerDraft/index.ts` | `loadDraft`, `saveDraft`, `clearDraft` | Per-lane drafts ("Draft saved") |
| `lib/mentions/index.ts` | `buildTargets`, `MentionTarget` | Object-linked mentions |
| `lib/chatModel/index.ts` | `avatarInitials`, `formatChatTime` | |
| `lib/markdown` + `studio/chat/mention` | `MarkdownText`, `MentionText` | Message body rendering |
| `lib/attention/index.ts` | `useAttention`, `buildAttentionQueue`, `updateAttentionQueue`, `messageItemId` | Keep the attention-queue update so the app-wide amber engine doesn't regress |
| `lib/agentSocket/index.ts` | `connect`, `onMessageEnvelope`, `onRoomsChanged`, `onAgentsChanged` | Singleton ws; consumed via tunnelModel, never directly by components |

### 2.5 Stack conventions (builder MUST follow)

- Vite + React 18 + TS (`vite.config.ts`: root `src/frontend`, dev 3030, `/api`+`/ws` proxied
  to 3031). Styling: **plain per-module CSS** next to each `.tsx`, kebab/BEM-ish classes,
  design values as CSS custom properties. No CSS-in-JS; **inline `style=` is lint-banned**.
- Lint gate = ratchet (`tools/gates/standards.mjs` + `eslint.config.js` + `lint-baseline.json`,
  current baseline 201): `max-lines` 300/file, `sonarjs/cognitive-complexity` 10,
  `id-length` ≥ 4, `max-lines-per-function` 20 (`.ts` only), and **structural rules: max 2 code
  files per directory; every `.tsx` needs a sibling `.css`.** Total violations may not exceed
  baseline — write clean, don't spend baseline.
- Tests: `node:assert` files run via `npx tsx <file>.test.ts` (no vitest/jest — do not add).
- Gates per task: `npx tsc --noEmit`, `npm run lint`, test files green.
- Browser driving: `tools/browse` (headless per-session playwright: `goto/click/type/text/shot`).
- Inter is **already loaded** via Google Fonts `@import` in `src/frontend/css/index.css:1`.
- The storyboard palette is nearly identical to the existing `--st-*` studio tokens
  (`studio/index.css:12+`: `--st-panel: #121214` …) — but we take the storyboard `tokens.css`
  as the single source of truth and mint fresh `--msg-*` vars so the tab is self-contained
  (it must not change appearance when the app theme flips; §9, D5).

---

## 3. Component architecture

### 3.1 File layout (respects the 2-code-files-per-directory rule)

```
src/frontend/components/workspace/messages/
  index.tsx            MessagesView — shell grid, selection state, data hooks, wiring
  index.css            shell layout (3-rail grid, responsive) — REPLACES old css entirely
  tokens.css           storyboard tokens as --msg-* vars, scoped to .msg-view
  model.ts             pure view-model: rail sections, presence map, working heuristic, summary data
  model.test.ts        node:assert tests for model.ts
  rail/
    index.tsx          RoomsRail: MISSION ROOMS / TEAMS / DIRECT MESSAGES, badges, presence dots
    index.css
  thread/
    index.tsx          MessageFeed (DayPill, MessageRow, reply context, working label, delegation card)
    index.css
  composer/
    index.tsx          ComposerBar (channel label, hint, draft-saved, send button)
    index.css
  context/
    index.tsx          ContextPanel: Summary view (room) + person view (DM, Tasks/Stats/Settings tabs)
    index.css
```

### 3.2 Component tree

```
MessagesView                      (data: useTunnelFeed, useTunnelRooms, useReadCursors, agents, attention)
├─ RoomsRail                      props: conversations, roster, unread, selectedId, project threads?, onSelect, onNewRoom
│   ├─ RailTabBar ("All" + ghost icon)          ├─ SectionHeader ×3
│   ├─ RoomItem[]  (# hash glyph, name, BadgeCount)   ← kind room|channel
│   ├─ TeamItem[]  (CSS folder glyph, name)           ← placeholder, §9 D2
│   └─ RailPersonItem[] (AvatarChip initial, name, role, PresenceDot)  ← kind dm
├─ main.thread
│   ├─ MessageFeed                props: messages, conversation, roster, targets, onSeen, onResolve
│   │   ├─ DayPill ("TODAY" / date)
│   │   ├─ MessageRow[] (AvatarSquare, sender+role header, body, timestamp,
│   │   │                optional ReplyContext, optional AgentWorkingLabel)
│   │   └─ DelegationCard?        (only when data exists — see §6; may ship dormant)
│   └─ ComposerBar                props: conversation, onSend — drafts via composerDraft
└─ ContextPanel                   props: selected conversation, feed, roster, agents
    ├─ room/channel selected → SummaryView
    │   ├─ TabBar ("Summary" active)
    │   ├─ Notifications (failed sends in lane → "Review" scrolls to row)
    │   ├─ Recap (derived quiet notes), Current (running members)
    │   ├─ Tasks (placeholder checklist), Artefacts + Links (placeholder/hidden-if-empty)
    └─ dm selected → PersonView
        ├─ TabBar (Tasks | Stats | Settings)
        ├─ PersonHeader (name, role, WorkingBadge?)
        ├─ TasksPane (placeholder checklist)
        ├─ StatsPane (StatRow[] — real derived counts: sent/received/delivered/failed)
        └─ SettingsPane (placeholder)
```

### 3.3 DELETED vs KEPT

**Deleted (replaced in place):**
- `workspace/messages/index.tsx` — rewritten wholesale (keeps the `MessagesView` name +
  `MessagesOpenRequest` export so `components/index.tsx` is untouched).
- `workspace/messages/index.css` — rewritten wholesale (workspaces strip + inspector styles die).

**Untouched:** `studio/chat/tunnel/**` (AI panel Tunnel tab keeps using it), all libs in §2.4,
`components/index.tsx`, `studio/index.tsx`, everything backend.

**Copy, don't import:** the scroll-restore / cursor-advance logic inside
`tunnel/transcript/index.tsx:103-154` (atBottom tracking, anchor restore, reportSeen) is ported
into the new `MessageFeed` — the old component is shared, so we cannot edit it.

---

## 4. Design token integration

1. `messages/tokens.css` declares every storyboard value as `--msg-*` custom properties scoped to
   `.msg-view` (imported first from `index.css`). Names mirror `tokens.css`
   (`--msg-bg-panel: #121214`, `--msg-amber: #d7a842`, `--msg-amber-bright: #e4ae40`,
   `--msg-text-body: #d7d3cc`, `--msg-r-item: 8px`, `--msg-rail-w`, `--msg-context-w`, …).
   Scoping (not `:root`) keeps the app theme system from fighting the tab and vice versa.
2. **Font:** stack `Inter, ui-sans-serif, system-ui, sans-serif` set once on `.msg-view`.
   Inter already loads app-wide via Google Fonts `@import` (`css/index.css:1`) — **keep that
   mechanism** (no bundling work, consistent with the rest of the app). The ONLY monospace in
   the tab is the brand glyph `>_` — which the tab does not render (top bar owns brand).
   No terminal/mono styling anywhere in the tab.
3. **Icons:** no icon font in the storyboard. Use `lucide-react` (already a dependency, used by
   the shell) ONLY where a glyph is needed beyond the storyboard's set; reproduce the
   storyboard set verbatim: unicode `↑` (send), `↳` (reply), `#` (rooms), `⚙` not needed
   (shell owns it); CSS-drawn folder icon for TEAMS (10px bordered box + flap, per
   spec-notes). Presence/task/bullet dots = plain CSS circles/rings at spec sizes.
4. No transitions/animations exist in the export — ours are net-new (§5), confined to the
   tab's CSS.

---

## 5. Density decision (recommendation)

The storyboard is a miniature: 8–13px text with `transform: scale(1.0344)` on a 1562px canvas.
We **rebuild at real-app density** (the owner taste-checks on a dev server):

- Typography ×1.3, rounded: spec 8→10, 9→11, 10→13 (body/rows/tabs), 11→14 (names),
  12→15, 13→16 (composer hint, person name in context header).
- Spacing/radii/avatar/badge/pill sizes ×1.2, rounded to integers (avatar 31→37, 34→41,
  badge 18→22, presence dot 7→8, task dot 9→11, composer min-height 92→110).
- Layout dims: rail 230px and context 280px are already real-world sane — keep as-is
  (`--shell-cols: 230px minmax(250px,1fr) 280px`); top bar belongs to the shell, untouched.
- All scaled values live ONLY in `tokens.css` as computed comments (`/* spec 10px ×1.3 */`),
  so a density veto is a one-file edit.

---

## 6. Behavior / net-new interactions (storyboard has zero scripting)

1. **Selection:** single `selectedId: ConversationId` in `MessagesView`. Clicking a room/person
   selects, `saveLane()` persists, `loadConversation(id)` backfills history. First open restores
   `savedLane()` else freshest lane (same rule as today). Scene 2's "room open but DM focused"
   dual-highlight is **dropped** — one selection, one fill (§9, D4).
2. **Unread badges:** `unreadCountFor(feed, lane.id, cursors)` per lane; amber circle
   (`--msg-amber-bright`, `--msg-text-on-amber`); clears via the existing ReadCursor advance
   (transcript reports genuine visibility — ported scroll logic).
3. **Presence dots:** derived map (§9, D3): DM lane unread>0 → amber "notification";
   agent running → green; else gray. Pure function in `model.ts`.
4. **"Agent working…":** shown under the lane's latest row when the newest envelope is
   addressed TO the agent (not from them), that agent is running, and the envelope is <10 min
   old; clears the moment any envelope from that agent lands. Pure function in `model.ts`;
   same predicate feeds the DM right-rail "Working…" badge (§9, D6).
5. **Composer send (record-first):** Enter sends (Shift+Enter = newline), `POST
   /api/user/messages {to: room.id | '#team' | agentName, delivery:'normal', body}`. The ws
   echo upserts the row (no optimistic row needed — the envelope broadcast is fast, and the
   old tab already relies on it). Draft persists per keystroke (`saveDraft`); "Draft saved"
   label shows when a draft exists and field untouched for 1s; `clearDraft` on success.
   Error surface: inline line above the box (404 shows the server's roster hint; 502 shows the
   honest delivery failure). Send button disabled when empty/sending.
6. **Right-rail tabs:** local state per conversation kind; DM defaults to Tasks; switching is
   instant. Tab choice not persisted (§9, D7).
7. **Hover/focus (none authored — assumption A1):** transparent rows hover to
   `--msg-bg-control` (#1b1b1e); focus-visible gets a 1px `--msg-amber` outline ring;
   pressed rows get `--msg-bg-selected`. All color/bg transitions 150ms ease; tab underline
   slides 200ms. (Faster than the studio's 450/700ms house speed — messaging is a
   high-frequency surface; flagged for veto.)
8. **Responsive:** ≤1200px hide context rail; ≤800px hide left rail (a ghost rail-toggle
   button appears in the thread header). Matches the spirit of the storyboard's
   tablet/mobile overrides without its miniature assumptions (§9, A2).
9. **Attention engine:** `MessagesView` keeps calling
   `updateAttentionQueue(buildAttentionQueue(null, feed, dismissed))` on feed change so the
   app-wide amber engine is unaffected. The gold/settling row treatment is NOT ported into the
   new visuals — the storyboard uses amber freely (badges, dots, working labels), superseding
   the one-amber law **inside this tab only** (§9, D8).
10. **Delegation card / reply context:** envelope has `threadId?` but no reply graph. Components
    are built and render only when data exists (`threadId` set → reply context line). Delegation
    card ships dormant (no backend source) behind a `delegation` prop — rendered only if a
    future envelope metadata supplies it. If this feels like dead code, cut it — see §9, D9.

---

## 7. Wiring (component → contract)

| Component | Reads | Writes |
|---|---|---|
| `MessagesView` | `useTunnelFeed()` (GET `/api/messages` + ws `message-envelope`), `useTunnelRooms()` (GET `/api/rooms` + ws `rooms-changed`), `useReadCursors()`, `agents` prop (GET `/api/agents` + ws `agents-changed`, via shell) | — |
| `RoomsRail` | `buildConversations(feed, rooms, roster)`; rooms→MISSION ROOMS (`#team` pinned first), dms→DIRECT MESSAGES; unread map; presence from `liveRoster(agents)` + unread | `POST /api/user/rooms` (New room, same picker logic as today, restyled) |
| `MessageFeed` | `messagesFor(feed, selectedId)`; `MarkdownText`/`MentionText` for bodies; `formatChatTime` for timestamps; day-pill grouping by local date | `advanceCursor(lane, createdAt)` on genuine visibility; `saveAnchor`/`anchorFor` for scroll seat |
| `ComposerBar` | `loadDraft(conversation.id)` | `POST /api/user/messages`; `saveDraft`/`clearDraft` |
| `ContextPanel` | Summary: failed envelopes in lane (`status==='failed'` → Notifications), running members (→ Current); Stats: derived counts from `messagesFor`; Tasks/Settings: placeholders | "Review" button scrolls the thread to the failed row (DOM id anchor) |

Citations: REST shapes `src/backend/messaging/index.ts:84-241`; envelope `types.ts:5-14`;
ws routing `lib/agentSocket/index.ts:96-128`; lane math `lib/tunnelModel/index.ts:83-166`;
cursor rules `lib/readCursor/index.ts:1-40`; send path today `tunnel/index.tsx:140-144`.

---

## 8. Task breakdown (one commit per task; gates after each)

Gates for every task: `npx tsc --noEmit` clean · `npm run lint` ≤ baseline 201 · new
`*.test.ts` green via `npx tsx` · no edits outside the files listed.

**Task 1 — Tokens + shell + rail (scenes' left third).**
Files: `messages/tokens.css`, `messages/index.tsx`, `messages/index.css`, `messages/model.ts`,
`messages/model.test.ts`, `messages/rail/index.tsx`, `messages/rail/index.css`.
Build: token block; 3-rail grid shell; `MessagesView` rewired to libs (feed/rooms/cursors/
roster/selection); `RoomsRail` with section headers, RoomItem (selected fill + badge),
RailPersonItem (avatar/name/role/presence), "All" tab bar + ghost icon, New-room picker
(restyle existing logic). Center/context render temporary empty states.
Acceptance: tab renders real rooms/DMs with live unread badges + presence dots; selection
persists across reload; model tests cover section split, presence map, badge counts; gates green.

**Task 2 — Center thread.**
Files: `messages/thread/index.tsx`, `messages/thread/index.css`.
Build: `MessageFeed` — day pill, `MessageRow` (avatar square, name+role, body, timestamp),
reply-context line when `threadId` present, "Agent working…" label (model predicate), ported
scroll-anchor + cursor-advance logic, markdown/mention bodies, empty state.
Acceptance: history loads per lane, live envelopes append in time order, unread clears only on
genuine visibility, scroll seat restores per lane, working label appears/clears per the §6.4
rule (unit-tested in model.test.ts); gates green.

**Task 3 — Composer.**
Files: `messages/composer/index.tsx`, `messages/composer/index.css`.
Build: `ComposerBar` — drag handle, channel line (`# name` / `@ name`), textarea with hint,
footer ("Draft saved" + send button), Enter-to-send, record-first POST, error line (404 roster
hint / 502 honest failure), per-lane drafts.
Acceptance: send lands in the log and renders via ws echo (verify against a live backend with
`tools/browse`); draft survives reload; error paths render the server messages; gates green.

**Task 4 — Right rail (Summary + person context).**
Files: `messages/context/index.tsx`, `messages/context/index.css`.
Build: tab bar (Summary | person Tasks/Stats/Settings), Summary sections (Notifications from
failed sends with working "Review" scroll-target; Recap derived notes; Current = running
members; Tasks placeholder checklist; Artefacts/Links hidden when empty), PersonView header
(name/role/Working badge), Tasks placeholder, Stats with real `StatRow` counts
(sent/received/delivered/failed in lane), Settings placeholder.
Acceptance: both scene variants reachable by selecting a room vs a DM; all real-data sections
show live data; placeholders are visually finished (not TODO text); gates green.

**Task 5 — States, motion, responsive.**
Files: edits to the four css files + `messages/index.tsx` (rail toggle).
Build: hover/focus/pressed per §6.7, 150/200ms transitions, focus-visible rings, ≤1200px and
≤800px collapses with rail-toggle button, aria labels (`aria-current`, person-row labels per
spec-notes), keyboard tab order check.
Acceptance: full keyboard traversal of rail→thread→composer→context; collapse/expand works;
gates green.

**Task 6 — Browser verification + pixel pass.**
Serve the spec: `python3 -m http.server 3040 --directory <spec-dir>` (or copy
`reference-export.html` into `docs/` for the existing `prototype:messaging` script). Drive the
real app on 3030 with `tools/browse --shared`: seed a conversation (spawn or fake via REST),
screenshot both scenes, compare against `reference-export.html` and the two vision PNGs; fix
visual deltas; run `npm run build`.
Acceptance: screenshots attached to the commit message or `docs/plans/` evidence note; both
scene variants verified in a real browser; all gates green. **UI work is not done until driven
in a browser.**

---

## 9. ASSUMPTIONS (every taste call — veto list)

- **A1 (hovers/timings):** hover = #1b1b1e fill on transparent rows; pressed = #232225;
  focus-visible = 1px amber ring; transitions 150ms (color/bg) and 200ms (tab underline) —
  NOT the studio's 450/700ms.
- **A2 (responsive):** real breakpoints 1200px (hide context) / 800px (hide rail + toggle)
  instead of the storyboard's 768/390 miniature overrides.
- **D1 (density):** real density, typography ×1.3, metrics ×1.2, rails unchanged — owner
  taste-checks on dev server; veto = one-file edit in `tokens.css`.
- **D2 (TEAMS section):** no backend "team" concept. Default: section renders ONLY if the
  selected project has threads; rows are inert labels (CSS folder icon + thread title).
  Alternatives: hide entirely, or map to something else — owner call.
- **D3 (presence):** invented mapping — DM unread>0 → amber "notification" dot; agent
  `status==='running'` → green; otherwise gray. No backend presence exists.
- **D4 (dual highlight):** scene 2's "active room, no fill" variant dropped; single selection.
- **D5 (theming):** tab pins storyboard dark tokens scoped to `.msg-view`, ignoring the app
  theme switcher (storyboard is a fixed dark vision).
- **D6 ("Agent working…"):** heuristic in §6.4 (latest envelope TO the agent + agent running +
  <10 min old) — there is no real working signal in the protocol.
- **D7 (tab persistence):** right-rail tab choice is ephemeral (per mount), defaults Tasks.
- **D8 (amber law):** storyboard's free use of amber supersedes the one-amber calm grammar
  inside this tab only; the app-wide attention engine still runs (queue updates kept).
- **D9 (delegation card):** ships dormant (no data source); cut on request.
- **D10 (placeholders):** Stats shows REAL derived counts (not dummy numbers); Tasks and
  Settings render designed-looking empty states ("Nothing here yet" style), never lorem.
- **D11 (font):** keep the app's existing Google Fonts Inter `@import` rather than bundling
  Inter; offline dev without network falls back to system-ui (acceptable?).

## 9b. ASSUMPTIONS added during the build (2026-07-19, builder)

- **D1′ (density-as-data, OWNER-LOCKED, supersedes D1):** density is a typed setting, not
  fixed values — `MessagingTabSettings { density: 'low'|'normal'|'high' }` in
  `messages/model.ts` with `DENSITY_SCALE = { low: 1.0, normal: 1.3, high: 1.7 }`.
  `MessagesView` writes the factor onto `.msg-view` as `--msg-scale` (via `setProperty`,
  inline `style=` is lint-banned); every size token in `tokens.css` is
  `calc(spec px × var(--msg-scale))`. One knob rescales the whole tab; swapping
  `MESSAGING_SETTINGS` to an app store later is a one-line change. Default: `normal`.
- **D2′ (TEAMS, OWNER-LOCKED, supersedes D2):** section hidden entirely.
- **D9′ (delegation card):** CUT, not shipped dormant (D9's own "cut it" option) — no data
  source, and dead code fights the change-easy philosophy. Reply context kept (real data:
  `envelope.threadId` → "↳ Replying to <name>", only when the parent envelope is known).
- **A12 (test placement):** `messages/tests/model.test.ts`, not the plan's
  `messages/model.test.ts` — the structural lint rule (max 2 code files/dir) forbids
  `index.tsx + model.ts + model.test.ts` in one directory.
- **A13 (shared chrome CSS):** tab bars, ghost glyph button, section headers live in the
  shell `messages/index.css` (single source used by both rails) — per-module duplication
  would fight the one-place-to-change rule. Everything else stays per-module.
- **A14 (timestamps):** `formatClockTime` (HH:MM 24h, in `model.ts`) for the storyboard's
  "12:41" look, not `formatChatTime`'s locale am/pm.
- **A15 (Review semantics):** right-rail "Review" = scroll the thread to the failed row
  (DOM id `msg-row-<envelopeId>`) AND dismiss the failed message's attention item. The
  notification row itself persists — the failed envelope is honest history.
- **A16 (context collapse):** the storyboard's ghost icon button in the context tab bar
  collapses the rail; a floating ghost button at the thread's top-right reopens it. The
  rail header's ghost button opens the new-room picker.
- **A17 (phone topbar):** at ≤800px a thread topbar appears (rail toggle + current lane
  label); selecting a lane dismisses the rail overlay.
- **A18 (honest status labels):** failed envelopes carry an amber "Delivery failed" label
  and queued ones a dim "Sending…" — the storyboard has no status grammar, but a silent
  failure is worse than a net-new label.
- **A19 (#team auto-read on first visit):** pre-existing app semantics (freshest lane
  auto-opens; `#team` is the only lane before history loads, so it self-reads on a truly
  fresh browser). Kept as-is from the old messenger — not a rebuild regression.

## 10. Owner decisions needed BEFORE building

1. **Density** (D1): approve ×1.3/×1.2 real-density mapping, or pixel-match the miniature.
2. **TEAMS** (D2): inert thread labels, hide the section, or another mapping.
3. **Amber law** (D8): confirm the storyboard's amber-everywhere wins inside the tab.
4. **Presence invention** (D3): approve the unread/running/exited → amber/green/gray mapping.
5. **Placeholders** (D10): confirm Stats = real counts, Tasks/Settings = designed empties.

---

## BUILD EVIDENCE (2026-07-19 — all 6 tasks landed, gates green per task)

Commits (branch `kimi/messaging-ui`, worktree `Novakai-Command-kimi-messaging-ui`):

- `97cf4cf6` task 1 — tokens.css (density-as-data --msg-* vars), model.ts + tests, RoomsRail, shell grid
- `8fd4da5c` task 2 — MessageFeed (day pills, rows, reply context, working label, ported scroll/cursor)
- `05e5c6ab` task 3 — ComposerBar (record-first send, per-lane drafts, error line)
- `ce900d4b` task 4 — ContextPanel (Summary + person Tasks/Stats/Settings, shared chrome)
- `1ff365dd` task 5 — pressed states, phone topbar + rail overlay
- (task 6 commit adds this note; screenshots live outside the repo)

Verified in a real browser (playwright, `tools/browse` + ad-hoc scripts) against the live
backend on :3030/:3031 with seeded rooms/messages: room view, DM view, Stats tab,
send happy path (ws echo), send failure path (404 roster hint + in-row "Delivery failed"),
Review scroll, new-room picker (correctly empty with no live agents), 1100px + 700px
responsive. Screenshots: `/Users/christopherdasca/Documents/kimi/workspace/messaging-ui-review/`
(scene-1-room-summary.png, scene-2-dm-tasks.png, scene-2-dm-stats.png,
scene-2-dm-settings.png, msg-error.png, msg-responsive-*.png).

Not verified visually (no provider CLIs on this machine → no live agents): green presence
dot, "Agent working…" thread label, "Working…" person badge. All three ride the same
`workingAgentFor` / `presenceToneFor` predicates, unit-tested in `messages/tests/model.test.ts`.
