// nvk-slack-bridge tests — fake Slack (Web API HTTP + Socket Mode ws) and a
// fake app backend (user routes + /ws live dialect + /api/agents) prove the
// two-way lane. The fakes mirror the REAL server: agents-changed is NOT
// pushed on connect (src/backend/server/agents.ts only broadcasts on
// launch/exit/rename), /user/messages serves a seedable store so the
// ended→refetch path is exercised for real.
//
// Coverage: (a) post shape, (b) send body, (c) loop hunt, (d) restart resume,
// (e) unknown-thread guidance — plus the law-#6 audit regressions:
// F1 cross-thread refetch ordering, F2 roster fetched at boot, F3 concurrent
// frames share one Slack root, F4 cursor only advances after a successful
// post, F5 Slack redelivery dedupe, F6 heartbeat zombie reconnect,
// F8 mrkdwn decode inbound, F9 rename keeps routing.
// Plain assertions, no framework — run: node scripts/nvk-slack-bridge.test.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(HERE, 'nvk-slack-bridge.mjs');

const CHRIS = 'U_CHRIS';
const BOT = 'U_BOT';
const DM_CHANNEL = 'D_CHRIS';
const FABLE = { agentId: 'agent_fable', title: 'fable' };
const GABLE = { agentId: 'agent_gable', title: 'gable' };
const MABEL = { agentId: 'agent_mabel', title: 'mabel' };
const THREAD_FABLE = 'thread_dm_fable';
const THREAD_GABLE = 'thread_dm_gable';
const THREAD_MABEL = 'thread_dm_mabel';
const PERSON_FABLE = 'person_agent-fable';

const THREADS = [
  { id: THREAD_FABLE, threadKind: 'direct', direct: { pair: ['person_user-chris', PERSON_FABLE] } },
  { id: THREAD_GABLE, threadKind: 'direct', direct: { pair: ['person_user-chris', 'person_agent-gable'] } },
  { id: THREAD_MABEL, threadKind: 'direct', direct: { pair: ['person_user-chris', 'person_agent-mabel'] } },
  { id: 'thread_room_team', threadKind: 'team', room: { authority: 'auth', externalId: 'team' }, label: '#team' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  const dbg = globalThis.__dbg ? `
--- daemon output ---
${globalThis.__dbg()}` : '';
  throw new Error(`timed out waiting for: ${label}${dbg}`);
}

// --- fake Slack: Web API endpoints + Socket Mode ws on one server ---------------

function startFakeSlack() {
  const posts = [];
  const acks = [];
  let tsCounter = 0;
  let failCount = 0;
  let pings = 0;
  let socketMode = null;
  const nextTs = () => { tsCounter += 1; return `1700.${String(tsCounter).padStart(6, '0')}`; };

  const routes = {
    'POST /auth.test': () => ({ ok: true, user_id: BOT, bot_id: 'B_BOT' }),
    'GET /users.lookupByEmail': () => ({ ok: true, user: { id: CHRIS } }),
    'POST /conversations.open': () => ({ ok: true, channel: { id: DM_CHANNEL } }),
    'POST /apps.connections.open': (port) => ({ ok: true, url: `ws://127.0.0.1:${port}/socketmode` }),
  };

  const server = http.createServer((request, response) => {
    const reply = (data) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    const key = `${request.method} ${request.url.split('?')[0]}`;
    if (key === 'POST /chat.postMessage') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const payload = JSON.parse(body);
        if (failCount > 0) {
          failCount -= 1;
          reply({ ok: false, error: 'slack_is_sad' }); // Slack-style 200 + ok:false
          return;
        }
        posts.push({ ...payload, ts: nextTs() });
        reply({ ok: true, ts: posts.at(-1).ts, channel: payload.channel });
      });
      return;
    }
    const handler = routes[key];
    if (handler === undefined) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => reply(handler(server.address().port)));
      return;
    }
    reply(handler(server.address().port));
  });

  const wss = new WebSocketServer({ server, path: '/socketmode' });
  wss.on('connection', (socket) => {
    socketMode = socket;
    socket.on('ping', () => { pings += 1; });
    socket.send(JSON.stringify({ type: 'hello' }));
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.envelope_id !== undefined) acks.push(frame.envelope_id);
    });
  });

  let envelopeCounter = 0;
  const sendSlackEvent = (event) => {
    assert.ok(socketMode, 'socket mode client not connected yet');
    envelopeCounter += 1;
    socketMode.send(JSON.stringify({
      envelope_id: `env_${envelopeCounter}`,
      type: 'events_api',
      payload: { event },
    }));
  };

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port, posts, acks, sendSlackEvent,
      failNextPosts: (n) => { failCount = n; },
      pings: () => pings,
      close: () => { socketMode?.terminate(); wss.close(); server.close(); },
    }));
  });
}

