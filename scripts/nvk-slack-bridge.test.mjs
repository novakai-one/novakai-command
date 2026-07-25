// nvk-slack-bridge tests — fake Slack (Web API HTTP + Socket Mode ws) and a
// fake app backend (user routes + /ws live dialect) prove the two-way lane:
// (a) agent message → correct Slack post shape, (b) Slack reply → correct
// /user/send body, (c) LOOP HUNT (bot_id, bot user id, metadata tag guards),
// (d) restart resumes from the persisted cursor without double-posting,
// (e) unknown-thread reply gets the Slack-side guidance message.
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
const THREAD_DM = 'thread_dm_fable';

const THREADS = [
  { id: THREAD_DM, threadKind: 'direct', direct: { pair: ['person_user-chris', 'person_agent-fable'] } },
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
  throw new Error(`timed out waiting for: ${label}`);
}

// --- fake Slack: Web API endpoints + Socket Mode ws on one server ---------------

function startFakeSlack() {
  const posts = [];
  const acks = [];
  let tsCounter = 0;
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
    socket.send(JSON.stringify({ type: 'hello' }));
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.envelope_id !== undefined) acks.push(frame.envelope_id);
    });
  });

  const sendSlackEvent = (event) => {
    assert.ok(socketMode, 'socket mode client not connected yet');
    socketMode.send(JSON.stringify({
      envelope_id: `env_${acks.length + posts.length + 1}_${Math.random()}`,
      type: 'events_api',
      payload: { event },
    }));
  };

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port, posts, acks, sendSlackEvent,
      close: () => { wss.close(); server.close(); },
    }));
  });
}

// --- fake app backend: user routes + /ws live dialect ----------------------------

function startFakeApp() {
  const sends = [];
  const subs = [];
  const sockets = new Set();

  const server = http.createServer((request, response) => {
    const json = (status, data) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    const url = request.url.split('?')[0];
    if (request.method === 'GET' && url === '/api/messaging/v2/user/threads') {
      json(200, { threads: THREADS });
      return;
    }
    if (request.method === 'GET' && url === '/api/messaging/v2/user/messages') {
      json(200, { messages: [] });
      return;
    }
    if (request.method === 'POST' && url === '/api/messaging/v2/user/send') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(body);
        sends.push(parsed);
        if (parsed.to === FABLE.title) {
          json(201, { messageId: `msg_app_${sends.length}`, threadId: THREAD_DM });
        } else {
          json(404, { error: `recipient "${parsed.to}" is not a live agent`, roster: [FABLE.title] });
        }
      });
      return;
    }
    response.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.send(JSON.stringify({ type: 'agents-changed', agents: [FABLE] }));
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'messaging-v2-sub') {
        subs.push(frame.since);
        socket.send(JSON.stringify({ event: 'messaging-v2', payload: { kind: 'started' } }));
      }
    });
  });

  const pushMessage = (sequence, overrides = {}) => {
    const message = {
      id: `msg_${sequence}`, threadId: THREAD_DM, senderId: 'person_agent-fable',
      sequence, priority: 'normal', createdAt: new Date().toISOString(),
      body: { text: `body of msg_${sequence}` }, ...overrides,
    };
    for (const socket of sockets) {
      socket.send(JSON.stringify({
        event: 'messaging-v2',
        payload: { kind: 'event', sequence, event: { message } },
      }));
    }
    return message;
  };

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port, sends, subs, pushMessage,
      close: () => { wss.close(); server.close(); },
    }));
  });
}

// --- daemon lifecycle -------------------------------------------------------------

