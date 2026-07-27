// shell/demo/bridge.ts — NODE side of the demo. Composes the REAL
// packages/messaging embedded capability (jsonl store under .novakai/) and the
// REAL foundation store for layout/settings, then serves ShellServices over a
// small WS JSON-RPC. Run via tsx (messaging ships TS source).
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
// tsx resolves the .js specifiers to messaging's TS source (NodeNext style).
import * as messaging from '../../messaging/public/index.js';
import type { PersonId } from '../../messaging/public/index.js';
import { composeShellPersistence } from '../contract/persistence.node.js';
import { getLayoutVersioned, setLayout as writeLayout } from '../contract/layout.js';
import * as settingsContract from '../contract/settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellRoot = path.resolve(here, '..');
const repoRoot = path.resolve(shellRoot, '..', '..');
const NOVAKAI_ROOT = path.join(repoRoot, '.novakai');

const ME = 'person_chris';
const TOKEN = 'demo-token-chris';

// ── real messaging (embedded mode) ─────────────────────────────────────────
const clock = messaging.createSystemClock();
const store = await messaging.openJsonlStore(clock, { path: path.join(NOVAKAI_ROOT, 'messaging.jsonl') });
const embedded = messaging.createEmbeddedMessaging({
  clock,
  store,
  authority: {
    principals: [
      { token: TOKEN, personId: ME as PersonId, roles: ['Human'] },
      { token: 'demo-token-kimi', personId: 'person_kimi' as PersonId, roles: ['Chief'] },
      { token: 'demo-token-fable', personId: 'person_fable' as PersonId, roles: ['Worker'] },
    ],
    roleGrants: messaging.DEFAULT_ROLE_GRANTS,
  },
});
await embedded.start();
const auth = await embedded.authenticate({ token: TOKEN });
if (auth.kind !== 'authenticated') throw new Error(`demo auth failed: ${auth.kind}`);
const session = auth.session;

// Let the two demo agents accept Chris's messages: each principal owns its
// own ContactPolicy (DEC-14), so each agent session opens the door itself.
for (const [token, allow] of [['demo-token-kimi', ME], ['demo-token-fable', ME]] as const) {
  const a = await embedded.authenticate({ token });
  if (a.kind === 'authenticated') {
    await a.session.setContactPolicy({ allowlist: [allow], defaultRule: 'deny' });
  }
}

const persistence = composeShellPersistence({ root: NOVAKAI_ROOT, principal: ME });

// ── shell-side conversation metadata (ephemeral view state — see NOTES.md) ──
interface Convo {
  id: string; threadId?: string; address: string; title: string;
  kind: 'agent' | 'room' | 'direct'; pinned: boolean; archived: boolean;
  lastActivityAt: string; agentId?: string;
}
const convos = new Map<string, Convo>();
function seedConvo(id: string, address: string, title: string, kind: Convo['kind'], agentId?: string, pinned = false) {
  convos.set(id, { id, address, title, kind, pinned, archived: false, lastActivityAt: new Date().toISOString(), agentId });
}
seedConvo('conv_kimi', 'person:person_kimi', 'Kimi', 'agent', 'agent_kimi', true);
seedConvo('conv_fable', 'person:person_fable', 'Fable', 'agent', 'agent_fable');

const toSummary = (c: Convo) => ({
  id: c.id, threadId: c.threadId ?? c.address, title: c.title, kind: c.kind,
  pinned: c.pinned, archived: c.archived, lastActivityAt: c.lastActivityAt,
  unreadCount: 0, agentId: c.agentId,
});

// Resolve the messaging thread behind a conversation (created on first send).
async function threadFor(c: Convo): Promise<string | null> {
  if (c.threadId) return c.threadId;
  const res = await session.listThreadsForPerson({});
  if (res.kind !== 'ok') return null;
  const t = res.value.threads.find((t: { direct?: { pair: string[] } }) =>
    c.address.startsWith('person:') && t.direct?.pair.includes(c.address.slice('person:'.length)));
  if (t) { c.threadId = t.id; return t.id; }
  return null;
}

// ── presence: agents package is not built yet — demo drives a mock source ───
const presenceSubs = new Set<(e: unknown) => void>();
const emitPresence = (e: unknown) => presenceSubs.forEach((h) => h(e));
setInterval(() => {
  emitPresence({ type: 'activity', agentId: 'agent_kimi', sessionId: 'sess_demo', at: new Date().toISOString(), activity: 'watching the thread' });
  setTimeout(() => emitPresence({ type: 'online', agentId: 'agent_kimi', sessionId: 'sess_demo', at: new Date().toISOString() }), 4000);
}, 12000);
emitPresence({ type: 'online', agentId: 'agent_kimi', sessionId: 'sess_demo', at: new Date().toISOString() });

