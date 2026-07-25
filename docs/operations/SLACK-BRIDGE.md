# Slack Bridge (`scripts/nvk-slack-bridge.mjs`)

A two-way lane between chris's Slack DM with the bridge bot and the
messagingV2 capability's human principal. Unlike
[`nvk-slack-mirror.mjs`](SLACK-MIRROR.md) (read-only journal → channel), the
bridge is conversational: chris can answer agents from Slack, from a thread.

## What it does

- **Agent → Slack.** Subscribes to the capability live feed exactly like the
  browser feed (`messaging-v2-sub` on `/ws`, cursor resume, ended → backoff +
  refetch + resubscribe). A message in chris's DM with an agent posts into the
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
  persist to `.novakai-command/slack-bridge-state.json` (gitignored) after
  every frame; a restarted daemon resumes from `s_<cursor>` and never
  double-posts. App down → backoff resubscribe (500 ms → 8 s, the
  agentSocket/feed rhythm), logged loudly, never a crash. Slack post failure →
  one retry after 5 s, then drop + log (mirror precedent).

## Setup

1. Create a Slack app at https://api.slack.com/apps (from scratch).
2. **Socket Mode**: Settings → Socket Mode → enable. This prompts for an
   app-level token with the `connections:write` scope — copy the `xapp-…`
   token.
3. **Bot scopes**: Features → OAuth & Permissions → Bot Token Scopes —
   add `chat:write`, `im:read`, `im:write`, `im:history`, `users:read.email`.
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

Open a DM with the bot in Slack. `@fable hello` starts a lane; after that,
answer in the agent's thread.

Config precedence: env tokens → `.novakai-command/slack-bridge.json`. State
(independently of config) always lives in
`.novakai-command/slack-bridge-state.json`. Advanced overrides, mainly for the
test harness: `NVK_SLACK_BRIDGE_APP_BASE` (default `http://localhost:3131`),
`NVK_SLACK_API_BASE`, `NVK_SLACK_BRIDGE_CONFIG`, `NVK_SLACK_BRIDGE_STATE`.

## Tests

```sh
node scripts/nvk-slack-bridge.test.mjs
```

Fake Slack (Web API HTTP + Socket Mode ws) and a fake app backend prove the
post shape, the send body, all three echo guards, restart resume without
double-posting, and the unknown-thread guidance.

## Limitations (v0)

- DMs only — no rooms/channels (`#team` traffic stays app-side).
- Edits and deletes are ignored (subtype events dropped).
- One human lane: only chris's Slack user id is bridged.
- A failed-delivery notice needs the original message's Slack ts, held in
  memory — a failure arriving after a daemon restart for a pre-restart
  message is logged and skipped, not posted.
- Agent display names derive from the live roster broadcast (the same
  personId→name derivation debt the frontend records); an agent unknown to
  the roster posts under its raw personId.