// --- fake app backend: user routes + /api/agents + /ws live dialect --------------
// Honest to the real server: NO agents-changed on connect; the roster is a
// REST read; /user/messages serves a seedable store for refetch tests.

function startFakeApp() {
  const sends = [];
  const subs = [];
  const apiAgentsCalls = [];
  let pings = 0;
  let connectionCount = 0;
  const sockets = new Set();
  let roster = [FABLE, GABLE, MABEL];
  const messageStore = new Map(); // threadId → messages (REST catch-up source)

  const server = http.createServer((request, response) => {
    const json = (status, data) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    const url = new URL(request.url, 'http://x');
    if (request.method === 'GET' && url.pathname === '/api/agents') {
      apiAgentsCalls.push(1);
      json(200, { agents: roster });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/messaging/v2/user/threads') {
      json(200, { threads: THREADS });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/messaging/v2/user/messages') {
      json(200, { messages: messageStore.get(url.searchParams.get('threadId')) ?? [] });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/messaging/v2/user/send') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(body);
        sends.push(parsed);
        if (roster.some((agent) => agent.title === parsed.to)) {
          json(201, { messageId: `msg_app_${sends.length}`, threadId: THREAD_FABLE });
        } else {
          json(404, { error: `recipient "${parsed.to}" is not a live agent`, roster: roster.map((a) => a.title) });
        }
      });
      return;
    }
    response.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('ping', () => { pings += 1; });
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'messaging-v2-sub') {
        subs.push(frame.since);
        socket.send(JSON.stringify({ event: 'messaging-v2', payload: { kind: 'started' } }));
      }
    });
  });

  const broadcast = (frame) => {
    for (const socket of sockets) socket.send(JSON.stringify(frame));
  };

  const makeMessage = (sequence, overrides = {}) => ({
    id: `msg_${sequence}`, threadId: THREAD_FABLE, senderId: PERSON_FABLE,
    sequence, priority: 'normal', createdAt: new Date().toISOString(),
    body: { text: `body of msg_${sequence}` }, ...overrides,
  });

  const pushMessage = (sequence, overrides = {}) => {
    const message = makeMessage(sequence, overrides);
    broadcast({ event: 'messaging-v2', payload: { kind: 'event', sequence, event: { message } } });
    return message;
  };

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port, sends, subs, apiAgentsCalls, pushMessage,
      pings: () => pings,
      connections: () => connectionCount,
      makeMessage,
      seedGap: (threadId, sequences) => {
        messageStore.set(threadId, sequences.map((sequence) => makeMessage(sequence, {
          threadId, body: { text: `gap body seq_${sequence}` },
        })));
      },
      pushEnded: (reason) => broadcast({ event: 'messaging-v2', payload: { kind: 'ended', reason } }),
      pushAgentsChanged: () => broadcast({ type: 'agents-changed', agents: roster }),
      renameAgent: (agentId, title) => {
        roster = roster.map((agent) => (agent.agentId === agentId ? { ...agent, title } : agent));
      },
      pauseNewestSocket: () => [...sockets].at(-1)?._socket.pause(),
      resumeAll: () => { for (const socket of sockets) socket._socket.resume(); },
      close: () => {
        for (const socket of sockets) socket.terminate();
        wss.close();
        server.close();
      },
    }));
  });
}

// --- daemon lifecycle -------------------------------------------------------------

