# Slack Bridge (`scripts/nvk-slack-bridge.mjs`)

A two-way lane between chris's Slack DM with the bridge bot and the
messagingV2 capability's human principal. Unlike
[`nvk-slack-mirror.mjs`](SLACK-MIRROR.md) (read-only journal → channel), the
bridge is conversational: chris can answer agents from Slack, from a thread.

**N7 (D-BRIDGE-1): the v0 bridge is generalized IN PLACE** — one Slack
channel ↔ one room Thread joins the DM lanes, same daemon, same transports
(D-N7-1: it stays a CLIENT of Messaging over the browser dialect + user
routes; the DEC-17 door is unnecessary for a co-located launchd daemon). The
one-way mirror stays untouched.

## What it does

- **Agent → Slack.** Subscribes to the capability live feed exactly like the
  browser feed (`messaging-v2-sub` on `/ws`, cursor resume, ended → backoff +
  refetch + resubscribe; the refetch collects all threads and bridges in
  global journal order). A message in chris's DM with an agent posts into the
  Slack DM with the bot: one root per agent DM thread — `*agentName* · HH:MM`
  then the body verbatim — follow-ups land as Slack thread replies. A failed
  delivery posts a short `⚠ delivery failed` reply. Chris's own app-side
  messages are never bridged (any lane).
- **Rooms → Slack channel (D-N7-3).** A message on a MAPPED room Thread
  posts TOP-LEVEL in the mapped Slack channel with the same
  `*agentName* · HH:MM` header (identity stamped from the roster, never
  message text) and the echo-guard tag. Bodies over the 32 KiB contract cap
  are chunked with `(1/3)`-style markers (D-N7-6).
- **Slack channel → room (D-N7-4).** chris's message on a MAPPED channel
  posts to the room via `POST /api/messaging/v2/user/send {to:'#<label>'}` as
  the human; Slack-thread replies bridge identically (the room is linear).
  **Channel inbound is OWNER-ONLY**: every non-chris Slack user drops with
  ONE loud log line — `/user/send` always speaks as the human principal, so
  bridging another user would stamp chris's name on their words (external
  principals arrive at N8). An unmapped channel drops with a vlog. Oversized
  inbound bodies get a posted "too big to bridge" note, never a failed send
  (D-N7-6).
- **Slack → agent (DM lane).** chris's reply in a Slack thread goes to that
  thread's agent via `POST /api/messaging/v2/user/send` (`{to, body}` — the
  same server-owned trust boundary the browser uses; no auth on localhost). A
  top-level `@agentName some text` opens a DM to that agent. A reply in a
  thread the bridge never created gets the Slack-side guidance
  `unknown thread — start with @agentName`. A failed send (e.g. unknown
  agent) is answered honestly in Slack with the route's error + roster hint.
- **Edits/deletes → notes (D-N7-6).** `message_changed`/`message_deleted`
  become follow-up NOTES in the app lane (`[edited on Slack] <new text>` /
  `[deleted on Slack]`) — history is immutable; the note is a NEW message,
  never a mutation.
- **Echo-safe (D-N7-5).** Every outbound post carries a Slack `metadata` tag
  (`nvk_slack_bridge`); inbound events are dropped when they carry the tag,
  any `bot_id`, or the bot's own user id (from `auth.test` at boot). The
  daemon's own posts can never re-enter the capability — in either lane.
- **Rate limits (D-N7-6).** Slack 429s are honored via `Retry-After` (plus
  jitter) with bounded retries; the final drop is loud.
- **Restart-safe.** The live cursor and the Slack-thread-ts ↔ agent maps
  persist to `.novakai-command/slack-bridge-state.json` (gitignored). The
  cursor advances only AFTER the Slack post lands — a failed post is left
  behind for the server's at-least-once replay, never silently skipped. The
  agent map keys threads by stable personId and resolves the display name at
  forward time, so an agent rename never strands a thread (the roster is
  `GET /api/agents` at boot/refresh plus the `agents-changed` broadcast,
  which the real server sends only on launch/exit/rename — never on
  connect). App down → backoff resubscribe (500 ms → 8 s, the
  agentSocket/feed rhythm), logged loudly, never a crash.
