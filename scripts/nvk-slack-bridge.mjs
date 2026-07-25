#!/usr/bin/env node
// nvk slack-bridge — two-way lane between chris's Slack DM with the bridge
// bot and the messagingV2 capability's human principal:
//
//   agent → chris DM in the app   → root/reply in the Slack DM (*agent* · HH:MM)
//   chris replies in a thread     → POST /api/messaging/v2/user/send {to: agent}
//   chris posts "@agent text"     → same route (opens the DM)
//
// Echo-safe: the daemon's own posts never re-enter the capability — guarded
// by auth.test's bot user id, Slack bot_id, AND a metadata tag on every post.
//
//   node scripts/nvk-slack-bridge.mjs [--verbose] [--dry-run]
//
// Tokens: env NVK_SLACK_BOT_TOKEN (xoxb) / NVK_SLACK_APP_TOKEN (xapp) win;
// fallback .novakai-command/slack-bridge.json
// ({botToken, appToken, chrisUserId?, chrisEmail?}). Never hardcoded.
// See docs/operations/SLACK-BRIDGE.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const VERBOSE = flag('--verbose');
const DRY_RUN = flag('--dry-run');

const CONFIG_FILE = process.env.NVK_SLACK_BRIDGE_CONFIG
  ?? path.join(ROOT, '.novakai-command', 'slack-bridge.json');
const STATE_FILE = process.env.NVK_SLACK_BRIDGE_STATE
  ?? path.join(ROOT, '.novakai-command', 'slack-bridge-state.json');
const APP_BASE = (process.env.NVK_SLACK_BRIDGE_APP_BASE ?? 'http://localhost:3131').replace(/\/$/, '');
const SLACK_API = (process.env.NVK_SLACK_API_BASE ?? 'https://slack.com/api').replace(/\/$/, '');

const HUMAN_PERSON_ID = 'person_user-chris'; // mirrors src/frontend/lib/messagingV2 (CHRIS)
const META_TAG = 'nvk_slack_bridge';         // Slack metadata event_type ([a-z0-9_], ≤30)
const RETRY_DELAY_MS = 5000;                 // Slack post retry (mirror precedent)
const POSTED_MAX = 5000;                     // bounded messageId → slackTs recall
const BACKOFF_BASE_MS = 500;                 // agentSocket/feed rhythm: 500ms → 8s
const BACKOFF_MAX_MS = 8_000;

const log = (...a) => console.log('[slack-bridge]', ...a);
const warn = (...a) => console.warn('[slack-bridge] WARN:', ...a);
const vlog = (...a) => { if (VERBOSE) log(...a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- config -------------------------------------------------------------------

function loadConfig() {
  let file = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (error) {
    warn(`could not read ${CONFIG_FILE}: ${error.message}`);
  }
  return {
    botToken: process.env.NVK_SLACK_BOT_TOKEN ?? file.botToken,
    appToken: process.env.NVK_SLACK_APP_TOKEN ?? file.appToken,
    chrisUserId: file.chrisUserId,
    chrisEmail: file.chrisEmail,
  };
}

const config = DRY_RUN
  ? { botToken: 'dry-run', appToken: 'dry-run', chrisUserId: 'U_DRY_RUN' }
  : loadConfig();

if (!config.botToken || !config.appToken) {
  console.error(`[slack-bridge] Slack tokens missing.

Set the env vars (they win):
  export NVK_SLACK_BOT_TOKEN="xoxb-…"
  export NVK_SLACK_APP_TOKEN="xapp-…"

or create the config file:
  cp .novakai-command/slack-bridge.example.json ${CONFIG_FILE}
  # then fill in botToken + appToken (+ chrisUserId or chrisEmail)

Create the Slack app per docs/operations/SLACK-BRIDGE.md
(Socket Mode + scopes chat:write im:read im:write im:history users:read.email,
app-level token with connections:write).`);
  process.exit(1);
}

// --- persisted state (cursor + thread maps) --------------------------------------

const state = { cursor: 0, roots: {}, agents: {} };
// cursor: last capability sequence bridged (resume is `s_<cursor>`).
// roots:  capability threadId → Slack root ts (one Slack thread per agent DM).
// agents: Slack root ts → agent display name (inbound thread routing).

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Number.isFinite(parsed.cursor)) state.cursor = parsed.cursor;
    if (parsed.roots && typeof parsed.roots === 'object') state.roots = parsed.roots;
    if (parsed.agents && typeof parsed.agents === 'object') state.agents = parsed.agents;
    vlog(`state loaded: cursor=${state.cursor}, ${Object.keys(state.roots).length} thread(s)`);
  } catch (error) {
    warn(`could not read ${STATE_FILE}: ${error.message} — starting fresh`);
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (error) {
    warn(`could not persist ${STATE_FILE}: ${error.message}`);
  }
}

