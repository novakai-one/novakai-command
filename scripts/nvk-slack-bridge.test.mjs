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
  { id: 'thread_room_team', threadKind: 'team', room: { authority: 'fleet', externalId: 'team' }, label: '#team' },
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
  let failSkip = 0;
  let rateLimitCount = 0;
  let retryAfterSeconds = 1;
  const attempts429 = [];
  let pings = 0;
  let socketMode = null;
  const nextTs = () => { tsCounter += 1; return `1700.${String(tsCounter).padStart(6, '0')}`; };

  const routes = {
    'POST /auth.test': () => ({ ok: true, user_id: BOT, bot_id: 'B_BOT' }),
    'GET /users.lookupByEmail': () => ({ ok: true, user: { id: CHRIS } }),
    'GET /users.info': () => ({ ok: true, user: { id: 'U_MATE', name: 'mate', profile: { display_name: 'Mate', real_name: 'Mate S' } } }),
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
        if (rateLimitCount > 0) {
          rateLimitCount -= 1;
          attempts429.push(payload);
          response.writeHead(429, { 'retry-after': String(retryAfterSeconds), 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: false, error: 'ratelimited' }));
          return;
        }
        if (failSkip > 0) {
          failSkip -= 1; // let this one land — failures start after the skip
        } else if (failCount > 0) {
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
      failNextPosts: (n, skip = 0) => { failCount = n; failSkip = skip; },
      rateLimitNextPosts: (n, seconds = 1) => { rateLimitCount = n; retryAfterSeconds = seconds; },
      attempts429,
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
  let failThreads = false;
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
      if (failThreads) { json(500, { error: 'threads on fire' }); return; }
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
        if (parsed.to === '#team') {
          json(201, { messageId: `msg_app_${sends.length}`, threadId: 'thread_room_team' });
        } else if (roster.some((agent) => agent.title === parsed.to)) {
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
      addAgent: (agent) => { roster = [...roster, agent]; },
      addThread: (thread) => { THREADS.push(thread); },
      setFailThreads: (flag) => { failThreads = flag; },
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
fs.writeFileSync(configFile, JSON.stringify({
  chrisUserId: CHRIS,
  channels: [{ slackChannelId: 'C_TEAM', room: 'team' }],
}));

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
// D-N7-3: traffic on a MAPPED room thread bridges — top-level in the channel.
app.pushMessage(4, { threadId: 'thread_room_team', body: { text: 'room noise' } });
await waitFor(() => postsWith('room noise').length === 1, 'mapped room traffic bridges to its Slack channel');
const roomNoise = postsWith('room noise')[0];
assert.equal(roomNoise.channel, 'C_TEAM', 'D-N7-3: room posts land on the mapped channel');
assert.equal(roomNoise.thread_ts, undefined, 'D-N7-3: room posts are TOP-LEVEL, never threaded');
assert.match(roomNoise.text, /^\*fable\* · \d\d:\d\d\nroom noise$/, 'identity stamped from the roster, never message text');
assert.equal(roomNoise.metadata?.event_type, 'nvk_slack_bridge', 'room posts carry the echo-guard tag');
assert.ok(!postsWith('chris typing in the app').length, "chris's own messages are never mirrored");
ok('(a)+D-N7-3: mapped room → top-level channel post (header + tag); chris echo stays out');

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
slack.failNextPosts(3); // initial attempt + the bounded retries (D-N7-6: 3 attempts)
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

// — top-level mentions with REAL roster titles: the old single-word regex
// parsed '@Manager Kimi Messages hello' as to:'Manager' → 404. The daemon
// must longest-prefix-match the live roster (spaces and '·' included).
app.addAgent({ agentId: 'agent_kimi', title: 'Manager Kimi Messages' });
app.addAgent({ agentId: 'agent_worker', title: 'Worker' });
app.addAgent({ agentId: 'agent_worker_fable', title: 'Worker Fable' });
app.addAgent({ agentId: 'agent_fable_claude', title: 'Fable · claude' });
app.pushAgentsChanged();
await sleep(300); // the daemon's roster refreshes off the broadcast

slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: '@Manager Kimi Messages hello', ts: '1800.000020' });
await waitFor(() => app.sends.some((s) => s.body === 'hello'), 'multi-word mention reaches the capability');
assert.deepEqual(app.sends.at(-1), { to: 'Manager Kimi Messages', body: 'hello' });
ok('mention: multi-word title parses to the full name + body');

slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: '@Worker Fable ping', ts: '1800.000021' });
await waitFor(() => app.sends.some((s) => s.body === 'ping'), 'prefixed-title mention reaches the capability');
assert.deepEqual(app.sends.at(-1), { to: 'Worker Fable', body: 'ping' });
ok('mention: longest roster title wins when one title prefixes another');

slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: '@Worker pong', ts: '1800.000022' });
await waitFor(() => app.sends.some((s) => s.body === 'pong'), 'short-title mention reaches the capability');
assert.deepEqual(app.sends.at(-1), { to: 'Worker', body: 'pong' });
ok('mention: the shorter title still resolves at a word boundary');

slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: '@Fable · claude yo', ts: '1800.000023' });
await waitFor(() => app.sends.some((s) => s.body === 'yo'), '·-title mention reaches the capability');
assert.deepEqual(app.sends.at(-1), { to: 'Fable · claude', body: 'yo' });
ok('mention: a ·-containing title parses');

slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: '@manager kimi messages case test', ts: '1800.000024' });
await waitFor(() => app.sends.some((s) => s.body === 'case test'), 'case-insensitive mention reaches the capability');
assert.deepEqual(app.sends.at(-1), { to: 'Manager Kimi Messages', body: 'case test' });
ok('mention: matching is case-insensitive, the canonical title is sent');

slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: '@nobody here', ts: '1800.000025' });
await waitFor(() => postsWith('could not reach *nobody*').length === 1, 'no-match mention hits the honest 404 path');
ok('mention: no roster match falls back to single-word (404 + roster hint)');

const sendsBeforeEmpty = app.sends.length;
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: '@Manager Kimi Messages', ts: '1800.000026' });
await waitFor(
  () => postsWith('start with @agentName').some((p) => p.thread_ts === undefined),
  'empty-body mention gets the guidance post',
);
await sleep(300);
assert.equal(app.sends.length, sendsBeforeEmpty, 'an empty body is never sent');
ok('mention: title with no body → guidance, not an empty send');

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

// ============================ N7 — Slack grows up ==============================
// D-N7-2: the configured channel↔room map resolved at boot (config above).
// D-N7-3: (a) already pinned the outbound room shape + the roster-stamped
// header. Here: the promoted per-message bridge line, <@U> mention decode.

// D-N7-3: Slack <@U…> mentions decode to a display name inbound (users.info,
// bounded cache — cosmetic, never blocks the send).
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: '@fable-v2 tell <@U_MATE> hi', thread_ts: root.ts, ts: '1800.000012' });
await waitFor(() => app.sends.some((s) => s.body?.includes('tell @Mate hi')), '<@U_MATE> decodes inbound');
ok('D-N7-3: <@U…> mentions decode via users.info (bounded cache)');

// D-N7-4: mapped-channel inbound → room send as the human (#label target).
const sendsBeforeN7 = app.sends.length;
slack.sendSlackEvent({ type: 'message', channel: 'C_TEAM', channel_type: 'channel', user: CHRIS, text: 'fleet hello', ts: '1900.000001' });
await waitFor(() => app.sends.length === sendsBeforeN7 + 1, 'mapped-channel message reaches the capability');
assert.deepEqual(app.sends.at(-1), { to: '#team', body: 'fleet hello' });
ok('D-N7-4: mapped channel inbound → /user/send {to: #team} as the human');

// D-N7-4: a thread reply inside the channel bridges the same (rooms are linear).
slack.sendSlackEvent({ type: 'message', channel: 'C_TEAM', channel_type: 'channel', user: CHRIS, text: 'in a slack thread', thread_ts: '1900.000001', ts: '1900.000002' });
await waitFor(() => app.sends.length === sendsBeforeN7 + 2, 'channel thread reply bridges');
assert.deepEqual(app.sends.at(-1), { to: '#team', body: 'in a slack thread' });
ok('D-N7-4: channel thread replies bridge like top-level (the room is linear)');