// ── WS JSON-RPC ─────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: 4173, host: '127.0.0.1' });
const sockets = new Set<import('ws').WebSocket>();
type Ws = import('ws').WebSocket;
const broadcast = (name: string, data: unknown) => {
  for (const s of sockets) s.send(JSON.stringify({ type: 'event', name, data }));
};
presenceSubs.add((e) => broadcast('presence', e));

const methods: Record<string, (p: never) => Promise<unknown>> = {
  async listConversations() {
    return [...convos.values()].filter((c) => !c.archived || true).map(toSummary);
  },
  async createConversation(p: { title: string; kind: Convo['kind'] }) {
    const id = `conv_${randomUUID().slice(0, 8)}`;
    const address = p.kind === 'agent' ? 'person:person_kimi' : `thread:thread_${randomUUID().slice(0, 8)}`;
    seedConvo(id, address, p.title, p.kind, p.kind === 'agent' ? 'agent_kimi' : undefined);
    const c = convos.get(id)!;
    const s = toSummary(c);
    broadcast('conversation', s);
    return s;
  },
  async pinConversation(p: { id: string; pinned: boolean }) {
    const c = convos.get(p.id); if (c) { c.pinned = p.pinned; broadcast('conversation', toSummary(c)); }
  },
  async archiveConversation(p: { id: string; archived: boolean }) {
    const c = convos.get(p.id); if (c) { c.archived = p.archived; broadcast('conversation', toSummary(c)); }
  },
  async getMessages(p: { conversationId: string }) {
    const c = convos.get(p.conversationId);
    if (!c) return [];
    const threadId = await threadFor(c);
    if (!threadId) return [];
    const res = await session.getMessages({ threadId, limit: 200 });
    if (res.kind !== 'ok') return [];
    return res.value.messages.map((m: { id: string; threadId: string; senderId: string; body: { text: string }; createdAt: string }) => ({
      id: m.id,
      conversationId: p.conversationId,
      senderId: m.senderId === ME ? 'me' : m.senderId,
      text: m.body.text,
      createdAt: m.createdAt,
    }));
  },
  async sendMessage(p: { conversationId: string; text: string }) {
    const c = convos.get(p.conversationId);
    if (!c) return { ok: false, error: 'unknown conversation' };
    const address = c.threadId ? `thread:${c.threadId}` : c.address;
    const res = await session.sendMessage({
      address,
      body: { text: p.text },
      priority: 'normal',
      clientMessageId: `cmsg_${randomUUID()}`,
    });
    if (res.kind !== 'ok') return { ok: false, error: `${res.error.name}: ${res.error.message}` };
    if (!c.threadId) c.threadId = res.value.threadId;
    const message = {
      id: res.value.messageId, conversationId: p.conversationId, senderId: 'me',
      text: p.text, createdAt: new Date().toISOString(),
    };
    broadcast('message', message);
    return { ok: true, message };
  },
  async getLayout() {
    return getLayoutVersioned(persistence.layoutDriver);
  },
  async setLayout(p: { patch: Record<string, unknown> }) {
    return writeLayout(persistence.layoutDriver, p.patch as never);
  },
  async getSettings() {
    return settingsContract.getSettings(persistence.settingsDriver);
  },
  async setSetting(p: { key: string; value: unknown; opts?: { derivedFrom?: string; theme?: 'dark' | 'light' } }) {
    return settingsContract.setSetting(persistence.settingsDriver, p.key, p.value, p.opts ?? {});
  },
};

wss.on('connection', (ws: Ws) => {
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
  ws.on('message', async (raw: unknown) => {
    let frame: { id: number; method: string; params: never };
    try { frame = JSON.parse(String(raw)); } catch { return; }
    const m = methods[frame.method];
    if (!m) { ws.send(JSON.stringify({ id: frame.id, error: `unknown method ${frame.method}` })); return; }
    try {
      const result = await m(frame.params);
      ws.send(JSON.stringify({ id: frame.id, result }));
    } catch (e) {
      ws.send(JSON.stringify({ id: frame.id, error: e instanceof Error ? e.message : String(e) }));
    }
  });
});

console.log('[shell demo] bridge listening on ws://127.0.0.1:4173 (real messaging + foundation, root .novakai/)');