/** Advance the at-least-once cursor; sequences at/below it are dupes. */
function advanceCursor(sequence) {
  if (!Number.isFinite(sequence) || sequence <= state.cursor) return false;
  state.cursor = sequence;
  saveState();
  return true;
}

// --- Slack Web API ------------------------------------------------------------

async function slackApi(method, { body, query, token } = {}) {
  const url = query === undefined ? `${SLACK_API}/${method}`
    : `${SLACK_API}/${method}?${new URLSearchParams(query)}`;
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token ?? config.botToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    throw new Error(`${method} failed: HTTP ${response.status} ${data.error ?? ''}`.trim());
  }
  return data;
}

/** Every outbound post carries the echo-guard metadata tag. */
async function postToSlack(payload) {
  const tagged = {
    ...payload,
    metadata: { event_type: META_TAG, event_payload: { bridge: 'v0' } },
  };
  if (DRY_RUN) {
    console.log(`[dry-run] ${tagged.thread_ts ? `↳(${tagged.thread_ts}) ` : ''}${tagged.text}`);
    return { ts: `dry_${Date.now()}` };
  }
  try {
    return await slackApi('chat.postMessage', { body: { channel: dmChannelId, ...tagged } });
  } catch (first) {
    warn(`Slack post failed (${first.message}); retrying in ${RETRY_DELAY_MS / 1000}s`);
    await sleep(RETRY_DELAY_MS);
    try {
      return await slackApi('chat.postMessage', { body: { channel: dmChannelId, ...tagged } });
    } catch (second) {
      warn(`Slack post failed again (${second.message}); dropping message, continuing`);
      return null;
    }
  }
}

// --- capability identity (roster-fed personId → name, same debt as the feed) ---

let roster = []; // AgentInfo[] from the app ws agents-changed broadcast

function nameForPersonId(personId) {
  if (personId === HUMAN_PERSON_ID) return 'chris';
  const found = roster.find((agent) => `person_${agent.agentId.replaceAll('_', '-')}` === personId);
  return found?.title ?? personId;
}

// --- outbound: capability → Slack ----------------------------------------------

const threadCache = new Map(); // threadId → capability thread (REST, F12-style refresh)
const postedMessages = new Map(); // capability messageId → Slack ts (bounded, for delivery follow-ups)

function rememberPosted(messageId, ts) {
  if (postedMessages.has(messageId)) postedMessages.delete(messageId);
  postedMessages.set(messageId, ts);
  if (postedMessages.size > POSTED_MAX) postedMessages.delete(postedMessages.keys().next().value);
}

async function appRest(pathname) {
  const response = await fetch(`${APP_BASE}${pathname}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GET ${pathname} → HTTP ${response.status}`);
  return response.json();
}

async function refreshThreads() {
  const data = await appRest('/api/messaging/v2/user/threads');
  threadCache.clear();
  for (const thread of data.threads ?? []) threadCache.set(thread.id, thread);
}