function startDaemon(env) {
  const child = spawn('node', [DAEMON, ...(process.env.BRIDGE_TEST_VERBOSE ? ['--verbose'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return {
    output: () => output,
    stop: () => new Promise((resolve) => {
      child.on('exit', resolve);
      child.kill('SIGINT');
    }),
  };
}

// --- the run -----------------------------------------------------------------------

const slack = await startFakeSlack();
const app = await startFakeApp();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nvk-slack-bridge-test-'));
const stateFile = path.join(work, 'bridge-state.json');
const configFile = path.join(work, 'bridge.json');
fs.writeFileSync(configFile, JSON.stringify({ chrisUserId: CHRIS }));

const env = {
  ...process.env,
  NVK_SLACK_BOT_TOKEN: 'xoxb-test',
  NVK_SLACK_APP_TOKEN: 'xapp-test',
  NVK_SLACK_API_BASE: `http://127.0.0.1:${slack.port}`,
  NVK_SLACK_BRIDGE_APP_BASE: `http://127.0.0.1:${app.port}`,
  NVK_SLACK_BRIDGE_CONFIG: configFile,
  NVK_SLACK_BRIDGE_STATE: stateFile,
  NVK_SLACK_BRIDGE_RETRY_MS: '300', // test seam: Slack post retry delay
  NVK_SLACK_BRIDGE_PING_MS: '200',  // test seam: heartbeat interval
};

let checks = 0;
const ok = (label) => { checks += 1; console.log(`ok ${checks} — ${label}`); };
const postsWith = (needle) => slack.posts.filter((p) => p.text?.includes(needle));
const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));

let daemon = startDaemon(env);
globalThis.__dbg = () => [daemon.output(), '--- slack posts ---', ...slack.posts.map((p2) => JSON.stringify({ ts: p2.ts, thread_ts: p2.thread_ts, text: p2.text }))].join(' | ');
await waitFor(() => app.subs.length === 1, 'daemon subscribes to the app live feed');
assert.equal(app.subs[0], undefined, 'first subscribe carries no cursor');

// F2: the roster is a REST read at boot — the real server never pushes
// agents-changed on connect, so a daemon that waits for the broadcast posts
// raw personIds and persists them as broken inbound names.
await waitFor(() => app.apiAgentsCalls.length >= 1, 'daemon fetches GET /api/agents at boot');
ok('F2: roster fetched via GET /api/agents at boot (no agents-changed push exists)');

// (a) agent message → Slack post shape; the header uses the ROSTER name even
// though no agents-changed frame was ever sent (F2's end-to-end half).
app.pushMessage(1);
await waitFor(() => slack.posts.length === 1, 'first agent message posted to Slack');
const root = slack.posts[0];
assert.equal(root.channel, DM_CHANNEL);
assert.match(root.text, /^\*fable\* · \d\d:\d\d\nbody of msg_1$/, 'header resolves the roster name, not the raw personId');
assert.equal(root.thread_ts, undefined, 'first message of a DM thread is a root post');
assert.equal(root.metadata?.event_type, 'nvk_slack_bridge', 'outbound posts carry the echo-guard tag');
ok('(a)+F2: agent message → root post, *fable* header without any roster broadcast');

app.pushMessage(2);
await waitFor(() => slack.posts.length === 2, 'second agent message posted to Slack');
assert.equal(slack.posts[1].thread_ts, root.ts, 'same capability thread → same Slack thread');
ok('(a) follow-up in the same agent DM thread → Slack thread reply');

// Never mirror chris's own capability messages back into Slack.
app.pushMessage(3, { senderId: 'person_user-chris', body: { text: 'chris typing in the app' } });
// Room traffic is out of scope for v0 (DMs only).
app.pushMessage(4, { threadId: 'thread_room_team', body: { text: 'room noise' } });
await sleep(400);
assert.equal(slack.posts.length, 2, "chris's own messages and room traffic are not bridged");
ok('(a) chris echo + room traffic stay out of Slack');

// (b) chris's Slack thread reply → /user/send to the thread's agent.
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: 'reply from slack', thread_ts: root.ts, ts: '1800.000001' });
await waitFor(() => app.sends.length === 1, 'thread reply reaches the capability');
assert.deepEqual(app.sends[0], { to: 'fable', body: 'reply from slack' });
ok('(b) Slack thread reply → /api/messaging/v2/user/send {to: agent, body}');

// Top-level "@agentName text" opens a DM to that agent.
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: '@fable hi there', ts: '1800.000002' });
await waitFor(() => app.sends.length === 2, 'top-level mention reaches the capability');
assert.deepEqual(app.sends[1], { to: 'fable', body: 'hi there' });
ok('(b) top-level "@fable hi there" → /user/send {to: fable, body: hi there}');

// A failed send surfaces honestly in Slack (404 + roster hint from the route).
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: '@ghost hi', ts: '1800.000003' });
await waitFor(() => postsWith('could not reach').length === 1, 'failed send posts the Slack-side error');
ok('(b) unknown agent → honest Slack error with the route\'s roster hint');

