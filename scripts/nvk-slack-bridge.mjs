#!/usr/bin/env node
// nvk slack-bridge — two-way lane between chris's Slack DM with the bridge
// bot and the messagingV2 capability's human principal. N7 (D-BRIDGE-1)
// GENERALIZES the v0 bridge IN PLACE: one Slack channel ↔ one room Thread
// joins the DM lanes — the one-way nvk-slack-mirror.mjs is untouched.
//
//   agent → chris DM in the app      → root/reply in the Slack DM (*agent* · HH:MM)
//   room message in the app (D-N7-3) → TOP-LEVEL post in the mapped Slack channel
//   chris replies in a thread        → POST /api/messaging/v2/user/send {to: agent}
//   chris posts "@agent text"        → same route (opens the DM)
//   human posts in the channel       → /user/send {to: '#<room label>'} as the human
//
// D-N7-1: the bridge stays a CLIENT of Messaging over the embedded surface
// (browser dialect ws + user REST routes) — D7's "client, not adapter" is
// satisfied; the DEC-17 door migration is unnecessary for a co-located
// launchd daemon. Echo-safe in both directions: auth.test's bot user id,
// Slack bot_id, AND a metadata tag on every post (D-N7-5).
//
//   node scripts/nvk-slack-bridge.mjs [--verbose] [--dry-run]
//
// Tokens: env NVK_SLACK_BOT_TOKEN (xoxb) / NVK_SLACK_APP_TOKEN (xapp) win;
// fallback .novakai-command/slack-bridge.json
// ({botToken, appToken, chrisUserId?, chrisEmail?, channels?}).
// channels: [{slackChannelId, room}] — label form, resolved to a threadId at
// boot (D-N7-2; ABSENT/empty = channel code dormant, DM lanes unaffected).
// Channel inbound is OWNER-ONLY (chrisUserId): every other Slack user drops
// with ONE loud line — /user/send always speaks as the human principal, so
// bridging another user would stamp chris's name on their words; external
// principals arrive at N8. Never hardcoded.
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
const APP_BASE = (process.env.NVK_SLACK_BRIDGE_APP_BASE ?? 'http://localhost:5180').replace(/\/$/, '');
// The nvk-server connection token (loopback trust): read fresh per call — the
// server rewrites it on every restart.
const NVK_ROOT = process.env.NVK_ROOT ?? path.join(process.env.HOME ?? '', 'Programming', 'Novakai-Command', '.novakai');
function appToken() {
  try {
    return fs.readFileSync(path.join(NVK_ROOT, 'server', 'ws-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const SLACK_API = (process.env.NVK_SLACK_API_BASE ?? 'https://slack.com/api').replace(/\/$/, '');

const HUMAN_PERSON_ID = process.env.NVK_HUMAN_PERSON_ID ?? 'person_chris'; // the nvk-server human principal
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
    // D-N7-2: channel↔room map. ABSENT or empty means the channel code stays
    // dormant (production runs exactly that until the click-work lands) —
    // DM lanes are unaffected. D-N8-3: externals ride the DEC-17 door as
    // THEMSELVES — ABSENT or empty = no door connections (dormant).
    channels: Array.isArray(file.channels) ? file.channels : [],
    externals: Array.isArray(file.externals) ? file.externals : [],
  };
}

const config = DRY_RUN
  ? { botToken: 'dry-run', appToken: 'dry-run', chrisUserId: 'U_DRY_RUN', channels: [], externals: [] }
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

// --- persisted state (cursor + thread maps + health) -------------------------------

const state = { cursor: 0, roots: {}, agents: {} };
// cursor: last capability sequence bridged (resume is `s_<cursor>`). Advances
// ONLY after the Slack post lands (audit F4) — a failed post is retried by
// the server's at-least-once replay, never silently skipped.
// roots:  capability threadId → Slack root ts (one Slack thread per agent DM).
// agents: Slack root ts → agent PERSONID (stable across renames — the display
//         name is resolved at forward time, audit F2/F9).
// D-N7-7: the health block — written on change, additive only (existing
// cursor/roots/agents readers are unaffected; the bridge is the ONLY writer).
const health = { updatedAt: null, appRetryCount: 0, slackRetryCount: 0, lastError: null, lastBridgedAt: null };

function touchHealth(patch) {
  Object.assign(health, patch, { updatedAt: new Date().toISOString() });
  saveState();
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Number.isFinite(parsed.cursor)) state.cursor = parsed.cursor;
    if (parsed.roots && typeof parsed.roots === 'object') state.roots = parsed.roots;
    if (parsed.agents && typeof parsed.agents === 'object') state.agents = parsed.agents;
    if (parsed.health && typeof parsed.health === 'object') Object.assign(health, parsed.health);
    vlog(`state loaded: cursor=${state.cursor}, ${Object.keys(state.roots).length} thread(s)`);
  } catch (error) {
    warn(`could not read ${STATE_FILE}: ${error.message} — starting fresh`);
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    health.appRetryCount = appRetryCount;
    health.slackRetryCount = slackRetryCount;
    // F1: liveness IS the daemon persisting state — cursor advances, settles,
    // and touches all refresh updatedAt (an idle or outbound-only bridge
    // must never 503).
    health.updatedAt = new Date().toISOString();
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, health }, null, 2));
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
  if (response.status === 429) {
    // D-N7-6: rate limiting is a TEMPO signal, not a failure — carry the
    // Retry-After so the post loop waits instead of hammering.
    const seconds = Number(response.headers.get('retry-after')) || 1;
    const rateLimited = new Error(`${method} rate-limited (retry-after ${seconds}s)`);
    rateLimited.retryAfterSeconds = seconds;
    throw rateLimited;
  }
  if (!response.ok || data.ok !== true) {
    throw new Error(`${method} failed: HTTP ${response.status} ${data.error ?? ''}`.trim());
  }
  return data;
}