/** The agent DM partner for a direct thread with chris, else null (rooms,
 * agent↔agent lanes — v0 bridges chris's DMs only). */
function dmAgentName(thread) {
  if (thread.threadKind !== 'direct') return null;
  const other = thread.direct?.pair?.find((personId) => personId !== HUMAN_PERSON_ID);
  return other === undefined ? null : nameForPersonId(other);
}

const timeOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '??:??'
    : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

async function bridgeMessage(message) {
  let thread = threadCache.get(message.threadId);
  if (thread === undefined) {
    // F12 (audit): a commit for an unknown thread — refetch threads first;
    // never file under a raw threadId lane.
    try {
      await refreshThreads();
      thread = threadCache.get(message.threadId);
    } catch (error) {
      warn(`thread refresh failed (${error.message}); dropping message ${message.id}`);
      return;
    }
  }
  if (thread === undefined) return; // not a human-visible thread — not ours to bridge
  const agentName = dmAgentName(thread);
  if (agentName === null) return;
  if (message.senderId === HUMAN_PERSON_ID) return; // never mirror chris back
  const rootTs = state.roots[message.threadId];
  const text = `*${agentName}* · ${timeOf(message.createdAt)}\n${message.body?.text ?? ''}`;
  const posted = await postToSlack(rootTs === undefined ? { text } : { text, thread_ts: rootTs });
  if (posted === null) return;
  rememberPosted(message.id, posted.ts);
  if (rootTs === undefined) {
    state.roots[message.threadId] = posted.ts;
    state.agents[posted.ts] = agentName;
    saveState();
    log(`bridged new DM thread: ${agentName} → Slack ${posted.ts}`);
  } else {
    vlog(`bridged ${message.id} → thread ${rootTs}`);
  }
}

async function bridgeDelivery(delivery) {
  if (delivery.state !== 'failed') return; // honesty table: only failures mark
  const ts = postedMessages.get(delivery.messageId);
  if (ts === undefined) {
    vlog(`failed delivery for unposted ${delivery.messageId} — no Slack thread to amend`);
    return;
  }
  await postToSlack({ text: `⚠ delivery failed — ${delivery.messageId}`, thread_ts: ts });
}

/** ended → refetch the trailing windows and bridge anything past the cursor
 * (live frames that landed while the subscription was down). */
async function refetchFromTip() {
  try {
    await refreshThreads();
    for (const thread of threadCache.values()) {
      const data = await appRest(`/api/messaging/v2/user/messages?threadId=${encodeURIComponent(thread.id)}`);
      const fresh = (data.messages ?? [])
        .filter((message) => Number.isFinite(message.sequence) && message.sequence > state.cursor)
        .sort((a, b) => a.sequence - b.sequence);
      for (const message of fresh) {
        if (advanceCursor(message.sequence)) await bridgeMessage(message);
      }
    }
  } catch (error) {
    warn(`refetch failed (${error.message}) — the cursor resume will cover the gap on resubscribe`);
  }
}

// --- app websocket (mirrors the browser feed's dialect + rhythm) ----------------

let appSocket = null;
let appRetryCount = 0;
let everLive = false;
let endedRetryCount = 0;

const appWsUrl = () => `${APP_BASE.replace(/^http/, 'ws')}/ws`;

function subscribeLive() {
  if (appSocket === null || appSocket.readyState !== WebSocket.OPEN) return;
  const since = state.cursor > 0 ? `s_${state.cursor}` : undefined;
  appSocket.send(JSON.stringify({ type: 'messaging-v2-sub', ...(since === undefined ? {} : { since }) }));
  vlog(`subscribed (since ${since ?? 'tip'})`);
}

function backoffMs(retryCount) {
  return Math.min(BACKOFF_BASE_MS * 2 ** retryCount, BACKOFF_MAX_MS);
}