// D-N7-4: an UNMAPPED channel is dropped (vlog only — never a send).
slack.sendSlackEvent({ type: 'message', channel: 'C_OTHER', channel_type: 'channel', user: CHRIS, text: 'wrong room', ts: '1900.000003' });
await sleep(400);
assert.equal(app.sends.length, sendsBeforeN7 + 2, 'unmapped channel never reaches the capability');
ok('D-N7-4: unmapped channel dropped');

// D-N7-4: an UNMAPPED Slack user on a mapped channel is dropped with ONE loud
// line per user (never silent, never a flood).
slack.sendSlackEvent({ type: 'message', channel: 'C_TEAM', channel_type: 'channel', user: 'U_STRANGER', text: 'who dis', ts: '1900.000004' });
slack.sendSlackEvent({ type: 'message', channel: 'C_TEAM', channel_type: 'channel', user: 'U_STRANGER', text: 'who dis again', ts: '1900.000005' });
await waitFor(() => daemon.output().includes('U_STRANGER'), 'unmapped user noted');
await sleep(300);
assert.equal(app.sends.length, sendsBeforeN7 + 2, 'unmapped user never reaches the capability');
assert.equal(daemon.output().split('U_STRANGER').length - 1, 1, 'exactly ONE loud line per unmapped user');
ok('D-N7-4: unmapped Slack user dropped with one loud line');

// D-N7-4 (honest identity): a non-chris Slack user can NEVER land in the
// room as the human principal — external principals arrive at N8; until
// then they drop with one loud line.
const sendsBeforeMate = app.sends.length;
slack.sendSlackEvent({ type: 'message', channel: 'C_TEAM', channel_type: 'channel', user: 'U_MATE', text: 'mate says hi', ts: '1900.000006' });
await waitFor(() => daemon.output().includes('external principals arrive at N8'), 'the N8 drop line fires');
await sleep(300);
assert.equal(app.sends.length, sendsBeforeMate, 'a non-chris user never bridges — and never lands AS CHRIS');
ok('D-N7-4: honest identity — non-chris users drop loud until N8');

// D-N7-5: the loop hunt, channel edition — the daemon's own tagged channel
// post echoed back, a bot_id echo, and a redelivered channel event must never
// re-enter. And the human's own room message echoed from the app feed must
// never mirror back to Slack.
const sendsBeforeLoopN7 = app.sends.length;
const postsBeforeLoopN7 = slack.posts.length;
slack.sendSlackEvent({ type: 'message', channel: 'C_TEAM', channel_type: 'channel', user: BOT, text: 'echo via bot user', ts: '1900.000007' });
slack.sendSlackEvent({ type: 'message', channel: 'C_TEAM', channel_type: 'channel', user: 'U_OTHER', text: 'echo via metadata', ts: '1900.000008', metadata: { event_type: 'nvk_slack_bridge' } });
slack.sendSlackEvent({ type: 'message', channel: 'C_TEAM', channel_type: 'channel', user: CHRIS, text: 'channel exactly once', ts: '1900.000009' });
slack.sendSlackEvent({ type: 'message', channel: 'C_TEAM', channel_type: 'channel', user: CHRIS, text: 'channel exactly once', ts: '1900.000009' });
app.pushMessage(30, { threadId: 'thread_room_team', senderId: 'person_user-chris', body: { text: 'fleet hello' } });
await sleep(600);
assert.equal(app.sends.filter((s) => s.body === 'channel exactly once').length, 1, 'redelivered channel event is deduped');
assert.equal(app.sends.length, sendsBeforeLoopN7 + 1, 'bot/metadata echoes never re-enter from the channel');
assert.equal(slack.posts.length, postsBeforeLoopN7, "the human's own room message never mirrors back to Slack");
ok('D-N7-5: channel loop hunt — tag/bot/redelivery/human-echo all absorbed');