// (c) LOOP HUNT — the daemon's own posts echoed back must never re-enter the
// capability. Guard 1: bot_id. Guard 2: our bot's user id (auth.test).
// Guard 3: the metadata tag, probed with a shape that has neither bot marker
// (an integration replaying our tagged payload) so the tag alone is tested.
const sendsBeforeLoop = app.sends.length;
slack.sendSlackEvent({ type: 'message', channel_type: 'im', bot_id: 'B_BOT', user: BOT, text: '@fable loop via bot_id', thread_ts: root.ts, ts: '1800.000004' });
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: BOT, text: '@fable loop via bot user', thread_ts: root.ts, ts: '1800.000005' });
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: 'U_OTHER', text: '@fable loop via metadata', thread_ts: root.ts, ts: '1800.000006', metadata: { event_type: 'nvk_slack_bridge' } });
await sleep(500);
assert.equal(app.sends.length, sendsBeforeLoop, 'no echo reached the capability');
ok('(c) loop hunt: bot_id, bot user id, and metadata-tag echoes all dropped');

// (e) a reply in a thread the bridge never created → Slack-side guidance.
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: 'hello?', thread_ts: '9999.999999', ts: '1800.000007' });
await waitFor(() => slack.posts.some((p) => p.thread_ts === '9999.999999'), 'guidance posted into the unknown thread');
assert.match(slack.posts.find((p) => p.thread_ts === '9999.999999').text, /unknown thread — start with @agentName/);
assert.equal(app.sends.length, sendsBeforeLoop, 'unknown thread never reaches the capability');
ok('(e) unknown-thread reply → "unknown thread — start with @agentName"');

// F1 — cross-thread refetch ordering: the subscription ends; during the gap
// the global journal interleaves fable{6,9} and gable{7,8}. A per-thread
// refetch that advances the cursor as it goes loses gable 7,8 under fable 9.
app.seedGap(THREAD_FABLE, [6, 9]);
app.seedGap(THREAD_GABLE, [7, 8]);
app.pushEnded('test-gap');
await waitFor(() => postsWith('gap body').length === 4, 'all four gap messages bridged by the refetch');
assert.deepEqual(
  postsWith('gap body').map((p) => p.text.split('\n')[1]),
  ['gap body seq_6', 'gap body seq_7', 'gap body seq_8', 'gap body seq_9'],
  'refetch bridges in GLOBAL sequence order, not per-thread',
);
const gableRoot = postsWith('gap body seq_7')[0];
assert.equal(gableRoot.thread_ts, undefined, 'gable gap messages open their own Slack thread');
assert.equal(postsWith('gap body seq_8')[0].thread_ts, gableRoot.ts, 'gable follow-ups reply in the gable thread');
ok('F1: ended→refetch bridges cross-thread gaps in global sequence order');

// F3 — two live frames for a BRAND-NEW thread, back-to-back: without
// serialized handling both see rootTs===undefined and split one DM into two
// Slack roots.
app.pushMessage(10, { threadId: THREAD_MABEL, senderId: 'person_agent-mabel', body: { text: 'mabel one' } });
app.pushMessage(11, { threadId: THREAD_MABEL, senderId: 'person_agent-mabel', body: { text: 'mabel two' } });
const mabelPosts = () => slack.posts.filter((p) => p.text?.startsWith('*mabel*'));
await waitFor(() => mabelPosts().length === 2, 'both mabel messages bridged');
const mabelRoots = mabelPosts().filter((p) => p.thread_ts === undefined);
assert.equal(mabelRoots.length, 1, 'concurrent frames in one DM share exactly one Slack root');
assert.equal(mabelPosts().find((p) => p.thread_ts !== undefined).thread_ts, mabelRoots[0].ts);
ok('F3: concurrent frames for a new thread → one root + one reply, never two roots');

// F4 — cursor advances only AFTER the Slack post lands: both post attempts
// fail, the cursor must not move, and the server's at-least-once replay must
// be bridged (not deduped away by a premature cursor).
slack.failNextPosts(2); // initial attempt + the one retry
app.pushMessage(12);
await waitFor(() => readState().cursor >= 11, 'cursor settled after mabel');
await sleep(1200); // both failed attempts (300ms retry seam) have run their course
assert.equal(readState().cursor, 11, 'failed Slack post never advances the persisted cursor');
app.pushMessage(12); // the server replays on resume — at-least-once is the contract
await waitFor(() => postsWith('body of msg_12').length === 1, 'replayed message bridged after the failure');
await waitFor(() => readState().cursor === 12, 'cursor advances once the post lands');
ok('F4: failed post holds the cursor; the at-least-once replay is bridged, then the cursor moves');