function handleEnded(frame) {
  const backoff = backoffMs(endedRetryCount);
  endedRetryCount += 1;
  if (frame.reason === 'dependency-lost' && !everLive) {
    warn(`capability unavailable — resubscribing in ${backoff}ms (no refetch)`);
    setTimeout(subscribeLive, backoff);
    return;
  }
  warn(`subscription ended (${frame.reason ?? 'unknown'}) — refetching from the tip in ${backoff}ms`);
  setTimeout(() => { void refetchFromTip().then(subscribeLive); }, backoff);
}

async function handleCapabilityFrame(payload) {
  if (payload === null || typeof payload !== 'object') return;
  if (payload.kind === 'started') {
    everLive = true;
    endedRetryCount = 0;
    vlog('subscription live');
    return;
  }
  if (payload.kind === 'ended') return handleEnded(payload);
  if (payload.kind !== 'event' || payload.event === undefined) return;
  const sequence = payload.event.message?.sequence
    ?? (payload.event.delivery !== undefined ? payload.sequence : undefined)
    ?? payload.sequence;
  if (sequence !== undefined && !advanceCursor(sequence)) return; // at-least-once dupe
  if (payload.event.message !== undefined) await bridgeMessage(payload.event.message);
  else if (payload.event.delivery !== undefined) await bridgeDelivery(payload.event.delivery);
  // PresenceChanged frames are intentionally ignored (the feed does the same).
}

function connectAppSocket() {
  appSocket = new WebSocket(appWsUrl());
  appSocket.on('open', () => {
    appRetryCount = 0;
    log(`app socket connected (${appWsUrl()})`);
    subscribeLive();
  });
  appSocket.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (frame?.type === 'agents-changed' && Array.isArray(frame.agents)) {
      roster = frame.agents;
      return;
    }
    if (frame?.event === 'messaging-v2') {
      handleCapabilityFrame(frame.payload).catch((error) => warn(`frame handling failed: ${error.message}`));
    }
  });
  appSocket.on('close', () => {
    const backoff = backoffMs(appRetryCount);
    appRetryCount += 1;
    warn(`app socket closed — reconnecting in ${backoff}ms (is \`npm run dev\` up on ${APP_BASE}?)`);
    setTimeout(connectAppSocket, backoff);
  });
  appSocket.on('error', (error) => vlog(`app socket error: ${error.message}`)); // close follows
}

// --- inbound: Slack → capability -------------------------------------------------

