#!/usr/bin/env node
/**
 * messenger-cli — a standalone terminal messenger application: the Messaging
 * capability's SECOND HOST (Plan §15 P1, G13, MSG-022).
 *
 * What makes this an honest second host:
 *
 *  - IDENTITY PROVISIONING: the app holds only a bearer token and a server
 *    URL, exactly like a real external host. Provisioning is the standalone
 *    server's AUTHORITY CONFIG (the v1 provisioning interface, DEC-07: the
 *    token → Person ID → role/grants mapping lives in that config, never in
 *    core, and never in this app). An operator issues the token out of band;
 *    the app learns its own Person ID from the authentication handshake.
 *
 *  - PROTOCOL-ONLY: the app speaks the published DEC-17 JSON-over-WebSocket
 *    protocol (protocolVersion 1.0.0) and NOTHING else. It imports no
 *    Messaging package code — not even the public surface. The only
 *    dependency is `ws`. Every frame shape below is re-derived from the
 *    published protocol, as any external host would derive it.
 *
 *  - ITS OWN UI FROM PUBLISHED PROJECTIONS: the app maintains local
 *    projections (inbox, thread history, presence) built ONLY from query
 *    results and pushed subscription/delivery frames, and renders plain-text
 *    views from them. A message that arrives PUSHED appears in the rendered
 *    inbox tagged [pushed] without any query being issued — polling exists
 *    only as explicit catch-up (sync-*) after a reconnect, per MSG-023.
 *
 *  - NO CORE CHANGES: the app is a separate package outside the Messaging
 *    compile graph (not in the messaging tsconfig include set).
 *
 * Usage:
 *   node app.mjs --url ws://127.0.0.1:8787 --token <bearer-token> [--name <label>]
 *
 * The app is script-driven (not interactive): it authenticates at startup,
 * prints `READY <personId>`, then reads JSON-lines commands from stdin and
 * writes one JSON-lines response per command to stdout. Pushed frames are
 * written as `{ "push": … }` lines the moment they arrive.
 *
 * Commands (stdin, one JSON object per line, "id" correlates the response):
 *   {id, cmd:"open-presence"}
 *   {id, cmd:"subscribe", events:["MessageCommitted", …]}
 *   {id, cmd:"send", address:"person:<id>"|"thread:<id>", text, priority?, clientMessageId}
 *   {id, cmd:"allow", personId}              — union into the local allowlist, then SetContactPolicy
 *   {id, cmd:"dnd", enabled:boolean}
 *   {id, cmd:"list-threads"}                 — ListThreadsForPerson (query; learns room Thread IDs)
 *   {id, cmd:"sync-inbox"}                   — GetInbox, paged to exhaustion (catch-up pull)
 *   {id, cmd:"sync-thread", threadId}        — GetMessages, paged to exhaustion (catch-up pull)
 *   {id, cmd:"sync-presence", personId}      — GetPresence (pull)
 *   {id, cmd:"render-inbox"}                 — text view from the LOCAL projection
 *   {id, cmd:"render-thread", threadId}      — text view from the LOCAL projection
 *   {id, cmd:"render-presence"}              — text view from the LOCAL projection
 *   {id, cmd:"stats"}                        — {queries: {name: n}, pushes: n} — the no-poll evidence
 *   {id, cmd:"quit"}
 *
 * Known example-scope limitations (recorded at the S3 audit; acceptable for
 * a proof-harness host, not production-grade):
 *  - unmatched frames (stale errors, subscription `ended` notices) accumulate
 *    in the frame backlog unbounded;
 *  - a pushed `ended` frame (e.g. subscription buffer overflow) is not
 *    surfaced — the app keeps rendering its last projection;
 *  - server death mid-session degrades to per-command timeouts rather than a
 *    reported disconnection.
 */

import WebSocket from "ws";
import { createInterface } from "node:readline";

// --- argv ---------------------------------------------------------------------

function readArg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const url = readArg(process.argv.slice(2), "--url");
const token = readArg(process.argv.slice(2), "--token");
const label = readArg(process.argv.slice(2), "--name") ?? "messenger-cli";

