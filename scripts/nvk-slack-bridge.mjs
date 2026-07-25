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
const RETRY_DELAY_MS = Number(process.env.NVK_SLACK_BRIDGE_RETRY_MS) || 5000; // Slack post retry (mirror precedent)
const PING_MS = Number(process.env.NVK_SLACK_BRIDGE_PING_MS) || 30_000;       // zombie-socket heartbeat
const POSTED_MAX = 5000;                     // bounded messageId → slackTs recall
const EVENTS_MAX = 2000;                     // bounded Slack redelivery dedupe
const BACKOFF_BASE_MS = 500;                 // agentSocket/feed rhythm: 500ms → 8s
const BACKOFF_MAX_MS = 8_000;

const log = (...a) => console.log('[slack-bridge]', ...a);
const warn = (...a) => console.warn('[slack-bridge] WARN:', ...a);
const vlog = (...a) => { if (VERBOSE) log(...a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Async work on both lanes is SERIALIZED (one chain per lane): two frames for
// a brand-new thread must never race the root-post check (audit F3), and the
// dedupe maps are only safe against interleaved handlers.
let frameChain = Promise.resolve();
const enqueueFrame = (work) => {
  frameChain = frameChain.then(work).catch((error) => warn(`frame handling failed: ${error.message}`));
  return frameChain;
};
let slackChain = Promise.resolve();
const enqueueSlack = (work) => {
  slackChain = slackChain.then(work).catch((error) => warn(`slack event handling failed: ${error.message}`));
  return slackChain;
};

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
(Socket Mode + scopes chat:write im:read im:write users:read.email,
app-level token with connections:write).`);
  process.exit(1);
}

// --- persisted state (cursor + thread maps) --------------------------------------

const state = { cursor: 0, roots: {}, agents: {} };
// cursor: last capability sequence bridged (resume is `s_<cursor>`). Advances
// ONLY after the Slack post lands (audit F4) — a failed post is retried by
// the server's at-least-once replay, never silently skipped.
// roots:  capability threadId → Slack root ts (one Slack thread per agent DM).
// agents: Slack root ts → agent PERSONID (stable across renames — the display
//         name is resolved at forward time, audit F2/F9).

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

/** Every outbound post carries the echo-guard metadata tag. Null on failure. */
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

// --- capability identity ---------------------------------------------------------
// The roster is a REST read (GET /api/agents) at boot and on every thread
// refresh: the real server broadcasts agents-changed only on launch/exit/
// rename — NEVER on connect (audit F2). The broadcast still refreshes us
// mid-flight (that is what makes renames route correctly, audit F9).

let roster = []; // AgentInfo[] — REST at boot/refresh, agents-changed in between

async function appRest(pathname) {
  const response = await fetch(`${APP_BASE}${pathname}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GET ${pathname} → HTTP ${response.status}`);
  return response.json();
}

async function refreshRoster() {
  try {
    const data = await appRest('/api/agents');
    if (Array.isArray(data.agents)) roster = data.agents;
  } catch (error) {
    warn(`roster fetch failed (${error.message}) — names may degrade to personIds`);
  }
}

function nameForPersonId(personId) {
  if (personId === HUMAN_PERSON_ID) return 'chris';
  const found = roster.find((agent) => `person_${agent.agentId.replaceAll('_', '-')}` === personId);
  return found?.title ?? personId;
}

/** Thread-map value → sendable display name, resolved at FORWARD time so a
 * rename never strands a thread. Roster miss → one refetch, then the raw
 * value (the route 404s honestly with its roster hint). v0 state files
 * stored the bare name; non-personId values pass through unchanged. */
async function nameForSend(stored) {
  if (!stored.startsWith('person_')) return stored;
  const resolved = nameForPersonId(stored);
  if (resolved !== stored) return resolved;
  await refreshRoster();
  return nameForPersonId(stored);
}

// --- outbound: capability → Slack ----------------------------------------------

const threadCache = new Map(); // threadId → capability thread (REST, F12-style refresh)
const postedMessages = new Map(); // capability messageId → Slack ts (bounded; dedupe + delivery follow-ups)

function rememberPosted(messageId, ts) {
  if (postedMessages.has(messageId)) postedMessages.delete(messageId);
  postedMessages.set(messageId, ts);
  if (postedMessages.size > POSTED_MAX) postedMessages.delete(postedMessages.keys().next().value);
}

async function refreshThreads() {
  await refreshRoster();
  const data = await appRest('/api/messaging/v2/user/threads');
  threadCache.clear();
  for (const thread of data.threads ?? []) threadCache.set(thread.id, thread);
}

/** The agent DM partner for a direct thread with chris, else null (rooms,
 * agent↔agent lanes — v0 bridges chris's DMs only). */
function dmAgentPersonId(thread) {
  if (thread.threadKind !== 'direct') return null;
  return thread.direct?.pair?.find((personId) => personId !== HUMAN_PERSON_ID) ?? null;
}

const timeOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '??:??'
    : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

/** true when the message is SETTLED (posted, or intentionally skipped); false
 * when the Slack post failed — the caller must NOT advance the cursor. */
async function bridgeMessage(message) {
  if (postedMessages.has(message.id)) {
    vlog(`dupe ${message.id} (already posted) — skipped`);
    return true;
  }
  let thread = threadCache.get(message.threadId);
  if (thread === undefined) {
    // F12 (audit): a commit for an unknown thread — refetch threads first;
    // never file under a raw threadId lane.
    try {
      await refreshThreads();
      thread = threadCache.get(message.threadId);
    } catch (error) {
      warn(`thread refresh failed (${error.message}); message ${message.id} left for the cursor replay`);
      return false;
    }
  }
  if (thread === undefined) return true; // not a human-visible thread — settled, not ours
  const agentPersonId = dmAgentPersonId(thread);
  if (agentPersonId === null) return true;  // rooms/agent↔agent lanes — settled, out of scope
  if (message.senderId === HUMAN_PERSON_ID) return true; // never mirror chris back
  const rootTs = state.roots[message.threadId];
  const text = `*${nameForPersonId(agentPersonId)}* · ${timeOf(message.createdAt)}\n${message.body?.text ?? ''}`;
  const posted = await postToSlack(rootTs === undefined ? { text } : { text, thread_ts: rootTs });
  if (posted === null) return false;
  rememberPosted(message.id, posted.ts);
  if (rootTs === undefined) {
    state.roots[message.threadId] = posted.ts;
    state.agents[posted.ts] = agentPersonId;
    saveState();
    log(`bridged new DM thread: ${nameForPersonId(agentPersonId)} → Slack ${posted.ts}`);
  } else {
    vlog(`bridged ${message.id} → thread ${rootTs}`);
  }
  return true;
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

/** ended → refetch the trailing windows and bridge anything past the cursor.
 * Messages are collected across ALL threads and bridged in GLOBAL sequence
 * order (audit F1): a per-thread pass that advanced the cursor as it went
 * lost lower sequences from later threads under higher ones from earlier
 * ones. Stops at the first failed post — the next resume covers the rest. */
async function refetchFromTip() {
  const fresh = [];
  try {
    await refreshThreads();
    for (const thread of threadCache.values()) {
      const data = await appRest(`/api/messaging/v2/user/messages?threadId=${encodeURIComponent(thread.id)}`);
      fresh.push(...(data.messages ?? []).filter(
        (message) => Number.isFinite(message.sequence) && message.sequence > state.cursor,
      ));
    }
  } catch (error) {
    warn(`refetch failed (${error.message}) — the cursor resume will cover the gap on resubscribe`);
    return;
  }
  fresh.sort((a, b) => a.sequence - b.sequence);
  for (const message of fresh) {
    if (!(await bridgeMessage(message))) {
      warn(`refetch paused at a failed post (seq ${message.sequence}) — the next resume covers the rest`);
      return;
    }
    advanceCursor(message.sequence);
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
  setTimeout(() => { void enqueueFrame(refetchFromTip).then(subscribeLive); }, backoff);
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
  const message = payload.event.message;
  const delivery = payload.event.delivery;
  const sequence = message?.sequence
    ?? (delivery !== undefined ? payload.sequence : undefined)
    ?? payload.sequence;
  if (sequence !== undefined && sequence <= state.cursor) return; // at-least-once dupe
  if (message !== undefined) {
    // F4: the cursor moves only once the message is settled — a failed Slack
    // post leaves it behind so the server's replay gets bridged.
    if (await bridgeMessage(message) && sequence !== undefined) advanceCursor(sequence);
    return;
  }
  if (delivery !== undefined) {
    await bridgeDelivery(delivery); // advisory notice — the cursor always moves
    if (sequence !== undefined) advanceCursor(sequence);
  }
  // PresenceChanged frames are intentionally ignored (the feed does the same).
}

/** Zombie-socket detection (audit F6): ping every PING_MS; a socket that
 * missed its last pong is terminated — 'close' fires and the normal backoff
 * reconnect takes over. */
function heartbeat(socket, label) {
  let alive = true;
  socket.on('pong', () => { alive = true; });
  const timer = setInterval(() => {
    if (!alive) {
      warn(`${label} socket missed a pong — terminating the zombie`);
      socket.terminate();
      return;
    }
    alive = false;
    try {
      socket.ping();
    } catch {
      // the socket is already dying — 'close' follows and reconnects
    }
  }, PING_MS);
  socket.on('close', () => clearInterval(timer));
}

function connectAppSocket() {
  appSocket = new WebSocket(appWsUrl());
  heartbeat(appSocket, 'app');
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
    if (frame?.event === 'messaging-v2') enqueueFrame(() => handleCapabilityFrame(frame.payload));
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

/** Slack wire text → plain text (audit F8): Slack escapes & < > and wraps
 * links as <url|label>; the capability gets readable text. */
function decodeSlackText(text) {
  return text
    .replace(/<((?:https?|mailto):[^|>\s]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

// Redelivery dedupe (audit F5): ack-first is right, but a lost ack makes
// Slack deliver the same event again — the capability must see it once.
const recentEvents = new Map(); // `${channel}:${ts}` → true (bounded)
function alreadyHandled(key) {
  if (recentEvents.has(key)) return true;
  recentEvents.set(key, true);
  if (recentEvents.size > EVENTS_MAX) recentEvents.delete(recentEvents.keys().next().value);
  return false;
}

const MENTION = /^@([A-Za-z0-9._-]+)\s+([\s\S]+)$/;

async function handleChrisMessage(event) {
  const text = decodeSlackText(event.text ?? '').trim();
  if (event.thread_ts !== undefined) {
    const stored = state.agents[event.thread_ts];
    if (stored === undefined) {
      await postToSlack({ text: 'unknown thread — start with @agentName', thread_ts: event.thread_ts });
      return;
    }
    await forwardToAgent(await nameForSend(stored), text, event.thread_ts);
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
  const key = `${event.channel}:${event.ts}`;
  enqueueSlack(async () => {
    if (alreadyHandled(key)) {
      vlog(`redelivered event ${key} — dropped`);
      return;
    }
    await handleChrisMessage(event);
  });
}

// --- Socket Mode -----------------------------------------------------------------

let slackSocket = null;
let slackRetryCount = 0;

function connectSlackSocket() {
  slackApi('apps.connections.open', { body: {}, token: config.appToken })
    .then(({ url }) => {
      slackSocket = new WebSocket(url);
      heartbeat(slackSocket, 'slack');
      slackSocket.on('message', (data) => {
        let envelope;
        try {
          envelope = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (envelope.envelope_id !== undefined) {
          // Ack first — a dying socket must not take the process down (audit F10d).
          try {
            slackSocket.send(JSON.stringify({ envelope_id: envelope.envelope_id }), () => {});
          } catch {
            // the socket is already gone; Slack redelivers and the dedupe absorbs it
          }
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
    .then(refreshRoster) // the roster is a REST read — no broadcast comes on connect
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
  log('stopping (SIGINT) — draining in-flight work');
  const exit = () => { saveState(); process.exit(0); };
  setTimeout(exit, 2000).unref(); // hard stop: a wedged post must not hold the process
  void Promise.allSettled([frameChain, slackChain]).then(exit);
});