// F8 — inbound mrkdwn fidelity: Slack escapes & < > and wraps links; the
// capability gets readable text, not Slack wire format.
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: '@fable a &amp; b &lt;tag&gt; <https://ex.com|Ex> <https://plain.io>', ts: '1800.000008' });
await waitFor(() => app.sends.length === sendsBeforeLoop + 1, 'decoded mention reaches the capability');
assert.deepEqual(app.sends.at(-1), { to: 'fable', body: 'a & b <tag> Ex (https://ex.com) https://plain.io' });
ok('F8: inbound text is unescaped and <url|label> links are expanded');

// F5 — Slack redelivers an event whose ack was lost (same channel+ts): the
// capability must see it exactly once.
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: '@fable exactly once', ts: '1800.000009' });
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: '@fable exactly once', ts: '1800.000009' });
await sleep(600);
const onceSends = app.sends.filter((s) => s.body === 'exactly once');
assert.equal(onceSends.length, 1, 'redelivered Slack event is deduped');
ok('F5: redelivered Slack event (lost ack) → exactly one capability send');

// F9 — a rename mid-flight must not orphan the thread: state maps the Slack
// root to the agent's stable personId, and the display name is resolved at
// forward time (agents-changed refreshes the roster on rename).
app.renameAgent('agent_fable', 'fable-v2');
app.pushAgentsChanged(); // the real server broadcasts on rename — just never on connect
await sleep(200);
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: 'post-rename reply', thread_ts: root.ts, ts: '1800.000010' });
await waitFor(() => app.sends.some((s) => s.body === 'post-rename reply'), 'post-rename reply reaches the capability');
assert.deepEqual(app.sends.at(-1), { to: 'fable-v2', body: 'post-rename reply' });
ok('F9: renamed agent keeps inbound routing (personId-keyed map, forward-time name)');

// (d) restart: state persisted, resume from the cursor, no double-posting.
await daemon.stop();
const persisted = readState();
assert.equal(persisted.cursor, 12, 'cursor persisted at the last seen sequence');
assert.equal(persisted.roots[THREAD_FABLE], root.ts, 'capability thread → Slack root map persisted');
assert.equal(persisted.agents[root.ts], PERSON_FABLE, 'Slack root → agent PERSONID map persisted (rename-safe)');
const postsBeforeRestart = slack.posts.length;

const subsBeforeRestart = app.subs.length;
daemon = startDaemon(env);
await waitFor(() => app.subs.length === subsBeforeRestart + 1, 'restarted daemon resubscribes');
assert.equal(app.subs.at(-1), 's_12', 'resume carries the persisted cursor');
app.pushMessage(12); // replay of an already-bridged message
await sleep(400);
assert.equal(slack.posts.length, postsBeforeRestart, 'replayed frames at/below the cursor are not re-posted');
ok('(d) restart resumes from s_12 and never double-posts');

// …and the inbound maps survive the restart too (now under the renamed title).
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: 'still routed', thread_ts: root.ts, ts: '1800.000011' });
await waitFor(() => app.sends.some((s) => s.body === 'still routed'), 'thread reply after restart reaches the capability');
assert.deepEqual(app.sends.at(-1), { to: 'fable-v2', body: 'still routed' });
ok('(d) thread → agent routing survives the restart');

// F6 — heartbeat: the daemon pings both sockets, and a half-dead app socket
// (server stops reading — no pongs) is terminated and reconnected.
await waitFor(() => app.pings() > 0 && slack.pings() > 0, 'heartbeats observed on both sockets');
ok('F6: ping heartbeat runs on both sockets');
app.pauseNewestSocket();
await waitFor(() => app.connections() >= 3, 'zombie app socket terminated, daemon reconnected');
ok('F6: missed pongs → terminate → reconnect (no silent zombie)');

await daemon.stop();
app.resumeAll();
slack.close();
app.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(`nvk-slack-bridge.test.mjs: all ${checks} checks passed`);
process.exit(0);