async function sendToAgent(agentName, body) {
  const response = await fetch(`${APP_BASE}/api/messaging/v2/user/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: agentName, body }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const rosterHint = Array.isArray(data.roster) ? ` (live: ${data.roster.join(', ')})` : '';
    throw new Error(`${data.error ?? `HTTP ${response.status}`}${rosterHint}`);
  }
  return data;
}

const MENTION = /^@([A-Za-z0-9._-]+)\s+([\s\S]+)$/;

async function handleChrisMessage(event) {
  const text = (event.text ?? '').trim();
  if (event.thread_ts !== undefined) {
    const agentName = state.agents[event.thread_ts];
    if (agentName === undefined) {
      await postToSlack({ text: 'unknown thread — start with @agentName', thread_ts: event.thread_ts });
      return;
    }
    await forwardToAgent(agentName, text, event.thread_ts);
    return;
  }
  const mention = MENTION.exec(text);
  if (mention === null) {
    await postToSlack({ text: 'unknown thread — start with @agentName' });
    return;
  }
  await forwardToAgent(mention[1], mention[2], undefined);
}

async function forwardToAgent(agentName, body, threadTs) {
  try {
    const result = await sendToAgent(agentName, body);
    log(`slack → ${agentName}: committed ${result.messageId ?? '?'}`);
  } catch (error) {
    warn(`send to ${agentName} failed: ${error.message}`);
    await postToSlack({
      text: `✗ could not reach *${agentName}*: ${error.message}`,
      ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
    });
  }
}

/** Echo guards — belt and braces. Any one match drops the event. */
function isOwnEcho(event) {
  if (event.bot_id !== undefined) return true;                    // any bot post
  if (event.user === botUserId) return true;                      // our bot user (auth.test)
  if (event.metadata?.event_type === META_TAG) return true;       // our tagged posts
  return false;
}

function handleSlackEvent(event) {
  if (event?.type !== 'message' || event.channel_type !== 'im') return;
  if (event.subtype !== undefined) return; // edits/deletes ignored in v0
  if (isOwnEcho(event)) return;
  if (event.user !== config.chrisUserId) return; // one lane: chris only
  handleChrisMessage(event).catch((error) => warn(`slack event handling failed: ${error.message}`));
}

// --- Socket Mode -----------------------------------------------------------------

let slackSocket = null;
let slackRetryCount = 0;

function connectSlackSocket() {
  slackApi('apps.connections.open', { body: {}, token: config.appToken })
    .then(({ url }) => {
      slackSocket = new WebSocket(url);
      slackSocket.on('message', (data) => {
        let envelope;
        try {
          envelope = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (envelope.envelope_id !== undefined) {
          slackSocket.send(JSON.stringify({ envelope_id: envelope.envelope_id })); // ack first
        }
        if (envelope.type === 'hello') {
          slackRetryCount = 0;
          log('Slack Socket Mode connected');
          return;
        }
        if (envelope.type === 'disconnect') {
          warn(`Slack asked to disconnect (${envelope.reason ?? 'unknown'}) — reconnecting`);
          slackSocket.close();
          return;
        }
        if (envelope.type === 'events_api') handleSlackEvent(envelope.payload?.event);
      });
      slackSocket.on('close', () => {
        const backoff = backoffMs(slackRetryCount);
        slackRetryCount += 1;
        warn(`Slack socket closed — reconnecting in ${backoff}ms`);
        setTimeout(connectSlackSocket, backoff);
      });
      slackSocket.on('error', (error) => vlog(`slack socket error: ${error.message}`)); // close follows
    })
    .catch((error) => {
      const backoff = backoffMs(slackRetryCount);
      slackRetryCount += 1;
      warn(`apps.connections.open failed (${error.message}) — retrying in ${backoff}ms`);
      setTimeout(connectSlackSocket, backoff);
    });
}

// --- boot ------------------------------------------------------------------------

let botUserId = DRY_RUN ? 'U_DRY_RUN_BOT' : undefined;
let dmChannelId = DRY_RUN ? 'D_DRY_RUN' : undefined;

async function resolveIdentities() {
  const auth = await slackApi('auth.test', { body: {} });
  botUserId = auth.user_id;
  if (config.chrisUserId === undefined) {
    if (config.chrisEmail === undefined) {
      throw new Error(`config needs chrisUserId or chrisEmail (${CONFIG_FILE})`);
    }
    const looked = await slackApi('users.lookupByEmail', { query: { email: config.chrisEmail } });
    config.chrisUserId = looked.user.id;
  }
  const opened = await slackApi('conversations.open', { body: { users: config.chrisUserId } });
  dmChannelId = opened.channel.id;
  log(`bot=${botUserId} chris=${config.chrisUserId} dm=${dmChannelId}`);
}

loadState();

if (DRY_RUN) {
  log('mode: dry-run — Slack posts print to stdout, inbound lane off');
  connectAppSocket();
} else {
  resolveIdentities()
    .then(() => {
      connectAppSocket();
      connectSlackSocket();
      log(`bridging ${APP_BASE} ↔ Slack (cursor s_${state.cursor})`);
    })
    .catch((error) => {
      console.error(`[slack-bridge] boot failed: ${error.message}`);
      process.exit(1);
    });
}

process.on('SIGINT', () => {
  saveState();
  log('stopping (SIGINT) — state persisted');
  process.exit(0);
});