/** Every outbound post carries the echo-guard metadata tag. Null on failure.
 * D-N7-6: bounded Retry-After-aware retries replace the one blind retry —
 * a 429 waits its Retry-After (+ jitter), other failures wait RETRY_DELAY_MS,
 * and the final drop is still loud. D-N7-3: the channel is a parameter (DM
 * lane default; room lanes post to their mapped channel). */
async function postToSlack(payload, channelId = dmChannelId) {
  const tagged = {
    ...payload,
    metadata: { event_type: META_TAG, event_payload: { bridge: 'v0' } },
  };
  if (DRY_RUN) {
    console.log(`[dry-run] ${tagged.thread_ts ? `↳(${tagged.thread_ts}) ` : ''}${tagged.text}`);
    return { ts: `dry_${Date.now()}` };
  }
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await slackApi('chat.postMessage', { body: { channel: channelId, ...tagged } });
    } catch (error) {
      if (attempt === attempts) {
        warn(`Slack post failed after ${attempts} attempts (${error.message}); dropping message, continuing`);
        touchHealth({ lastError: error.message });
        return null;
      }
      // D-N7-6/F6: Retry-After + jitter, CAPPED — one wedged channel must
      // never head-of-line-block every lane behind it.
      const waitMs = error.retryAfterSeconds !== undefined
        ? Math.min(error.retryAfterSeconds * 1000, 30_000) + Math.floor(Math.random() * 250)
        : RETRY_DELAY_MS;
      warn(`Slack post failed (${error.message}); retrying in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  return null; // unreachable — the loop always returns
}

// --- capability identity ---------------------------------------------------------
// The roster is a REST read (GET /api/agents) at boot and on every thread
// refresh: the real server broadcasts agents-changed only on launch/exit/
// rename — NEVER on connect (audit F2). The broadcast still refreshes us
// mid-flight (that is what makes renames route correctly, audit F9).

let roster = []; // AgentInfo[] — REST at boot/refresh, agents-changed in between

async function appRest(pathname) {
  const response = await fetch(`${APP_BASE}${pathname}`, {
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${appToken()}` },
  });
  if (!response.ok) throw new Error(`GET ${pathname} → HTTP ${response.status}`);
  return response.json();
}

async function refreshRoster() {
  try {
    const data = await appRest('/api/door/agents');
    if (Array.isArray(data.agents)) roster = data.agents;
  } catch (error) {
    warn(`roster fetch failed (${error.message}) — names may degrade to personIds`);
  }
}

