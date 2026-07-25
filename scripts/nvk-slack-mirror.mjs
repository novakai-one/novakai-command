#!/usr/bin/env node
// nvk slack-mirror — read-only mirror of team messaging into a Slack channel
// via an Incoming Webhook. One-way: this script never writes to the backend.
//
// N5 (D-N5-2): NO journal file, NO byte-offset tail. The mirror is a CLIENT
// of the messaging capability: backlog reads ride the server-owned /user
// routes, and live events ride the browser dialect (messaging-v2-sub over
// /ws — MessageCommitted + DeliveryUpdated), exactly like the Messages tab.
// The N7 two-way bridge grows out of scripts/team/capabilityClient.mjs +
// slackFormat.mjs — this main stays thin.
//
//   node scripts/nvk-slack-mirror.mjs [--backlog N] [--dry-run] [--verbose] [--server <url>]
//
// Webhook URL: env NVK_SLACK_WEBHOOK_URL wins; fallback is
// .novakai-command/slack-mirror.json ({"webhookUrl": "..."}). Never hardcoded.
// See docs/operations/SLACK-MIRROR.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openCapabilitySocket,
  resolveRoster,
  resolveThreadLanes,
  fetchThreadMessages,
} from './team/capabilityClient.mjs';
import { formatNew, formatStatus } from './team/slackFormat.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 1) && true : false; };
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };

const DRY_RUN = flag('--dry-run');
const VERBOSE = flag('--verbose');
const BACKLOG = Math.max(0, Number.parseInt(opt('--backlog') ?? '20', 10) || 0);
const SERVER = opt('--server') || undefined;
const CONFIG_FILE = path.join(ROOT, '.novakai-command', 'slack-mirror.json');

const POST_GAP_MS = 1100;      // Slack webhooks allow ~1 msg/sec
const SEEN_MAX = 5000;
const RETRY_DELAY_MS = 5000;
const MESSAGE_CACHE_MAX = 2000;

const log = (...a) => console.log('[slack-mirror]', ...a);
const warn = (...a) => console.warn('[slack-mirror] WARN:', ...a);
const vlog = (...a) => { if (VERBOSE) log(...a); };

// --- webhook resolution ------------------------------------------------------

function resolveWebhook() {
  const fromEnv = process.env.NVK_SLACK_WEBHOOK_URL;
  if (fromEnv) return { url: fromEnv, source: 'NVK_SLACK_WEBHOOK_URL' };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (typeof parsed.webhookUrl === 'string' && parsed.webhookUrl) {
        return { url: parsed.webhookUrl, source: CONFIG_FILE };
      }
    }
  } catch (error) {
    warn(`could not read ${CONFIG_FILE}: ${error.message}`);
  }
  return null;
}

const webhook = DRY_RUN ? null : resolveWebhook();
if (!DRY_RUN && !webhook) {
  console.error(`[slack-mirror] no Slack webhook configured.

Set the env var:
  export NVK_SLACK_WEBHOOK_URL="https://hooks.slack.com/services/…"

or create the config file:
  echo '{"webhookUrl":"https://hooks.slack.com/services/…"}' > ${CONFIG_FILE}

Create a webhook at https://api.slack.com/apps → Incoming Webhooks.
See docs/operations/SLACK-MIRROR.md.`);
  process.exit(1);
}

// --- seen-id tracking (bounded) ----------------------------------------------
//
// SEEN_MAX bound (F5, accepted): at most 5000 ids are remembered; once an id
// is evicted, a very late status amendment for it could re-post ONCE. With
// ~1 msg/sec Slack pacing that's hours of traffic — the bound is deliberate.

const seen = new Map(); // id → last status posted
function remember(id, status) {
  if (seen.has(id)) seen.delete(id);
  seen.set(id, status);
  if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
}

// --- send queue (spaced posts, one retry) -------------------------------------

