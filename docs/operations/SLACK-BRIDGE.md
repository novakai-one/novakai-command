# Slack Bridge (`scripts/nvk-slack-bridge.mjs`)

A two-way lane between chris's Slack DM with the bridge bot and the
messagingV2 capability's human principal. Unlike
[`nvk-slack-mirror.mjs`](SLACK-MIRROR.md) (read-only journal → channel), the
bridge is conversational: chris can answer agents from Slack, from a thread.

## What it does

- **Agent → Slack.** Subscribes to the capability live feed exactly like the
  browser feed (`messaging-v2-sub` on `/ws`, cursor resume, ended → backoff +
  refetch + resubscribe; the refetch collects all threads and bridges in
  global journal order). A message in chris's DM with an agent posts into the
  Slack DM with the bot: one root per agent DM thread — `*agentName* · HH:MM`
  then the body verbatim — follow-ups land as Slack thread replies. A failed
  delivery posts a short `⚠ delivery failed` reply. Chris's own app-side
  messages and room traffic are never bridged.
- **Slack → agent.** chris's reply in a Slack thread goes to that thread's
  agent via `POST /api/messaging/v2/user/send` (`{to, body}` — the same
  server-owned trust boundary the browser uses; no auth on localhost). A
  top-level `@agentName some text` opens a DM to that agent. A reply in a
  thread the bridge never created gets the Slack-side guidance
  `unknown thread — start with @agentName`. A failed send (e.g. unknown
  agent) is answered honestly in Slack with the route's error + roster hint.
- **Echo-safe.** Every outbound post carries a Slack `metadata` tag
  (`nvk_slack_bridge`); inbound events are dropped when they carry the tag,
  any `bot_id`, or the bot's own user id (from `auth.test` at boot). The
  daemon's own posts can never re-enter the capability.
- **Restart-safe.** The live cursor and the Slack-thread-ts ↔ agent maps
  persist to `.novakai-command/slack-bridge-state.json` (gitignored). The
  cursor advances only AFTER the Slack post lands — a failed post is left
  behind for the server's at-least-once replay, never silently skipped. The
  agent map keys threads by stable personId and resolves the display name at
  forward time, so an agent rename never strands a thread (the roster is
  `GET /api/agents` at boot/refresh plus the `agents-changed` broadcast,
  which the real server sends only on launch/exit/rename — never on
  connect). App down → backoff resubscribe (500 ms → 8 s, the
  agentSocket/feed rhythm), logged loudly, never a crash. Slack post failure →
  one retry after 5 s, then drop + log (mirror precedent).
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

## Limitations (v0)

- DMs only — no rooms/channels (`#team` traffic stays app-side).
- Edits and deletes are ignored (subtype events dropped).
- One human lane: only chris's Slack user id is bridged.
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