function nameForPersonId(personId) {
  if (personId === HUMAN_PERSON_ID) return 'chris';
  const found = roster.find((agent) => agent.personId === personId);
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
// capability messageId → { ts, channelId, partsPosted, complete } (bounded).
// F3: per-part progress — only COMPLETE entries dedupe; a partial failure
// resumes from partsPosted (never reposts, never truncates). `ts` is part
// 0's ts — delivery follow-ups (⚠) amend there.
const postedMessages = new Map();

function rememberPosted(messageId, entry) {
  if (postedMessages.has(messageId)) postedMessages.delete(messageId);
  postedMessages.set(messageId, entry);
  if (postedMessages.size > POSTED_MAX) postedMessages.delete(postedMessages.keys().next().value);
}

/** F3: post one message's parts with per-part progress — on a partial
 * failure the cursor holds and the at-least-once replay resumes from
 * partsPosted. onFirstPart fires once when part 0 lands (the DM lane mints
 * its Slack root there). False = the Slack post failed; retry via replay. */
async function postParts(message, parts, channelId, rootTs, onFirstPart) {
  const prior = postedMessages.get(message.id) ?? { ts: undefined, channelId, partsPosted: 0, complete: false };
  let laneRootTs = rootTs ?? prior.ts;
  for (let index = prior.partsPosted; index < parts.length; index += 1) {
    const payload = laneRootTs === undefined ? { text: parts[index] } : { text: parts[index], thread_ts: laneRootTs };
    const posted = await postToSlack(payload, channelId);
    if (posted === null) {
      rememberPosted(message.id, prior);
      return false;
    }
    prior.partsPosted = index + 1;
    if (index === 0) {
      prior.ts = posted.ts;
      if (rootTs === undefined) laneRootTs = posted.ts;
      onFirstPart?.(posted.ts);
    }
    rememberPosted(message.id, prior);
  }
  prior.complete = true;
  rememberPosted(message.id, prior);
  return true;
}

async function refreshThreads() {
  await refreshRoster();
  const data = await appRest('/api/door/user/threads');
  threadCache.clear();
  for (const thread of data.threads ?? []) threadCache.set(thread.id, thread);
}

/** The agent DM partner for a direct thread with chris, else null (rooms,
 * agent↔agent lanes — the DM lane bridges chris's DMs only). */
function dmAgentPersonId(thread) {
  if (thread.threadKind !== 'direct') return null;
  return thread.direct?.pair?.find((personId) => personId !== HUMAN_PERSON_ID) ?? null;
}

// --- D-N7-2: the channel ↔ room map --------------------------------------------
// channelRooms: slackChannelId → { label, threadId } (inbound routing);
// roomChannels: room threadId → { label, channelId } (outbound routing).
// Resolved at boot from the /user/threads label enrichment; ABSENT/empty
// config leaves both empty and every channel code path dormant.

const channelRooms = new Map();
const roomChannels = new Map();

/** Boot resolution: configured label → room threadId. An unresolvable label
 * is a LOUD boot warning (never silent, never fatal — DM lanes boot anyway).
 * F2: a DOWN app (refused fetch) is the same posture — dormant this boot,
 * retried on every app-ws (re)connect. F4: room keys are exact label first,
 * then 'authority:externalId', then a bare externalId ONLY when it matches
 * exactly one room (composite keys are the truth — 'team' alone can collide);
 * duplicate slackChannelId entries are refused loudly. */
async function resolveChannels() {
  if (config.channels.length === 0) return;
  let threads;
  try {
    const data = await appRest('/api/door/user/threads');
    threads = data.threads ?? [];
  } catch (error) {
    warn(`channel resolution failed (${error.message}) — channels dormant this boot; retrying on the next app-ws connect`);
    return;
  }
  const seen = new Set();
  for (const entry of config.channels) {
    if (seen.has(entry.slackChannelId)) {
      warn(`duplicate slackChannelId ${entry.slackChannelId} in channels config — skipping the duplicate entry`);
      continue;
    }
    seen.add(entry.slackChannelId);
    const thread = resolveRoomThread(threads, entry.room);
    if (thread === undefined) continue; // resolveRoomThread warned already
    const label = thread.label ?? `#${entry.room}`;
    channelRooms.set(entry.slackChannelId, { label, threadId: thread.id });
    roomChannels.set(thread.id, { label, channelId: entry.slackChannelId });
    log(`channel map: ${entry.slackChannelId} ↔ ${label} (${thread.id})`);
  }
}

/** One config room key → its room thread, or undefined (warned). */
function resolveRoomThread(threads, roomKey) {
  const rooms = threads.filter((thread) => thread.threadKind !== 'direct');
  const byLabel = rooms.find((thread) => thread.label === roomKey || thread.label === `#${roomKey}`);
  if (byLabel !== undefined) return byLabel;
  if (roomKey.includes(':')) {
    const [authority, externalId] = roomKey.split(':', 2);
    const composite = rooms.find((thread) =>
      thread.room?.authority === authority && thread.room?.externalId === externalId);
    if (composite !== undefined) return composite;
  } else {
    const candidates = rooms.filter((thread) => thread.room?.externalId === roomKey);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      warn(`room "${roomKey}" is ambiguous (${candidates.length} room threads share the externalId) — use authority:externalId or the exact label`);
      return undefined;
    }
  }
  warn(`configured room "${roomKey}" does NOT resolve to a room thread — check the key (/user/threads)`);
  return undefined;
}