- **Health (D-N7-7).** The state file carries a `health` block
  (`updatedAt`, retry counts, `lastError`, `lastBridgedAt`) served at
  `GET /api/agents/slack-bridge/health` — 404 when the file is absent, 503
  when `updatedAt` is older than 5 minutes (bridge down or wedged).
- **Liveness + dedupe.** Both sockets ping every 30 s; a socket that misses
  its pong is terminated and reconnected (no silent zombies). Slack events
  are deduped on `channel:ts` (bounded), so a redelivery after a lost ack
  reaches the capability exactly once. Capability messages are deduped by id
  and by the resume cursor.

## Setup

1. Create a Slack app at https://api.slack.com/apps (from scratch).
2. **Socket Mode**: Settings → Socket Mode → enable. This prompts for an
   app-level token with the `connections:write` scope — copy the `xapp-…`
   token.
3. **Bot scopes**: Features → OAuth & Permissions → Bot Token Scopes —
   add `chat:write`, `im:read`, `im:write`, `users:read.email`. The N7
   channel lane also needs the channel events (`message.channels`) and
   `users:read` (mention decode); channel operations (creating the channel,
   inviting the bot) are workspace click-work, not code.
4. **Events**: Features → Event Subscriptions → enable, Subscribe to bot
   events → add `message.im` and `message.channels` (no Request URL needed
   under Socket Mode).
5. **Install** the app to the workspace (OAuth & Permissions → Install) and
   copy the `xoxb-…` bot token.
6. Configure the bridge — env vars win:
   ```sh
   export NVK_SLACK_BOT_TOKEN="xoxb-…"
   export NVK_SLACK_APP_TOKEN="xapp-…"
   ```
   or the config file (gitignored):
   ```sh
   cp .novakai-command/slack-bridge.example.json .novakai-command/slack-bridge.json
   ```
   `chrisUserId` (Slack member id, `U…`) is resolved from the config; if
   absent, `chrisEmail` is resolved once at boot via `users.lookupByEmail`.
   `channels` maps Slack channel ids to room labels (resolved at boot —
   **absent/empty keeps the channel code dormant, DM lanes unaffected**).

## Run

```sh
npm run dev                                # the app on :3131, as usual
node scripts/nvk-slack-bridge.mjs          # foreground; Ctrl-C stops
node scripts/nvk-slack-bridge.mjs --verbose
node scripts/nvk-slack-bridge.mjs --dry-run   # Slack posts print to stdout; inbound off
```

Open a DM with the bot in Slack. `@fable hello` starts a lane — multi-word
titles work too (`@Manager Kimi Messages hello`): the mention longest-matches
the live roster titles, case-insensitive. After that, answer in the agent's
thread. With `channels` configured, the mapped room flows both ways in the
channel.

## Service (launchd)

Production runs as `com.novakai.slackbridge` (plist:
`scripts/com.novakai.slackbridge.plist`, installed to
`~/Library/LaunchAgents/`): KeepAlive, `NVK_SLACK_BRIDGE_APP_BASE` pinned to
the Live serve (`http://localhost:3030`), logs to `/tmp/nvk-slack-bridge.log`.
Config (`.novakai-command/slack-bridge.json`, chmod 600) and cursor state live
in the MAIN repo — the daemon survives terminal sessions and reboots.

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.novakai.slackbridge.plist
launchctl kickstart -k gui/$(id -u)/com.novakai.slackbridge   # restart
launchctl bootout gui/$(id -u)/com.novakai.slackbridge        # stop
```

Config precedence: env tokens → `.novakai-command/slack-bridge.json`. State
(independently of config) always lives in
`.novakai-command/slack-bridge-state.json`. Advanced overrides, mainly for the
test harness: `NVK_SLACK_BRIDGE_APP_BASE` (default `http://localhost:3131`),
`NVK_SLACK_API_BASE`, `NVK_SLACK_BRIDGE_CONFIG`, `NVK_SLACK_BRIDGE_STATE`,
`NVK_SLACK_BRIDGE_RETRY_MS` (Slack post retry delay, default 5000),
`NVK_SLACK_BRIDGE_PING_MS` (heartbeat interval, default 30000).