function startDaemon(env) {
  const child = spawn('node', [DAEMON], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
};

let checks = 0;
const ok = (label) => { checks += 1; console.log(`ok ${checks} — ${label}`); };

let daemon = startDaemon(env);
await waitFor(() => app.subs.length === 1, 'daemon subscribes to the app live feed');
assert.equal(app.subs[0], undefined, 'first subscribe carries no cursor');
ok('boot: subscribed without a cursor');

// (a) agent message → Slack post shape; follow-up in the same capability
// thread lands as a Slack thread reply under the same root.
app.pushMessage(1);
await waitFor(() => slack.posts.length === 1, 'first agent message posted to Slack');
const root = slack.posts[0];
assert.equal(root.channel, DM_CHANNEL);
assert.match(root.text, /^\*fable\* · \d\d:\d\d\nbody of msg_1$/);
assert.equal(root.thread_ts, undefined, 'first message of a DM thread is a root post');
assert.equal(root.metadata?.event_type, 'nvk_slack_bridge', 'outbound posts carry the echo-guard tag');
ok('(a) agent message → Slack root post with *agent* · HH:MM header + metadata tag');

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
await waitFor(() => slack.posts.some((p) => p.text?.includes('could not reach *ghost*')), 'failed send posts the Slack-side error');
ok('(b) unknown agent → honest Slack error with the route\'s roster hint');

// (c) LOOP HUNT — the daemon's own posts echoed back must never re-enter
// the capability. Guard 1: bot_id. Guard 2: our bot's user id (auth.test).
// Guard 3: the metadata tag on every outbound post.
const sendsBeforeLoop = app.sends.length;
slack.sendSlackEvent({ type: 'message', channel_type: 'im', bot_id: 'B_BOT', user: BOT, text: '@fable loop via bot_id', thread_ts: root.ts, ts: '1800.000004' });
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: BOT, text: '@fable loop via bot user', thread_ts: root.ts, ts: '1800.000005' });
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: '@fable loop via metadata', thread_ts: root.ts, ts: '1800.000006', metadata: { event_type: 'nvk_slack_bridge' } });
await sleep(500);
assert.equal(app.sends.length, sendsBeforeLoop, 'no echo reached the capability');
ok('(c) loop hunt: bot_id, bot user id, and metadata-tag echoes all dropped');

// (e) a reply in a thread the bridge never created → Slack-side guidance.
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: 'hello?', thread_ts: '9999.999999', ts: '1800.000007' });
await waitFor(() => slack.posts.some((p) => p.thread_ts === '9999.999999'), 'guidance posted into the unknown thread');
const guidance = slack.posts.find((p) => p.thread_ts === '9999.999999');
assert.match(guidance.text, /unknown thread — start with @agentName/);
assert.equal(app.sends.length, sendsBeforeLoop, 'unknown thread never reaches the capability');
ok('(e) unknown-thread reply → "unknown thread — start with @agentName"');

// (d) restart: state persisted, resume from the cursor, no double-posting.
await daemon.stop();
const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
assert.equal(persisted.cursor, 4, 'cursor persisted at the last seen sequence');
assert.equal(persisted.roots[THREAD_DM], root.ts, 'capability thread → Slack root map persisted');
assert.equal(persisted.agents[root.ts], 'fable', 'Slack root → agent map persisted');
const postsBeforeRestart = slack.posts.length;

daemon = startDaemon(env);
await waitFor(() => app.subs.length === 2, 'restarted daemon resubscribes');
assert.equal(app.subs[1], 's_4', 'resume carries the persisted cursor');
app.pushMessage(4, { threadId: 'thread_room_team', body: { text: 'replayed room noise' } }); // at/below cursor
app.pushMessage(2); // replay of an already-bridged message
await sleep(400);
assert.equal(slack.posts.length, postsBeforeRestart, 'replayed frames at/below the cursor are not re-posted');
ok('(d) restart resumes from s_4 and never double-posts');

// …and the inbound maps survive the restart too.
slack.sendSlackEvent({ type: 'message', channel_type: 'im', user: CHRIS, text: 'still routed', thread_ts: root.ts, ts: '1800.000008' });
await waitFor(() => app.sends.length === sendsBeforeLoop + 1, 'thread reply after restart reaches the capability');
assert.deepEqual(app.sends.at(-1), { to: 'fable', body: 'still routed' });
ok('(d) thread → agent routing survives the restart');

await daemon.stop();
slack.close();
app.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(`nvk-slack-bridge.test.mjs: all ${checks} checks passed`);