/** F2: configured-but-unresolved — a reconnect should retry resolution. */
function channelsPending() {
  return config.channels.length > 0 && channelRooms.size < config.channels.filter(
    (entry, index, all) => all.findIndex((other) => other.slackChannelId === entry.slackChannelId) === index,
  ).length;
}

const timeOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '??:??'
    : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

/** D-N7-6: app→Slack bodies over the contract's 32 KiB serialized cap are
 * chunked — each part gets an (i/n) marker so the channel reads in order. */
const SLACK_PART_SIZE = 31_000; // cap minus header/marker headroom

function chunkText(text) {
  if (text.length <= SLACK_PART_SIZE) return [text];
  const parts = [];
  for (let index = 0; index < text.length; index += SLACK_PART_SIZE) {
    parts.push(text.slice(index, index + SLACK_PART_SIZE));
  }
  return parts.map((part, index) => `(${index + 1}/${parts.length}) ${part}`);
}

/** true when the message is SETTLED (posted, or intentionally skipped); false
 * when the Slack post failed — the caller must NOT advance the cursor. */
async function bridgeMessage(message) {
  if (postedMessages.get(message.id)?.complete === true) {
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
  if (message.senderId === HUMAN_PERSON_ID) return true; // never mirror chris back (any lane)
  const agentPersonId = dmAgentPersonId(thread);
  if (agentPersonId === null) return bridgeRoomMessage(message, thread);
  const rootTs = state.roots[message.threadId];
  const text = `*${nameForPersonId(agentPersonId)}* · ${timeOf(message.createdAt)}\n${message.body?.text ?? ''}`;
  const mintRoot = (firstTs) => {
    state.roots[message.threadId] = firstTs;
    state.agents[firstTs] = agentPersonId;
    saveState();
    log(`bridged new DM thread: ${nameForPersonId(agentPersonId)} → Slack ${firstTs}`);
  };
  if (!(await postParts(message, chunkText(text), dmChannelId, rootTs, rootTs === undefined ? mintRoot : undefined))) {
    return false;
  }
  health.lastBridgedAt = new Date().toISOString(); // piggybacks on the next saveState
  log(`bridged ${message.id} → DM ${nameForPersonId(agentPersonId)}`);
  return true;
}

/** D-N7-3: a room-thread message on a MAPPED room → TOP-LEVEL channel post
 * with the roster-stamped header (identity from the roster, never text). */
async function bridgeRoomMessage(message, thread) {
  const lane = roomChannels.get(message.threadId);
  if (lane === undefined) return true; // unmapped room/agent↔agent — settled, out of scope
  const text = `*${nameForPersonId(message.senderId)}* · ${timeOf(message.createdAt)}\n${message.body?.text ?? ''}`;
  if (!(await postParts(message, chunkText(text), lane.channelId, undefined))) return false;
  health.lastBridgedAt = new Date().toISOString(); // F1: room outbound counts
  log(`bridged ${message.id} → ${lane.label} ${lane.channelId}`);
  return true;
}

async function bridgeDelivery(delivery) {
  if (delivery.state !== 'failed') return; // honesty table: only failures mark
  const posted = postedMessages.get(delivery.messageId);
  if (posted === undefined) {
    vlog(`failed delivery for unposted ${delivery.messageId} — no Slack thread to amend`);
    return;
  }
  await postToSlack({ text: `⚠ delivery failed — ${delivery.messageId}`, thread_ts: posted.ts }, posted.channelId);
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
      const data = await appRest(`/api/door/user/messages?threadId=${encodeURIComponent(thread.id)}`);
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

const appWsUrl = () => `${APP_BASE.replace(/^http/, 'ws')}/ws?token=${appToken()}`;

function backoffMs(retryCount) {
  return Math.min(BACKOFF_BASE_MS * 2 ** retryCount, BACKOFF_MAX_MS);
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
    log(`app socket connected (${APP_BASE}/ws)`);
    // The nvk-ws server has no server-side resume: the REST refetch (sequence
    // cursor, F1 global order, F4 settle-before-advance) IS the catch-up path.
    void enqueueFrame(refetchFromTip);
    // F2: configured-but-unresolved channels retry resolution on every
    // (re)connect — an app recovery brings the lane up without a restart.
    if (channelsPending()) void resolveChannels();
  });
  appSocket.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (frame?.type !== 'event') return;
    // 'message' fires for every accepted send (Bench, door, or lane); the
    // refetch dedupes via the sequence cursor. 'presence' keeps names fresh.
    if (frame.name === 'message') { void enqueueFrame(refetchFromTip); return; }
    if (frame.name === 'presence' || frame.name === 'conversation') void refreshRoster();
  });
  appSocket.on('close', () => {
    const backoff = backoffMs(appRetryCount);
    appRetryCount += 1;
    warn(`app socket closed — reconnecting in ${backoff}ms (is nvk-server up on ${APP_BASE}?)`);
    setTimeout(connectAppSocket, backoff);
  });
  appSocket.on('error', (error) => vlog(`app socket error: ${error.message}`)); // close follows
}