const queue = [];
let sending = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postOnce(payload) {
  const res = await fetch(webhook.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Slack HTTP ${res.status} ${await res.text().catch(() => '')}`);
}

async function drain() {
  if (sending) return;
  sending = true;
  while (queue.length > 0) {
    const payload = queue.shift();
    if (DRY_RUN) {
      const meta = [
        payload.username ? `user=${payload.username}` : null,
        payload.icon_emoji ? `emoji=${payload.icon_emoji}` : null,
        payload.attachments.length ? `color=${payload.attachments.map((a) => a.color).join(',')}` : null,
      ].filter(Boolean).join(' ');
      console.log(`[dry-run]${meta ? ` (${meta})` : ''} ${payload.text}`);
      continue;
    }
    try {
      await postOnce(payload);
      vlog(`posted: ${payload.text.split('\n')[0]}`);
    } catch (first) {
      warn(`post failed (${first.message}); retrying in ${RETRY_DELAY_MS / 1000}s`);
      await sleep(RETRY_DELAY_MS);
      try {
        await postOnce(payload);
        vlog(`posted on retry: ${payload.text.split('\n')[0]}`);
      } catch (second) {
        warn(`post failed again (${second.message}); dropping message, continuing`);
      }
    }
    await sleep(POST_GAP_MS);
  }
  sending = false;
}

const enqueue = (payload) => { if (payload) { queue.push(payload); void drain(); } };

// --- capability → mirror translation -------------------------------------------

let nameFor = await resolveRoster(SERVER);
let lanes = await resolveThreadLanes(SERVER);

// F7: names were resolved ONCE at startup (renames and new lanes kept stale
// labels forever). Re-resolve over the user routes every 5 min — a route
// poll from a manual ops script, never a journal tail.
const RERESOLVE_MS = 5 * 60_000;
async function reresolveNames() {
  try {
    nameFor = await resolveRoster(SERVER);
    lanes = await resolveThreadLanes(SERVER);
  } catch (error) {
    warn(`roster re-resolve failed (keeping last): ${error.message}`);
  }
}
setInterval(() => { void reresolveNames(); }, RERESOLVE_MS).unref();
/** messageId → { senderId, threadId } so a failure line can name its sender. */
const messageCache = new Map();
let lastSequence = 0;

function cacheMessage(message) {
  if (messageCache.has(message.id)) messageCache.delete(message.id);
  messageCache.set(message.id, { senderId: message.senderId, threadId: message.threadId });
  if (messageCache.size > MESSAGE_CACHE_MAX) messageCache.delete(messageCache.keys().next().value);
}

const laneFor = (threadId) => lanes.get(threadId) ?? threadId;

function advanceSequence(sequence) {
  if (typeof sequence === 'number' && sequence > lastSequence) lastSequence = sequence;
}

/** One capability Message → a Slack payload (status semantics: committed IS
 * durable truth → 'delivered', matching the in-app honesty table). */
function onCommitted(event) {
  const message = event.message;
  cacheMessage(message);
  const prior = seen.get(message.id);
  if (prior === 'delivered') return;
  enqueue(formatNew({
    id: message.id,
    from: nameFor(message.senderId),
    to: laneFor(message.threadId),
    delivery: message.priority === 'urgent' ? 'interrupt' : 'normal',
    body: message.body.text,
    createdAt: message.createdAt,
  }));
  remember(message.id, 'delivered');
}

/** A terminal delivery failure → one Slack status line. F7: a failure whose
 * message left the cache attributes to a neutral 'unknown' — never to the
 * human (blaming chris for someone else's failure was pure disinformation). */
function onDeliveryUpdated(event) {
  const delivery = event.delivery;
  if (delivery.state !== 'failed' || seen.get(delivery.id) === 'failed') return;
  const origin = messageCache.get(delivery.messageId);
  enqueue(formatStatus({
    id: delivery.messageId,
    from: origin ? nameFor(origin.senderId) : 'unknown',
    to: laneFor(origin?.threadId ?? delivery.threadId),
    createdAt: delivery.updatedAt,
    status: 'failed',
  }));
  remember(delivery.id, 'failed');
}

function onFrame(frame) {
  if (frame.kind === 'ended') {
    warn(`subscription ended (${frame.reason ?? 'unknown'}) — reconnecting from cursor s_${lastSequence}`);
    socket.close();
    return;
  }
  if (frame.kind !== 'event' || !frame.event) return;
  advanceSequence(frame.sequence ?? frame.event.sequence);
  if (frame.event.message) onCommitted(frame.event);
  else if (frame.event.delivery) onDeliveryUpdated(frame.event);
}

// --- backlog (server-owned reads, folded like the live path) -------------------

/** F5: --backlog 0 must be LIVE-ONLY. Seed the resume cursor at the current
 * tip (max message sequence across lanes) without posting anything — the old
 * behavior subscribed from sequence 0 and flooded Slack with all history.
 * The tip is message-sequence based: a delivery-update committed after the
 * latest message can still replay once (deduped by `seen`), never the whole
 * history. */
async function seedTip() {
  for (const threadId of lanes.keys()) {
    for (const message of await fetchThreadMessages(SERVER, threadId)) {
      cacheMessage(message);
      advanceSequence(message.sequence);
    }
  }
}

async function loadBacklog(n) {
  if (n === 0) {
    await seedTip();
    return;
  }
  const all = [];
  for (const threadId of lanes.keys()) {
    for (const message of await fetchThreadMessages(SERVER, threadId)) {
      cacheMessage(message);
      all.push(message);
    }
  }
  all.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const message of all.slice(-n)) {
    onCommitted({ message, sequence: message.sequence });
    advanceSequence(message.sequence);
  }
}

// --- main ------------------------------------------------------------------------

log(`mode: ${DRY_RUN ? 'dry-run (no Slack posts)' : `live → Slack via ${webhook.source}`} · backlog ${BACKLOG} · capability dialect (no journal)`);
await loadBacklog(BACKLOG);

const socket = openCapabilitySocket({
  server: SERVER,
  since: () => (lastSequence > 0 ? `s_${lastSequence}` : undefined),
  onFrame,
  onRetryWait: (waitMs) => vlog(`socket closed; retrying in ${waitMs}ms`),
  log: vlog,
});

process.on('SIGINT', () => {
  socket.close();
  log(`stopping (SIGINT). ${queue.length} message(s) still queued — drained or dropped on exit.`);
  process.exit(0);
});