// D-N7-6: message_changed / message_deleted become follow-up NOTES in the app
// lane — never a mutation of history.
slack.sendSlackEvent({
  type: 'message', subtype: 'message_changed', channel: 'C_TEAM', channel_type: 'channel', user: CHRIS,
  message: { user: CHRIS, text: 'fleet hello (edited)', ts: '1900.000001' }, ts: '1901.000001',
});
await waitFor(() => app.sends.some((s) => s.body === '[edited on Slack] fleet hello (edited)'), 'edit note reaches the room');
ok('D-N7-6: message_changed → "[edited on Slack] <new text>" follow-up note');
slack.sendSlackEvent({
  type: 'message', subtype: 'message_deleted', channel: 'C_TEAM', channel_type: 'channel', user: CHRIS,
  previous_message: { user: CHRIS, text: 'fleet hello (edited)', ts: '1900.000001' }, ts: '1901.000002',
});
await waitFor(() => app.sends.some((s) => s.body === '[deleted on Slack]'), 'delete note reaches the room');
ok('D-N7-6: message_deleted → "[deleted on Slack]" follow-up note');
assert.ok(!app.sends.some((s) => s.body === 'fleet hello (edited)'), 'the edited body never REPLACES the original — history is immutable');

// D-N7-6: an edit in the DM lane notes the agent, too.
slack.sendSlackEvent({
  type: 'message', subtype: 'message_changed', channel_type: 'im', user: CHRIS,
  message: { user: CHRIS, text: 'reply from slack (edited)', thread_ts: root.ts, ts: '1800.000002' }, ts: '1901.000003',
});
await waitFor(() => app.sends.some((s) => s.body === '[edited on Slack] reply from slack (edited)' && s.to === 'fable-v2'), 'DM edit notes the agent');
ok('D-N7-6: edits in the DM lane note the agent (never a mutation)');

// D-N7-6: app→Slack chunking over the 32 KiB contract cap, (i/n) markers.
const bigBody = `chunk-${'x'.repeat(70_000)}`;
const postsBeforeChunk = postsWith('chunk-').length;
app.pushMessage(31, { threadId: 'thread_room_team', body: { text: bigBody } });
await waitFor(() => postsWith('(3/3)').length === 1, 'oversized room message chunked');
assert.ok(postsWith('(1/3)').length === 1 && postsWith('(2/3)').length === 1, 'chunks carry (1/3)…(3/3) markers');
assert.ok(postsWith('chunk-').every((p) => p.channel === 'C_TEAM'), 'chunks land on the mapped channel');
ok('D-N7-6: >32 KiB app→Slack messages chunk with (i/n) markers');

// D-N7-3: the follow-up bridge line is a real log line (was vlog) — asserted
// on a message bridged by the CURRENT daemon (the restart wiped the buffer).
assert.ok(daemon.output().includes('bridged msg_31 → #team C_TEAM'), 'D-N7-3: one log line per bridged message (any lane)');
ok('D-N7-3: the per-message bridge line is promoted to log');

// D-N7-6: an oversized Slack→app body gets a posted note, never a failed send.
const sendsBeforeBig = app.sends.length;
slack.sendSlackEvent({ type: 'message', channel: 'C_TEAM', channel_type: 'channel', user: CHRIS, text: `big-${'y'.repeat(40_000)}`, ts: '1900.000010' });
await waitFor(() => postsWith('too big to bridge').length === 1, 'too-big note posted back to the channel');
assert.equal(app.sends.length, sendsBeforeBig, 'an oversized inbound body never produces a failed send');
ok('D-N7-6: oversized inbound → "too big to bridge" note, never a failed send');

// D-N7-6: Slack 429s honor Retry-After (bounded retries, final drop loud).
slack.rateLimitNextPosts(1, 1);
const rateLimitedAt = Date.now();
app.pushMessage(32, { threadId: 'thread_room_team', body: { text: 'worth the wait' } });
await waitFor(() => postsWith('worth the wait').length === 1, 'the post lands after the 429');
assert.ok(Date.now() - rateLimitedAt >= 900, 'Retry-After was honored (the retry waited, not hammered)');
assert.equal(slack.attempts429.length, 1, 'exactly one attempt was rate-limited before the landing');
ok('D-N7-6: 429 → Retry-After-honoring bounded retry, post lands');

