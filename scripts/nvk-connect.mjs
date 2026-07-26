#!/usr/bin/env node
// nvk connect — the connect-your-agent client (D-N6-3): a DEC-17
// frames-protocol client for agents on FOREIGN machines. Protocol-only: the
// ONLY runtime dependency is `ws` — this script imports NOTHING from the
// capability package (the wire protocol IS the contract; see
// packages/messaging/tests/standalone/external-chief.ts for the reference).
//
//   node scripts/nvk-connect.mjs --url ws://<host>:3032 --token nvkt_… [--label <name>]
//
// Flow: get-capabilities → authenticate (with protocolVersion) →
// OpenPresence{transport:'ws'} → Subscribe(MessageCommitted, DeliveryUpdated).
// stdin is JSON lines {"to","body","priority"?} → SendMessage; pushed events
// and send results print as JSON lines on stdout.
//
// Addresses: 'person:person_…' and 'thread:thread_…' verbatim; a bare
// agent_<id> derives person_agent-<id> (the one-directional rule —
// display-name resolution is deliberately out of scope for the protocol
// client; use nvk-msg for names).
// Session death (auth-lost close, the 1h-TTL lesson): reconnect with backoff,
// re-authenticate, re-subscribe from the last seen sequence — never a silent
// death. SIGINT exits cleanly.

import readline from 'node:readline';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const url = opt('--url');
const token = opt('--token');
const label = opt('--label') ?? 'nvk-connect';
if (!url || !token) {
  console.error('usage: nvk-connect.mjs --url ws://<host>:3032 --token nvkt_… [--label <name>]');
  process.exit(1);
}

const WS_PROTOCOL_VERSION = '1.0.0';
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const log = (message) => process.stderr.write(`[nvk-connect] ${message}\n`);

let socket = null;
let attempts = 0;
let lastSequence = 0;
let requestCounter = 0;
let closing = false;
const pending = new Map(); // requestId → resolve(frame)

function addressFor(to) {
  if (to.startsWith('person:') || to.startsWith('thread:')) return to;
  // agent_<id> → person:person_agent-<id> (the one-directional rule — the
  // address scheme carries the FULL personId, prefix included).
  if (to.startsWith('agent_')) return `person:person_${to.replaceAll('_', '-')}`;
  throw new Error(`unresolvable address "${to}" — use person:…, thread:…, or agent_<id>`);
}

function sendFrame(frame) {
  socket.send(JSON.stringify(frame));
}

function call(frame) {
  requestCounter += 1;
  const requestId = `connect-${requestCounter}`;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    sendFrame({ ...frame, requestId });
  });
}

async function handshake() {
  sendFrame({ kind: 'get-capabilities' });
  const authenticated = await call({ kind: 'authenticate', credential: { token }, protocolVersion: WS_PROTOCOL_VERSION });
  if (authenticated.kind === 'error') throw new Error(`authenticate failed: ${authenticated.error?.message}`);
  const opened = await call({ kind: 'command', name: 'OpenPresence', input: { transport: 'ws', clientLabel: label } });
  if (opened.kind === 'error') throw new Error(`OpenPresence failed: ${opened.error?.message}`);
  const input = { events: ['MessageCommitted', 'DeliveryUpdated'] };
  if (lastSequence > 0) input.since = `s_${lastSequence}`;
  sendFrame({ kind: 'subscribe', requestId: 'connect-sub', input });
  emit({ type: 'ready', personId: authenticated.principal?.personId, resumedFrom: lastSequence || null });
}

function onFrame(frame) {
  if (frame.requestId !== undefined && pending.has(frame.requestId)) {
    pending.get(frame.requestId).resolve(frame);
    pending.delete(frame.requestId);
    return;
  }
  if (frame.kind === 'event') {
    const sequence = frame.sequence ?? frame.event?.sequence;
    if (typeof sequence === 'number' && sequence > lastSequence) lastSequence = sequence;
    emit({ type: 'event', sequence: sequence ?? null, event: frame.event });
    return;
  }
  if (frame.kind === 'delivery') {
    emit({ type: 'delivery', message: frame.message });
    return;
  }
  if (frame.kind === 'error') {
    emit({ type: 'error', error: frame.error });
    if (frame.error?.name === 'NotAuthenticated') socket.close(); // reconnect + re-auth
    return;
  }
  if (frame.kind === 'started' || frame.kind === 'ended') {
    emit({ type: frame.kind, subscriptionId: frame.subscriptionId, reason: frame.reason });
  }
}

function connect() {
  if (closing) return;
  socket = new WebSocket(url);
  socket.on('open', () => {
    attempts = 0;
    log(`connected to ${url} — handshaking as ${label}`);
    handshake().catch((error) => {
      log(`handshake failed: ${error.message}`);
      socket.close();
    });
  });
  socket.on('message', (data) => {
    try {
      onFrame(JSON.parse(data.toString('utf8')));
    } catch {
      // malformed frames never reach the consumer (protocol discipline)
    }
  });
  socket.on('close', () => {
    for (const { reject } of pending.values()) reject(new Error('connection closed'));
    pending.clear();
    if (closing) return;
    attempts += 1;
    const waitMs = Math.min(500 * 2 ** (attempts - 1), 8000);
    log(`connection closed — reconnecting in ${waitMs}ms (resume from s_${lastSequence})`);
    setTimeout(connect, waitMs);
  });
  socket.on('error', () => socket.close());
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line.trim() === '') return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    emit({ type: 'error', error: { message: 'stdin lines must be JSON: {"to","body","priority"?}' } });
    return;
  }
  if (typeof parsed.to !== 'string' || typeof parsed.body !== 'string') {
    emit({ type: 'error', error: { message: 'a send needs {"to": string, "body": string}' } });
    return;
  }
  let address;
  try {
    address = addressFor(parsed.to);
  } catch (error) {
    emit({ type: 'error', error: { message: error.message } });
    return;
  }
  call({
    kind: 'command',
    name: 'SendMessage',
    input: {
      address,
      body: { text: parsed.body },
      priority: parsed.priority === 'urgent' ? 'urgent' : 'normal',
      clientMessageId: `connect_${crypto.randomUUID()}`,
    },
  }).then((result) => {
    if (result.kind === 'error') emit({ type: 'error', error: result.error, to: parsed.to });
    else emit({ type: 'sent', to: parsed.to, result: result.result });
  }).catch((error) => emit({ type: 'error', error: { message: error.message }, to: parsed.to }));
});

process.on('SIGINT', () => {
  closing = true;
  socket?.close();
  process.exit(0);
});

connect();
