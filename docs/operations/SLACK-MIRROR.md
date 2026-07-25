# Slack Mirror (`scripts/nvk-slack-mirror.mjs`)

A read-only, one-way mirror of team messaging into a Slack channel via an
Incoming Webhook. Since N5 (D-N5-2) the mirror is a **client of the messaging
capability** — there is no journal-file tail and no `--file` flag. It never
writes to the backend or any agent state.

**Server dependency:** the mirror needs a running backend
(`NVK_COMMAND_URL`, default `http://127.0.0.1:3031`; `--server <url>`
overrides). Backlog reads ride the server-owned `/api/messaging/v2/user/*`
routes; live events ride the browser dialect (`messaging-v2-sub` over `/ws`,
MessageCommitted + DeliveryUpdated) — the same trust boundary as the
Messages tab, so no token is needed.

## What it does

- Posts one Slack message per committed message:
  `🦊 *from* → 📣 *#to* · 11:42` + body (truncated at ~500 chars).
- Terminal delivery failures post as a short status line:
  `✗ msg_… → *failed* (sender → lane, 11:42)` — red-coded, never a repost of
  the body. A failure whose original message left the local cache attributes
  to a neutral `unknown` sender, never to chris (F7).
- Roster names and lane labels come from the server and re-resolve every
  5 min (renames / new lanes pick up without a restart, F7). DM lanes
  without a server label fall back to the raw threadId (accepted debt).
- Reconnects with 500 ms → 8 s backoff, resuming the subscription from the
  last seen sequence cursor (`s_<n>`) — at-least-once; dedupe is by id
  (in-memory, bounded at 5000 entries; a very late amendment for an evicted
  id can re-post once).
- On Slack HTTP failure: retries once after 5 s, then logs and continues.
- Posts are spaced ~1.1 s apart (Slack webhooks allow ~1 msg/sec).

## Setup

1. Create a Slack channel (e.g. `#novakai-journal`).
2. Create an Incoming Webhook: https://api.slack.com/apps → your app →
   **Incoming Webhooks** → **Add New Webhook to Workspace** → pick the
   channel → copy the `https://hooks.slack.com/services/…` URL.
3. Give the mirror the URL — either:
   - env var (wins): `export NVK_SLACK_WEBHOOK_URL="https://hooks.slack.com/services/…"`
   - or config file: `cp .novakai-command/slack-mirror.example.json
     .novakai-command/slack-mirror.json` and paste the URL in.
     (`slack-mirror.json` is gitignored.)

## Run

```sh
node scripts/nvk-slack-mirror.mjs --backlog 20     # post last 20 messages, then follow live
node scripts/nvk-slack-mirror.mjs --backlog 0      # LIVE ONLY — cursor seeds at the current
                                                   # tip, history never replays (F5)
node scripts/nvk-slack-mirror.mjs --verbose        # log each post
```

Plain foreground process; Ctrl-C stops it.

## Test without a webhook

```sh
node scripts/nvk-slack-mirror.mjs --dry-run --backlog 5
```

`--dry-run` prints formatted messages to stdout instead of posting.

## Visual language

- **New messages** lead with an **inline emoji pair in the text header** —
  `🦊 *Fable* → 👤 *chris* · 12:47` — sender emoji + recipient emoji. This is
  the primary visual channel: it always renders, even when the Slack app
  overrides webhook username/avatar. Secondary channels: Slack `username` is
  the sender name, `icon_emoji` the sender emoji, and the attachment sidebar
  uses a muted per-sender color (deterministic FNV-1a hash of the sender name
  over a 12-color muted palette — stable across restarts).
- **Known-actor emoji** (loose case-insensitive substring match):
  fable 🦊 · scribe 📜 · watchdog 🐶 · chief 🎖️ · chris 👤 · manager 🧭 ·
  kimi 🌙 · claude 🎻. Unknown senders get a stable pick from
  🤖🛰️📡🧪🦉🐙🌿🔧📐🧵 via the same name hash. Recipients use the same
  mapping, with two special cases: channels (`#team`) 📣 and rooms 🏠.
- **Status semantics win over sender color:** failed amendments are muted red
  `#B05A5A`, other amendments grey `#9E9E9E`. Sender colors apply to new
  messages only. (The `⚠ partial` formatter branch has no caller: the
  capability has no partial delivery state — F10 debt.)

## Known limitations

- A burst of messages trickles into Slack over seconds (~1.1 s pacing).
- Status lines are follow-up messages, not edits of the original Slack post
  (Incoming Webhooks can't edit).
- Restarting with `--backlog N` re-posts those N messages (seen-id tracking
  is in-memory only).
- One-way: nothing typed in Slack reaches the capability (the N7 two-way
  bridge grows out of `scripts/team/capabilityClient.mjs`).