// F3 — a chunk that PARTIALLY fails resumes per-part: the at-least-once
// replay must post the missing parts only, never repost the landed one, and
// the cursor holds until completion.
{
  slack.failNextPosts(3, 1); // part 0 lands; part 1's post + retries all fail
  const partialBody = `partial-${'z'.repeat(70_000)}`;
  app.pushMessage(40, { threadId: 'thread_room_team', body: { text: partialBody } });
  await sleep(2500); // part 0 lands; part 1's retries exhaust
  // Baselines: the seq-31 chunk already posted one of each (i/3) marker, and
  // only part 0 of THIS message carries the 'partial-' prefix.
  assert.equal(postsWith('(1/3)').filter((p) => p.text.includes('partial-')).length, 1, 'part 1 landed');
  assert.equal(postsWith('(2/3)').length, 1, 'part 2 never landed — the chunk is incomplete (only seq-31’s)');
  assert.ok(readState().cursor < 40, 'the cursor holds on a partial chunk');
  app.pushMessage(40, { threadId: 'thread_room_team', body: { text: partialBody } }); // the replay
  await waitFor(() => postsWith('(3/3)').length === 2, 'the replay completes the chunk');
  assert.equal(postsWith('(1/3)').filter((p) => p.text.includes('partial-')).length, 1, 'part 1 is NOT reposted on resume');
  assert.equal(postsWith('(2/3)').length, 2, 'part 2 posts from the resume point');
  assert.equal(readState().cursor, 40, 'the cursor advances only after completion');
  ok('F3: partial chunk failure resumes per-part — no repost, no truncation');
}


// D-N7-7: the state file carries the health block (never breaking the old keys).
const healthState = readState();
assert.ok(healthState.health, 'state file gains a health key');
for (const key of ['updatedAt', 'appRetryCount', 'slackRetryCount', 'lastError', 'lastBridgedAt']) {
  assert.ok(key in healthState.health, `health.${key} present`);
}
assert.ok(Number.isFinite(Date.parse(healthState.health.lastBridgedAt)), 'lastBridgedAt is an ISO stamp');
assert.ok(Number.isFinite(healthState.cursor) && healthState.roots && healthState.agents, 'cursor/roots/agents readers unaffected');
ok('D-N7-7: health keys written alongside cursor/roots/agents');

// F1 — an OUTBOUND-ONLY bridge still serves fresh health: every saveState
// refreshes updatedAt (liveness = the daemon persisting state), and a room
// outbound sets lastBridgedAt too. Re-seed the state file WITHOUT a health
// block (roots/agents preserved so no replay floods), restart, bridge one
// room message app→Slack, send NOTHING inbound.
await daemon.stop();
const subsBeforeF1 = app.subs.length;
const preserved = readState();
fs.writeFileSync(stateFile, JSON.stringify({ cursor: preserved.cursor, roots: preserved.roots, agents: preserved.agents }));
daemon = startDaemon(env);
await waitFor(() => app.subs.length === subsBeforeF1 + 1, 'daemon reboots on the re-seeded state');
app.pushMessage(50, { threadId: 'thread_room_team', body: { text: 'outbound only health' } });
await waitFor(() => postsWith('outbound only health').length === 1, 'the outbound room message bridges');
await waitFor(() => {
  const fileHealth = readState().health ?? {};
  return Number.isFinite(Date.parse(fileHealth.updatedAt ?? '')) && Number.isFinite(Date.parse(fileHealth.lastBridgedAt ?? ''));
}, 'outbound-only bridging still writes fresh updatedAt + lastBridgedAt');
ok('F1: outbound-only bridge → fresh updatedAt + lastBridgedAt (staleness honest)');

// F2 — channels configured but the app refuses /user/threads at boot: the
// daemon must BOOT ANYWAY (DM lanes unaffected), and resolution must retry
// on the next app-ws (re)connect — a racing app restart is not a kill loop.
await daemon.stop();
const subsBeforeF2 = app.subs.length;
app.setFailThreads(true);
daemon = startDaemon(env);
await waitFor(() => app.subs.length === subsBeforeF2 + 1, 'daemon boots with the app refusing threads');
await waitFor(() => daemon.output().includes('channel resolution failed'), 'the failure is a loud warn, not an exit');
const sendsBeforeF2 = app.sends.length;
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: 'dm survives the app race', thread_ts: root.ts, ts: '1800.000030' });
await waitFor(() => app.sends.length === sendsBeforeF2 + 1, 'the DM lane bridges with channels unresolved');
slack.sendSlackEvent({ type: 'message', channel: 'C_TEAM', channel_type: 'channel', user: CHRIS, text: 'dropped while unresolved', ts: '1900.000030' });
await sleep(400);
assert.equal(app.sends.length, sendsBeforeF2 + 1, 'channel events stay dormant while unresolved');
app.setFailThreads(false);
app.pauseNewestSocket(); // force the app-ws reconnect — resolution retries there
await waitFor(() => daemon.output().includes('channel map: C_TEAM'), 'resolution retried on reconnect');
slack.sendSlackEvent({ type: 'message', channel: 'C_TEAM', channel_type: 'channel', user: CHRIS, text: 'channels recovered', ts: '1900.000031' });
await waitFor(() => app.sends.some((s) => s.body === 'channels recovered'), 'the channel lane comes up WITHOUT a daemon restart');
ok('F2: app-down boot race → loud + dormant, resolution retries on reconnect');