## Tests

```sh
node scripts/nvk-slack-bridge.test.mjs
```

Fake Slack (Web API HTTP + Socket Mode ws) and a fake app backend prove the
post shape, the send body, all three echo guards, restart resume without
double-posting, and the unknown-thread guidance — plus the law-#6 audit
regressions: cross-thread refetch ordering, roster-at-boot (the fake, like
the real server, never pushes `agents-changed` on connect), one Slack root
under concurrent frames, cursor-after-post failure semantics, Slack
redelivery dedupe, heartbeat zombie reconnect, mrkdwn decode, and rename
routing. N7 adds: room outbound shape (top-level, header + tag), mapped and
unmapped channels, owner-only inbound with the one-loud-line N8 drop, the channel
loop hunt (tag/bot/redelivery/human-echo), edit/delete follow-up notes,
32 KiB chunking markers, the too-big note, 429 Retry-After, mention decode,
and the health block. The fakes serve `GET /api/agents`, a `users.info`
endpoint, a 429 injector, and a seedable `/user/messages` store so the
ended→refetch path is exercised for real.

## Text fidelity

- **Inbound** (Slack → app): `&amp;`/`&lt;`/`&gt;` are unescaped,
  `<url|label>` links expand to `label (url)`, and `<@U…>` mentions decode
  to a display name via `users.info` (bounded cache).