if (!url || !token) {
  process.stderr.write("usage: app.mjs --url ws://host:port --token <token> [--name <label>]\n");
  process.exit(2);
}

// --- wire client (DEC-17 protocol, derived from the published frames) ---------
//
// client → server: get-capabilities · authenticate · command · query ·
//                  subscribe · unsubscribe
// server → client: capabilities · authenticated · command-result ·
//                  query-result · delivery (ADDRESSED lane) · error ·
//                  started/event/ended (OBSERVATION lane, contract stream)

const socket = new WebSocket(url);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

const backlog = [];
const waiters = [];
let requestCounter = 0;

socket.on("message", (data) => {
  const frame = JSON.parse(data.toString("utf8"));
  // Pushed frames (ADDRESSED-lane deliveries, OBSERVATION-lane events) fold
  // straight into the projections; everything else is request/response.
  if (frame.kind === "delivery") {
    handleDeliveryFrame(frame);
    return;
  }
  if (frame.kind === "event") {
    handleEventFrame(frame);
    return;
  }
  const index = waiters.findIndex((waiter) => waiter.match(frame));
  if (index >= 0) {
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  } else {
    backlog.push(frame);
  }
});

function waitFor(match, timeoutMs = 10_000) {
  const index = backlog.findIndex(match);
  if (index >= 0) {
    const [frame] = backlog.splice(index, 1);
    return Promise.resolve(frame);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error("messenger-cli: timed out waiting for frame"));
    }, timeoutMs);
    waiters.push({ match, resolve, timer });
  });
}

function nextRequestId(prefix) {
  requestCounter += 1;
  return `${prefix}-${requestCounter}`;
}

async function call(frame) {
  socket.send(JSON.stringify(frame));
  return waitFor((candidate) => candidate.requestId === frame.requestId);
}

// --- local projections (built ONLY from query results + pushed frames) --------
//
// Every projected item carries the source that FIRST put it there:
//   "pushed-delivery" — the ADDRESSED lane (a Delivery's transport effect)
//   "pushed-event"    — the OBSERVATION lane (a subscription event)
//   "pulled"          — a query result (explicit catch-up only)
// The [pushed]/[pulled] tags in the rendered views are the P1 evidence that
// the UI reflects Messaging state without polling.

const projection = {
  personId: undefined,
  allowlist: [],
  /** messageId → { id, threadId, senderId, text, priority, source } */
  messages: new Map(),
  /** message IDs addressed to me (delivery pushes + GetInbox pulls) */
  inbox: [],
  /** threadId → { id, kind } */
  threads: new Map(),
  /** threadId → [messageId] in arrival order */
  threadMessages: new Map(),
  /** personId → { ids: Set<presenceId>, source } (IDs, not a counter: observation-lane duplicates stay idempotent) */
  presence: new Map(),
  /** query name → issued count (the no-poll evidence) */
  queries: {},
  pushes: 0,
};

function recordMessage(message, source) {
  const existing = projection.messages.get(message.id);
  if (existing) return existing; // first source wins — duplicates never double-render
  const entry = {
    id: message.id,
    threadId: message.threadId,
    senderId: message.senderId,
    text: message.body?.text ?? "",
    priority: message.priority ?? "normal",
    source,
  };
  projection.messages.set(message.id, entry);
  const threadList = projection.threadMessages.get(message.threadId) ?? [];
  threadList.push(message.id);
  projection.threadMessages.set(message.threadId, threadList);
  return entry;
}

function addToInbox(messageId) {
  if (!projection.inbox.includes(messageId)) projection.inbox.push(messageId);
}

function sourceTag(entry) {
  return entry.source.startsWith("pushed") ? "pushed" : "pulled";
}

// --- pushed frames → projections (the anti-polling law, MSG-023) --------------

function notePush(summary) {
  projection.pushes += 1;
  process.stdout.write(`${JSON.stringify({ push: summary })}\n`);
}

function handleDeliveryFrame(frame) {
  const message = frame.message;
  const entry = recordMessage(message, "pushed-delivery");
  addToInbox(message.id);
  notePush({ lane: "delivery", messageId: entry.id, threadId: entry.threadId, senderId: entry.senderId, text: entry.text });
}