// F4 — composite room keys (authority:externalId), ambiguity, and duplicate
// channels refused loudly.
app.addThread({ id: 'thread_room_crew_a', threadKind: 'team', room: { authority: 'team', externalId: 'shared' }, label: '#crew-a' });
app.addThread({ id: 'thread_room_crew_b', threadKind: 'mission', room: { authority: 'mission', externalId: 'shared' }, label: '#crew-b' });
await daemon.stop();
const subsBeforeF4 = app.subs.length;
fs.writeFileSync(configFile, JSON.stringify({
  chrisUserId: CHRIS,
  channels: [
    { slackChannelId: 'C_FLEET', room: 'fleet:team' },
    { slackChannelId: 'C_FLEET', room: 'fleet:team' }, // duplicate channel id
    { slackChannelId: 'C_AMBI', room: 'shared' },      // bare key, ambiguous (two rooms share the externalId, neither is its label)
  ],
}));
daemon = startDaemon(env);
await waitFor(() => app.subs.length === subsBeforeF4 + 1, 'daemon reboots on the collision config');
await waitFor(
  () => daemon.output().includes('ambiguous') && daemon.output().includes('duplicate'),
  'ambiguity + duplicate channel are refused loudly at boot',
);
const sendsBeforeF4 = app.sends.length;
slack.sendSlackEvent({ type: 'message', channel: 'C_FLEET', channel_type: 'channel', user: CHRIS, text: 'composite hello', ts: '1900.000040' });
await waitFor(() => app.sends.length === sendsBeforeF4 + 1, 'the composite key binds the fleet room');
assert.deepEqual(app.sends.at(-1), { to: '#team', body: 'composite hello' }, "'fleet:team' resolves to the fleet room");
slack.sendSlackEvent({ type: 'message', channel: 'C_AMBI', channel_type: 'channel', user: CHRIS, text: 'ambiguous room post', ts: '1900.000041' });
await sleep(400);
assert.ok(!app.sends.some((s) => s.body === 'ambiguous room post'), 'the ambiguous bare key never binds');
ok('F4: composite room keys; ambiguity + duplicate channels refused loudly');

// D-N7-2: channels ABSENT — the channel code is dormant, DM lanes unaffected
// (production runs exactly this until the click-work lands).
await daemon.stop();
const subsBeforeDormant = app.subs.length;
fs.writeFileSync(configFile, JSON.stringify({ chrisUserId: CHRIS }));
daemon = startDaemon(env);
await waitFor(() => app.subs.length === subsBeforeDormant + 1, 'daemon reboots without channel config');
const sendsBeforeDormant = app.sends.length;
slack.sendSlackEvent({ type: 'message', channel: 'C_TEAM', channel_type: 'channel', user: CHRIS, text: 'dormant lane', ts: '1900.000011' });
await sleep(400);
assert.equal(app.sends.length, sendsBeforeDormant, 'a channel event with no channel map is dropped');
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: 'dormant dm still routed', thread_ts: root.ts, ts: '1800.000013' });
await waitFor(() => app.sends.some((s) => s.body === 'dormant dm still routed' && s.to === 'fable-v2'), 'DM lane unaffected without channels');
ok('D-N7-2: channels ABSENT → channel code dormant, DM lanes unaffected');

await daemon.stop();
app.resumeAll();
slack.close();
app.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(`nvk-slack-bridge.test.mjs: all ${checks} checks passed`);
process.exit(0);