// --- inbound: Slack → capability -------------------------------------------------

async function sendToAgent(agentName, body) {
  const response = await fetch(`${APP_BASE}/api/door/user/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${appToken()}` },
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

// D-N7-3: <@U…> mentions decode to a display name (users.info behind a
// bounded cache — cosmetic, a lookup failure leaves the raw mention).
const mentionCache = new Map(); // slackUserId → display name (bounded)
const MENTION_CACHE_MAX = 200;

async function nameForSlackUser(userId) {
  if (mentionCache.has(userId)) return mentionCache.get(userId);
  let name = userId;
  try {
    const data = await slackApi('users.info', { query: { user: userId } });
    name = data.user?.profile?.display_name || data.user?.profile?.real_name || data.user?.name || userId;
  } catch (error) {
    vlog(`users.info failed for ${userId}: ${error.message}`);
  }
  if (mentionCache.size >= MENTION_CACHE_MAX) mentionCache.delete(mentionCache.keys().next().value);
  mentionCache.set(userId, name);
  return name;
}

/** Full inbound decode: wire text + <@U…> mentions → readable text. F9:
 * mentions match on the RAW wire text FIRST — a literally typed "<@U123>"
 * arrives escaped (&lt;@U123&gt;) and must stay literal, never decode. */
async function decodeInboundText(text) {
  const mentions = [...text.matchAll(/<@([A-Z0-9_]+)>/g)];
  let result = decodeSlackText(text);
  for (const mention of mentions) {
    result = result.replace(mention[0], `@${await nameForSlackUser(mention[1])}`);
  }
  return result;
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

const MENTION_FALLBACK = /^@([A-Za-z0-9._-]+)\s+([\s\S]+)$/;

/** Top-level "@agentName body" opener. Roster titles are multi-word
 * ('Manager Kimi Messages', 'Fable · claude'), so the parse is a
 * LONGEST-prefix match against the live roster (case-insensitive; the title
 * must be followed by whitespace or end-of-text) — the single-word regex
 * sent only the first word and 404'd. Falls back to the single-word shape
 * when no roster title matches (the honest 404 + roster hint path).
 * {name:null} = no parse — the caller posts the guidance, never an empty send. */
function parseMention(text) {
  const after = text.slice(1); // drop the leading '@'
  let best = null;
  for (const agent of roster) {
    const title = typeof agent.title === 'string' ? agent.title : '';
    if (title === '' || !after.toLowerCase().startsWith(title.toLowerCase())) continue;
    const rest = after.slice(title.length);
    if (rest !== '' && !/^\s/.test(rest)) continue; // a name boundary must follow
    if (best === null || title.length > best.length) best = title;
  }
  if (best !== null) {
    const body = after.slice(best.length).trim();
    return body === '' ? { name: null, body: null } : { name: best, body };
  }
  const fallback = MENTION_FALLBACK.exec(text);
  return fallback === null ? { name: null, body: null } : { name: fallback[1], body: fallback[2] };
}

async function handleChrisMessage(event) {
  const text = (await decodeInboundText(event.text ?? '')).trim();
  if (event.thread_ts !== undefined) {
    const stored = state.agents[event.thread_ts];
    if (stored === undefined) {
      await postToSlack({ text: 'unknown thread — start with @agentName', thread_ts: event.thread_ts });
      return;
    }
    await forwardToAgent(await nameForSend(stored), text, event.thread_ts);
    return;
  }
  const mention = parseMention(text);
  if (mention.name === null) {
    await postToSlack({ text: 'unknown thread — start with @agentName' });
    return;
  }
  await forwardToAgent(mention.name, mention.body, undefined);
}

// D-N7-4 (honest identity): ANY non-chris Slack user on a mapped channel
// drops with ONE loud line per user. /user/send always speaks as the human
// principal — bridging another user would stamp chris's name on their
// words, so non-chris users stay out until N8's external principals.
const nonOwnerWarned = new Set();

/** true when the Slack user may bridge inbound (owner only, until N8). */
function isOwnerSlackUser(slackUserId) {
  if (slackUserId === config.chrisUserId) return true;
  if (!nonOwnerWarned.has(slackUserId)) {
    nonOwnerWarned.add(slackUserId);
    warn(`non-owner Slack user ${slackUserId} posted on a bridged channel — dropped — external principals arrive at N8 (the sender can only be the workspace owner until then)`);
  }
  return false;
}

/** D-N7-6: an inbound body over the 32 KiB contract cap gets a posted note
 * instead of a failed send (the capability would reject it anyway). F7: the
 * cap is BYTES — measure bytes here (chunk slicing stays char-based for
 * display; a multi-byte body can legitimately note earlier than it chunks). */
function tooBigForBridge(text) {
  return Buffer.byteLength(text, 'utf8') > SLACK_PART_SIZE;
}

/** D-N7-4: one message on a MAPPED channel → a room send as the human.
 * Slack-thread replies bridge identically — the room is linear. D-N8-3: a
 * configured EXTERNAL goes through their own door connection instead. */
async function handleChannelMessage(event, lane) {
  const slackUserId = event.user ?? event.message?.user;
  const external = externalBySlackUser.get(slackUserId);
  if (external !== undefined) return forwardViaExternal(external, lane, event);
  if (!isOwnerSlackUser(slackUserId)) return;
  const text = (await decodeInboundText(event.text ?? '')).trim();
  if (tooBigForBridge(text)) {
    await postToSlack({ text: '⚠ too big to bridge (>32 KiB) — not forwarded', thread_ts: event.thread_ts }, event.channel);
    return;
  }
  await forwardToAgent(lane.label, text, event.thread_ts, event.channel);
}

/** D-N7-6: edits/deletes are follow-up NOTES in the app lane — history is
 * immutable, the note is a NEW message, never a mutation. */
async function handleSubtypeNote(event, lane) {
  const changed = event.subtype === 'message_changed';
  const inner = changed ? event.message : event.previous_message;
  const innerUser = inner?.user ?? event.user;
  if (isOwnEcho({ ...event, user: innerUser, bot_id: event.bot_id })) return;
  if (!isOwnerSlackUser(innerUser)) return; // the same chris-or-drop rule
  const note = changed
    ? `[edited on Slack] ${(await decodeInboundText(inner?.text ?? '')).trim()}`
    : '[deleted on Slack]';
  if (lane !== null) {
    await forwardToAgent(lane.label, note, undefined, event.channel);
    return;
  }
  const threadTs = inner?.thread_ts ?? event.thread_ts;
  const stored = threadTs === undefined ? undefined : state.agents[threadTs];
  if (stored === undefined) return; // edit on an unknown DM thread — nothing to note to
  await forwardToAgent(await nameForSend(stored), note, threadTs);
}

async function forwardToAgent(agentName, body, threadTs, channelId) {
  try {
    const result = await sendToAgent(agentName, body);
    log(`slack → ${agentName}: committed ${result.messageId ?? '?'}`);
    touchHealth({ lastBridgedAt: new Date().toISOString() });
  } catch (error) {
    warn(`send to ${agentName} failed: ${error.message}`);
    touchHealth({ lastError: error.message });
    await postToSlack({
      text: `✗ could not reach *${agentName}*: ${error.message}`,
      ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
    }, channelId);
  }
}

/** Echo guards — belt and braces. Any one match drops the event. */
function isOwnEcho(event) {
  if (event.bot_id !== undefined) return true;                    // any bot post
  if (event.user === botUserId) return true;                      // our bot user (auth.test)
  if (event.metadata?.event_type === META_TAG) return true;       // our tagged posts
  return false;
}

// --- D-N8-3/4: the DEC-17 door clients, one per external principal --------------
// A mapped EXTERNAL Slack user's channel message goes through the door AS
// THEM (their own nvkt_ credential) — identity is stamped by the wire auth,
// never text, never as chris. The connection also holds a ws Presence: the
// external's deliveries ride it and CLOSE THE LOOP (delivered = handed to
// the Slack lane). Delivery frames are confirmation-only — content posts
// stay on the N7 room path, never double-posted.

const DOOR_URL = process.env.NVK_SLACK_BRIDGE_DOOR_URL ?? 'ws://127.0.0.1:3032';
const externalBySlackUser = new Map(); // slackUserId → door client (below)
let externalRequestCounter = 0;

function makeExternalDoor(entry) {
  const client = {
    entry,
    socket: null,
    ready: false,
    attempts: 0,
    pending: new Map(),
    connect: () => connectExternalDoor(client),
    send: (frame) => {
      if (client.socket !== null && client.ready) client.socket.send(JSON.stringify(frame));
    },
  };
  return client;
}

function externalCall(client, frame) {
  externalRequestCounter += 1;
  const requestId = `bridge-ext-${externalRequestCounter}`;
  return new Promise((resolve) => {
    client.pending.set(requestId, resolve);
    client.socket.send(JSON.stringify({ ...frame, requestId }));
  });
}

async function externalHandshake(client) {
  const authenticated = await externalCall(client, {
    kind: 'authenticate', credential: { token: client.entry.token }, protocolVersion: '1.0.0',
  });
  if (authenticated.kind === 'error') throw new Error(`external auth failed: ${authenticated.error?.message}`);
  const opened = await externalCall(client, {
    kind: 'command', name: 'OpenPresence', input: { transport: 'ws', clientLabel: `slack-${client.entry.slackUserId}` },
  });
  if (opened.kind === 'error') throw new Error(`external OpenPresence failed: ${opened.error?.message}`);
  client.ready = true;
  log(`external door ready: ${client.entry.displayName ?? client.entry.slackUserId} (${client.entry.personId})`);
}

function onExternalFrame(client, frame) {
  if (frame.requestId !== undefined && client.pending.has(frame.requestId)) {
    client.pending.get(frame.requestId)(frame);
    client.pending.delete(frame.requestId);
    return;
  }
  if (frame.kind === 'delivery') {
    // D-N8-4: confirmation ONLY — content posts stay on the N7 room path.
    vlog(`delivery confirmed for ${client.entry.slackUserId}: ${frame.message?.id ?? '?'}`);
    return;
  }
  if (frame.kind === 'error' && frame.error?.name === 'NotAuthenticated') client.socket.close(); // reconnect + re-auth
}

function connectExternalDoor(client) {
  client.socket = new WebSocket(DOOR_URL);
  client.socket.on('open', () => {
    client.attempts = 0;
    externalHandshake(client).catch((error) => {
      warn(`external handshake failed for ${client.entry.slackUserId}: ${error.message}`);
      client.socket.close();
    });
  });
  client.socket.on('message', (data) => {
    try {
      onExternalFrame(client, JSON.parse(data.toString('utf8')));
    } catch {
      // malformed frames never reach the consumer (protocol discipline)
    }
  });
  client.socket.on('close', () => {
    client.ready = false;
    client.attempts += 1;
    const waitMs = Math.min(500 * 2 ** (client.attempts - 1), 8000);
    vlog(`external door closed (${client.entry.slackUserId}) — reconnecting in ${waitMs}ms`);
    setTimeout(() => connectExternalDoor(client), waitMs);
  });
  client.socket.on('error', () => client.socket.close());
}

/** Boot: one door connection per configured external (none when unconfigured). */
function connectExternals() {
  for (const entry of config.externals) {
    externalBySlackUser.set(entry.slackUserId, makeExternalDoor(entry));
    externalBySlackUser.get(entry.slackUserId).connect();
  }
  if (config.externals.length > 0) log(`external door clients: ${config.externals.length} (${DOOR_URL})`);
}

/** D-N8-3: one external's channel message → a door SendMessage as THEM. */
async function forwardViaExternal(client, lane, event) {
  const text = (await decodeInboundText(event.text ?? '')).trim();
  if (tooBigForBridge(text)) {
    await postToSlack({ text: '⚠ too big to bridge (>32 KiB) — not forwarded', thread_ts: event.thread_ts }, event.channel);
    return;
  }
  if (!client.ready) {
    warn(`external door DOWN for ${client.entry.slackUserId} — message dropped loudly (never bridged as anyone else)`);
    await postToSlack({
      text: `✗ could not reach the messaging door as *${client.entry.displayName ?? client.entry.slackUserId}* — reconnect pending, try again`,
      thread_ts: event.thread_ts,
    }, event.channel);
    return;
  }
  const result = await externalCall(client, {
    kind: 'command',
    name: 'SendMessage',
    input: {
      address: `thread:${lane.threadId}`,
      body: { text },
      priority: 'normal',
      clientMessageId: `bridge-ext_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  if (result.kind === 'error') {
    warn(`external send failed for ${client.entry.slackUserId}: ${result.error?.message}`);
    touchHealth({ lastError: result.error?.message });
    await postToSlack({
      text: `✗ could not reach *${client.entry.displayName ?? client.entry.slackUserId}*: ${result.error?.message}`,
      thread_ts: event.thread_ts,
    }, event.channel);
    return;
  }
  log(`slack → ${lane.label} as ${client.entry.displayName ?? client.entry.slackUserId} (external door): committed ${result.result?.messageId ?? '?'}`);
  touchHealth({ lastBridgedAt: new Date().toISOString() });
}

function handleSlackEvent(event) {
  if (event?.type !== 'message') return;
  if (isOwnEcho(event)) return; // D-N7-5: the three guards apply to every lane
  const lane = channelRooms.get(event.channel) ?? null;
  if (lane === null && event.channel_type !== 'im') {
    vlog(`dropping event on unmapped channel ${event.channel}`);
    return;
  }
  const key = `${event.channel}:${event.ts}`;
  enqueueSlack(async () => {
    if (alreadyHandled(key)) {
      vlog(`redelivered event ${key} — dropped`);
      return;
    }
    if (event.subtype === 'message_changed' || event.subtype === 'message_deleted') {
      await handleSubtypeNote(event, lane);
      return;
    }
    if (event.subtype !== undefined) return; // other subtypes stay out of scope
    if (lane !== null) return handleChannelMessage(event, lane);
    if (event.user !== config.chrisUserId) return; // the DM lane is chris only
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
    .then(resolveChannels) // D-N7-2: channel↔room map (label enrichment; dormant when unconfigured)
    .then(() => {
      connectAppSocket();
      connectSlackSocket();
      connectExternals(); // D-N8-3: door clients (no-op when externals is absent/empty)
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