function handleEventFrame(frame) {
  const event = frame.event ?? {};
  if (event.message) {
    // MessageCommitted (committed fact, journaled with sequence).
    const entry = recordMessage(event.message, "pushed-event");
    notePush({ lane: "event", event: "MessageCommitted", messageId: entry.id, threadId: entry.threadId, senderId: entry.senderId, text: entry.text });
  } else if (event.presence) {
    // PresenceChanged (R11 observation — live-only, never replayed, and
    // AT-LEAST-ONCE: duplicates are possible on the observation lane).
    // Keying by Presence ID makes a duplicated `opened` idempotent — a
    // phantom "online" can never survive the matching `closed`.
    const personId = event.presence.personId;
    const presenceId = event.presence.id;
    const current = projection.presence.get(personId) ?? { ids: new Set(), source: "pushed-event" };
    if (event.change === "opened") current.ids.add(presenceId);
    else current.ids.delete(presenceId);
    projection.presence.set(personId, current);
    notePush({ lane: "event", event: "PresenceChanged", personId, change: event.change });
  } else if (event.delivery) {
    notePush({ lane: "event", event: "DeliveryUpdated", state: event.delivery.state });
  } else if (event.policy) {
    notePush({ lane: "event", event: "PolicyChanged", personId: event.personId });
  } else {
    notePush({ lane: "event", event: "unknown" });
  }
}

// --- protocol operations ------------------------------------------------------

async function authenticate() {
  const frame = await call({ kind: "authenticate", requestId: nextRequestId("auth"), credential: { token } });
  if (frame.kind === "error") {
    process.stdout.write(`FATAL ${JSON.stringify(frame.error)}\n`);
    process.exit(1);
  }
  projection.personId = frame.principal.personId;
}

async function command(name, input) {
  const frame = await call({ kind: "command", requestId: nextRequestId("cmd"), name, input });
  if (frame.kind === "error") return { ok: false, error: frame.error };
  return { ok: true, result: frame.result };
}

async function query(name, input) {
  projection.queries[name] = (projection.queries[name] ?? 0) + 1;
  const frame = await call({ kind: "query", requestId: nextRequestId("qry"), name, input });
  if (frame.kind === "error") return { ok: false, error: frame.error };
  return { ok: true, result: frame.result };
}

// --- commands (stdin JSON lines) ----------------------------------------------