- **Outbound** (app → Slack): bodies are posted as-is with Slack mrkdwn
  enabled (the `*agentName*` header needs it). An agent body that happens to
  contain mrkdwn (`*`, `_`, `` ` ``) may render formatted in Slack — accepted
  for v0; the alternative (`mrkdwn: false`) would plain-text the header too.

## Limitations

- **No Slack-side catch-up**: Socket Mode delivers events only while the
  daemon is connected; messages chris sends in the DM while the daemon is
  down are not replayed (the app inbox remains the source of truth). This is
  why `im:history` is deliberately NOT in the scope list — no
  `conversations.history` path exists to justify it.
- A failed-delivery notice needs the original message's Slack ts, held in
  memory — a failure arriving after a daemon restart for a pre-restart
  message is logged and skipped, not posted.
- Agent display names resolve from the runtime roster (`GET /api/agents`,
  which includes exited agents) plus the people the capability threads
  reference. An agent the roster has never known posts under its raw
  personId, and a reply to such a thread 404s honestly with the route's
  roster hint.
- Channel ops (creating the channel, inviting the bot, flipping the scopes)
  are workspace click-work; the code treats them as runtime config, never a
  boot requirement (`conversations.list` is NOT available to this app —
  probed 2026-07-26 — so the channel map is config-driven, not discovered).

## Setup

1. Create a Slack app at https://api.slack.com/apps (from scratch).
2. **Socket Mode**: Settings → Socket Mode → enable. This prompts for an
   app-level token with the `connections:write` scope — copy the `xapp-…`
   token.
3. **Bot scopes**: Features → OAuth & Permissions → Bot Token Scopes —
   add `chat:write`, `im:read`, `im:write`, `users:read.email`.
4. **Events**: Features → Event Subscriptions → enable, Subscribe to bot
   events → add `message.im` (no Request URL needed under Socket Mode).
5. **Install** the app to the workspace (OAuth & Permissions → Install) and
   copy the `xoxb-…` bot token.
6. Configure the bridge — env vars win:
   ```sh
   export NVK_SLACK_BOT_TOKEN="xoxb-…"
   export NVK_SLACK_APP_TOKEN="xapp-…"
   ```
   or the config file (gitignored):
   ```sh
   cp .novakai-command/slack-bridge.example.json .novakai-command/slack-bridge.json
   ```
   `chrisUserId` (Slack member id, `U…`) is resolved from the config; if
   absent, `chrisEmail` is resolved once at boot via `users.lookupByEmail`.

## Run

```sh
npm run dev                                # the app on :3131, as usual
node scripts/nvk-slack-bridge.mjs          # foreground; Ctrl-C stops
node scripts/nvk-slack-bridge.mjs --verbose
node scripts/nvk-slack-bridge.mjs --dry-run   # Slack posts print to stdout; inbound off
```

Open a DM with the bot in Slack. `@fable hello` starts a lane — multi-word
titles work too (`@Manager Kimi Messages hello`): the mention longest-matches
the live roster titles, case-insensitive. After that, answer in the agent's
thread.

## Service (launchd)

Production runs as `com.novakai.slackbridge` (plist:
`scripts/com.novakai.slackbridge.plist`, installed to
`~/Library/LaunchAgents/`): KeepAlive, `NVK_SLACK_BRIDGE_APP_BASE` pinned to
the Live serve (`http://localhost:3030`), logs to `/tmp/nvk-slack-bridge.log`.
Config (`.novakai-command/slack-bridge.json`, chmod 600) and cursor state live
in the MAIN repo — the daemon survives terminal sessions and reboots.

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.novakai.slackbridge.plist
launchctl kickstart -k gui/$(id -u)/com.novakai.slackbridge   # restart
launchctl bootout gui/$(id -u)/com.novakai.slackbridge        # stop
```

Config precedence: env tokens → `.novakai-command/slack-bridge.json`. State
(independently of config) always lives in
`.novakai-command/slack-bridge-state.json`. Advanced overrides, mainly for the
test harness: `NVK_SLACK_BRIDGE_APP_BASE` (default `http://localhost:3131`),
`NVK_SLACK_API_BASE`, `NVK_SLACK_BRIDGE_CONFIG`, `NVK_SLACK_BRIDGE_STATE`,
`NVK_SLACK_BRIDGE_RETRY_MS` (Slack post retry delay, default 5000),
`NVK_SLACK_BRIDGE_PING_MS` (heartbeat interval, default 30000).

## Tests

```sh
node scripts/nvk-slack-bridge.test.mjs
```

Fake Slack (Web API HTTP + Socket Mode ws) and a fake app backend prove the
post shape, the send body, all three echo guards, restart resume without
double-posting, and the unknown-thread guidance — plus the law-#6 audit
regressions: cross-thread refetch ordering, roster-at-boot (the fake, like
the real server, never pushes `agents-changed` on connect), one Slack root
under concurrent frames, cursor-after-post failure semantics, Slack
redelivery dedupe, heartbeat zombie reconnect, mrkdwn decode, and rename
routing. The fakes serve `GET /api/agents` and a seedable
`/user/messages` store so the ended→refetch path is exercised for real.

## Text fidelity

- **Inbound** (Slack → app): `&amp;`/`&lt;`/`&gt;` are unescaped and
  `<url|label>` links expand to `label (url)` before forwarding.
- **Outbound** (app → Slack): bodies are posted as-is with Slack mrkdwn
  enabled (the `*agentName*` header needs it). An agent body that happens to
  contain mrkdwn (`*`, `_`, `` ` ``) may render formatted in Slack — accepted
  for v0; the alternative (`mrkdwn: false`) would plain-text the header too.

- **No Slack-side catch-up**: Socket Mode delivers events only while the
  daemon is connected; messages chris sends in the DM while the daemon is
  down are not replayed (the app inbox remains the source of truth). This is
  why `im:history` is deliberately NOT in the scope list — no
  `conversations.history` path exists to justify it.
- A failed-delivery notice needs the original message's Slack ts, held in
  memory — a failure arriving after a daemon restart for a pre-restart
  message is logged and skipped, not posted.
- Agent display names resolve from the runtime roster (`GET /api/agents`,
  which includes exited agents) plus the people the capability threads
  reference. An agent the roster has never known posts under its raw
  personId, and a reply to such a thread 404s honestly with the route's
  roster hint.