const handlers = {
  "open-presence": async () => command("OpenPresence", { transport: "ws", clientLabel: label }),

  subscribe: async (args) => {
    const requestId = nextRequestId("sub");
    socket.send(JSON.stringify({
      kind: "subscribe",
      requestId,
      input: { events: args.events },
    }));
    // R1 stream discipline: a SUCCESSFUL Subscribe is acknowledged by the
    // stream itself (`started` carries the subscriptionId, no requestId);
    // a FAILURE before the stream opens is an ordinary `error` frame
    // correlated by requestId. Match both — the typed error must reach the
    // caller, never rot in the backlog behind a generic timeout (G6 at the
    // host edge; audit F1).
    const frame = await waitFor(
      (candidate) =>
        candidate.kind === "started" ||
        (candidate.kind === "error" && candidate.requestId === requestId),
    );
    if (frame.kind === "error") return { ok: false, error: frame.error };
    return { ok: true, result: { subscriptionId: frame.subscriptionId } };
  },

  send: async (args) => command("SendMessage", {
    address: args.address,
    body: { text: args.text },
    priority: args.priority ?? "normal",
    clientMessageId: args.clientMessageId,
  }),

  allow: async (args) => {
    if (!projection.allowlist.includes(args.personId)) projection.allowlist.push(args.personId);
    return command("SetContactPolicy", { allowlist: projection.allowlist, defaultRule: "deny" });
  },

  dnd: async (args) => command("SetDndPolicy", { enabled: Boolean(args.enabled) }),

  "list-threads": async () => {
    const outcome = await query("ListThreadsForPerson", {});
    if (!outcome.ok) return outcome;
    const threads = outcome.result.threads ?? [];
    for (const thread of threads) projection.threads.set(thread.id, { id: thread.id, kind: thread.threadKind });
    return { ok: true, result: threads.map((thread) => ({ id: thread.id, kind: thread.threadKind })) };
  },

  "sync-inbox": async () => {
    // Explicit catch-up pull (the reconnect fallback, never the liveness mechanism).
    let cursor;
    for (;;) {
      const input = cursor === undefined ? {} : { cursor };
      const outcome = await query("GetInbox", input);
      if (!outcome.ok) return outcome;
      for (const message of outcome.result.messages ?? []) {
        recordMessage(message, "pulled");
        addToInbox(message.id);
      }
      cursor = outcome.result.nextCursor;
      if (cursor === undefined) return { ok: true, result: { inboxSize: projection.inbox.length } };
    }
  },

  "sync-thread": async (args) => {
    let cursor;
    for (;;) {
      const input = cursor === undefined ? { threadId: args.threadId } : { threadId: args.threadId, cursor };
      const outcome = await query("GetMessages", input);
      if (!outcome.ok) return outcome;
      for (const message of outcome.result.messages ?? []) recordMessage(message, "pulled");
      cursor = outcome.result.nextCursor;
      if (cursor === undefined) {
        return { ok: true, result: { threadSize: (projection.threadMessages.get(args.threadId) ?? []).length } };
      }
    }
  },

  "sync-presence": async (args) => {
    const outcome = await query("GetPresence", { personId: args.personId });
    if (!outcome.ok) return outcome;
    projection.presence.set(args.personId, {
      ids: new Set((outcome.result.presences ?? []).map((presence) => presence.id)),
      source: "pulled",
    });
    return { ok: true, result: { personId: args.personId } };
  },

  "render-inbox": async () => {
    const lines = projection.inbox.map((messageId) => {
      const entry = projection.messages.get(messageId);
      return `  [${sourceTag(entry)}] ${entry.senderId} @ ${entry.threadId}${entry.priority === "urgent" ? " (URGENT)" : ""}: ${entry.text}`;
    });
    return { ok: true, result: [`INBOX for ${projection.personId} — ${lines.length} message(s)`, ...lines].join("\n") };
  },

  "render-thread": async (args) => {
    const thread = projection.threads.get(args.threadId);
    const labelText = thread ? `${thread.id} (${thread.kind})` : `${args.threadId}`;
    const lines = (projection.threadMessages.get(args.threadId) ?? []).map((messageId) => {
      const entry = projection.messages.get(messageId);
      return `  [${sourceTag(entry)}] ${entry.senderId}${entry.priority === "urgent" ? " (URGENT)" : ""}: ${entry.text}`;
    });
    return { ok: true, result: [`THREAD ${labelText} — ${lines.length} message(s)`, ...lines].join("\n") };
  },

  "render-presence": async () => {
    const lines = [...projection.presence.entries()].map(([personId, info]) => {
      const count = info.ids.size;
      const state = count > 0 ? `online (${count} presence${count === 1 ? "" : "s"})` : "offline";
      return `  ${personId}: ${state} [${sourceTag(info)}]`;
    });
    return { ok: true, result: ["PRESENCE", ...lines].join("\n") };
  },

  stats: async () => ({ ok: true, result: { queries: projection.queries, pushes: projection.pushes } }),
};

// --- main loop ------------------------------------------------------------------

await authenticate();
process.stdout.write(`READY ${projection.personId}\n`);

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const trimmed = line.trim();
  if (trimmed === "") continue;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    process.stdout.write(`${JSON.stringify({ id: null, ok: false, error: { name: "BadCommand", message: "not JSON" } })}\n`);
    continue;
  }
  if (request.cmd === "quit") {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: "bye" })}\n`);
    socket.close();
    process.exit(0);
  }
  const handler = handlers[request.cmd];
  if (!handler) {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: false, error: { name: "BadCommand", message: `unknown cmd ${request.cmd}` } })}\n`);
    continue;
  }
  try {
    const outcome = await handler(request);
    process.stdout.write(`${JSON.stringify({ id: request.id, ...outcome })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: false, error: { name: "AppError", message: String(error?.message ?? error) } })}\n`);
  }
}
