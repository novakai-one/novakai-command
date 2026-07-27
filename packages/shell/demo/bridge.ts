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
// REAL packages/agents (TS source via tsx) — the demo PresenceSource (SHL-006).
// No terminal runtime in the demo context, so every provider resolves to the
// mock adapter (AGT-001 seam is identical); the wiring agents → bridge → UI is real.
import {
  composeAgents, createAgentsContract, mockOf, type LiveLaneSender,
} from '../../agents/contract/index.js';
// Demo-scoped REAL provider path: drives the actual `kimi` CLI in print mode
// (see kimiCliRuntime.ts for why this replaces the TUI terminal host here).
import { existsSync } from 'node:fs';
import { createKimiCliRuntime, defaultKimiCliPath } from './kimiCliRuntime.js';

// foundation brands mints `op_${uuid}`; shell never imports foundation from
// the demo, so mint the same shape locally for defineAgent calls.
const mintOpId = () => `op_${randomUUID()}` as never;
import { composeShellPersistence } from '../contract/persistence.node.js';
import { getLayoutVersioned, setLayout as writeLayout } from '../contract/layout.js';
import * as settingsContract from '../contract/settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellRoot = path.resolve(here, '..');
const repoRoot = path.resolve(shellRoot, '..', '..');
const NOVAKAI_ROOT = path.join(repoRoot, '.novakai');

const ME = 'person_chris';
const TOKEN = 'demo-token-chris';
const MOCK_PERSON = 'person_mock';

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
      // mock spawn agents (spawnMockAgent) reply through this person's session
      { token: 'demo-token-mock', personId: MOCK_PERSON as PersonId, roles: ['Worker'] },
      // Pool of provisioned agent persons for user-created conversations (demo scope).
      ...Array.from({ length: 10 }, (_, i) => ({
        token: `demo-token-pool-${i}`, personId: `person_pool${i}` as PersonId, roles: ['Worker'] as ['Worker'],
      })),
    ],
    roleGrants: messaging.DEFAULT_ROLE_GRANTS,
  },
});
await embedded.start();
const auth = await embedded.authenticate({ token: TOKEN });
if (auth.kind !== 'authenticated') throw new Error(`demo auth failed: ${auth.kind}`);
const session = auth.session;
// Chris accepts mail from the demo agent people (incl. spawned mock agents).
await session.setContactPolicy({ allowlist: ['person_kimi', 'person_fable', MOCK_PERSON], defaultRule: 'deny' });

// Let the two demo agents accept Chris's messages: each principal owns its
// own ContactPolicy (DEC-14), so each agent session opens the door itself.
for (const [token, allow] of [['demo-token-kimi', ME], ['demo-token-fable', ME], ['demo-token-mock', ME]] as const) {
  const a = await embedded.authenticate({ token });
  if (a.kind === 'authenticated') {
    await a.session.setContactPolicy({ allowlist: [allow], defaultRule: 'deny' });
  }
}
// Pool persons open their doors to Chris too (user-created agent chats).
const poolTokens: string[] = [];
const poolSessions = new Map<string, messaging.MessagingSession>();
for (let i = 0; i < 10; i++) {
  poolTokens.push(`demo-token-pool-${i}`);
  const a = await embedded.authenticate({ token: `demo-token-pool-${i}` });
  if (a.kind === 'authenticated') {
    await a.session.setContactPolicy({ allowlist: [ME], defaultRule: 'deny' });
    poolSessions.set(`person_pool${i}`, a.session);
  }
}
let poolNext = 0;

// Mock spawn agents send through their own messaging session (live lane, R3-1).
const mockAuth = await embedded.authenticate({ token: 'demo-token-mock' });
if (mockAuth.kind !== 'authenticated') throw new Error('demo mock-agent auth failed');
const mockSession = mockAuth.session;

const persistence = composeShellPersistence({ root: NOVAKAI_ROOT, principal: ME });

// ── shell-side conversation metadata (ephemeral view state — see NOTES.md) ──
interface Convo {
  id: string; threadId?: string; address: string; title: string;
  kind: 'agent' | 'room' | 'direct'; pinned: boolean; archived: boolean;
  lastActivityAt: string; agentId?: string;
}
const convos = new Map<string, Convo>();
// ── REAL packages/agents as the PresenceSource (SHL-006) ───────────────────
// When the real kimi CLI is installed, inject the demo-scoped kimiCliRuntime
// as the terminal runtime: provider 'kimi' spawns go to the REAL CLI, while
// claude/codex (unused in the demo) resolve through the same seam and mock
// stays mock. Without the CLI, behavior is exactly the pre-existing all-mock
// composition.
const kimiCliPath = defaultKimiCliPath();
const realKimiAvailable = existsSync(kimiCliPath);
const kimiRuntime = realKimiAvailable ? createKimiCliRuntime({ cwd: repoRoot, cliPath: kimiCliPath }) : null;
const agentsCtx = composeAgents({
  root: NOVAKAI_ROOT,
  principal: ME,
  ...(kimiRuntime ? { terminalRuntime: kimiRuntime, cwd: repoRoot } : {}),
});
const agents = createAgentsContract(agentsCtx);
const mockAdapter = mockOf(agentsCtx);
/** convoId → live REAL-kimi session (for forwarding Chris's messages). */
const realSessions = new Map<string, { sessionId: string; personId: string }>();

async function defineDemoAgent(displayName: string, provider: 'mock' | 'kimi' = 'mock'): Promise<string> {
  const res = await agents.defineAgent(
    { displayName, provider, model: provider === 'kimi' ? 'kimi-cli' : 'mock-model', hooks: [], status: 'defined', permissionLevel: 'private' },
    mintOpId(),
  );
  if (!res.ok) throw new Error(`defineAgent failed: ${res.error.message}`);
  return res.value.id;
}

const seedConvo = (id: string, address: string, title: string, kind: Convo['kind'], agentId?: string, pinned = false) => {
  convos.set(id, { id, address, title, kind, pinned, archived: false, lastActivityAt: new Date().toISOString(), agentId });
};
const kimiAgentId = await defineDemoAgent('Kimi');
const fableAgentId = await defineDemoAgent('Fable');
seedConvo('conv_kimi', 'person:person_kimi', 'Kimi', 'agent', kimiAgentId, true);
seedConvo('conv_fable', 'person:person_fable', 'Fable', 'agent', fableAgentId);

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

// ── presence: agents bus → bridge broadcast (the real PresenceSource seam) ──
const presenceSubs = new Set<(e: unknown) => void>();
const emitPresence = (e: unknown) => presenceSubs.forEach((h) => h(e));
agents.subscribeAgentEvents(emitPresence);

// Kimi "breathes": a spawned mock session with scripted activity, so the demo
// rail shows a live dot driven by the REAL agentEvent pipeline.
const kimiSpawn = await agents.spawnAgent(kimiAgentId as never);
if (kimiSpawn.ok && mockAdapter) {
  const sid = kimiSpawn.value.sessionId;
  setInterval(() => {
    mockAdapter.__emit(sid, { type: 'activity', sessionId: sid, at: new Date().toISOString(), activity: 'watching the thread' });
  }, 12000);
}

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
    // Every conversation gets a UNIQUE counterpart — sharing person_kimi made all
    // new agent chats resolve to the same messaging thread (audit fix, Claude's catch).
    let address: string;
    let agentId: string | undefined;
    if (p.kind === 'agent') {
      agentId = await defineDemoAgent(p.title);
      // Assign a provisioned pool person (unique per conversation) so the thread
      // is separate AND the recipient actually exists in messaging.
      if (poolNext >= poolTokens.length) return { ok: false, error: 'demo pool exhausted (10 new agent chats per restart)' };
      address = `person:person_pool${poolNext++}`;
    } else {
      address = `thread:thread_${randomUUID().slice(0, 8)}`;
    }
    seedConvo(id, address, p.title, p.kind, agentId);
    const c = convos.get(id)!;
    const s = toSummary(c);
    broadcast('conversation', s);
    return s;
  },
  // Demo affordance (SHL-006/007 proof): define + spawn a REAL agents-registry
  // agent on the mock provider, script its session lifecycle, and bind the live
  // lane so its output lands in the thread as a real messaging reply.
  async spawnMockAgent(p: { title?: string }) {
    const title = p.title?.trim() || `Mock agent ${convos.size - 1}`;
    const agentId = await defineDemoAgent(title);
    const spawn = await agents.spawnAgent(agentId as never);
    if (!spawn.ok) return { ok: false as const, error: spawn.error.message };
    const sessionId = spawn.value.sessionId;
    const convoId = `conv_${randomUUID().slice(0, 8)}`;
    seedConvo(convoId, `person:${MOCK_PERSON}`, title, 'agent', agentId);
    const c = convos.get(convoId)!;
    const s = toSummary(c);
    broadcast('conversation', s);

    // Live lane (R3-1): mock session output → real messaging reply to Chris,
    // then mirrored to the UI as a message event for this conversation.
    const sender: LiveLaneSender = {
      async sendMessage(input: unknown) {
        const res = await mockSession.sendMessage(input as never);
        if (res.kind === 'ok') {
          const v = res.value as { threadId: string; messageId: string };
          if (!c.threadId) c.threadId = v.threadId;
          broadcast('message', {
            id: v.messageId, conversationId: convoId, senderId: MOCK_PERSON,
            text: (input as { body: { text: string } }).body.text,
            createdAt: new Date().toISOString(),
          });
        }
        return res;
      },
    };
    agents.attachLiveLane({ sessionId, address: `person:${ME}`, sender });

    // Script the session lifecycle through the mock adapter (test seam):
    // spawned/online already published by spawnAgent; now activity → reply → exit.
    const at = () => new Date().toISOString();
    setTimeout(() => mockAdapter?.__emit(sessionId, { type: 'activity', sessionId, at: at(), activity: 'reading the thread' }), 800);
    setTimeout(() => mockAdapter?.__emit(sessionId, { type: 'activity', sessionId, at: at(), activity: 'typing a reply' }), 1800);
    setTimeout(() => mockAdapter?.__emit(sessionId, { type: 'output', sessionId, at: at(), data: `👋 ${title} here — live lane reply via packages/agents.` }), 2800);
    setTimeout(() => agents.closeSession(sessionId as never), 6000);
    return { ok: true as const, conversation: s };
  },
  async getCapabilities() {
    return { realKimi: realKimiAvailable };
  },
  // REAL provider affordance: define + spawn an agents-registry agent on the
  // REAL kimi CLI (demo-scoped kimiCliRuntime), then bind the live lane so
  // the CLI's actual replies land in the thread. Chris's messages are
  // forwarded into the session in sendMessage below.
  async spawnRealKimi(p: { title?: string }) {
    if (!kimiRuntime) return { ok: false as const, error: `kimi CLI not found at ${kimiCliPath}` };
    if (poolNext >= poolTokens.length) return { ok: false as const, error: 'demo pool exhausted (10 agent chats per restart)' };
    const title = p.title?.trim() || `Kimi (real) ${realSessions.size + 1}`;
    const agentId = await defineDemoAgent(title, 'kimi');
    const spawn = await agents.spawnAgent(agentId as never);
    if (!spawn.ok) return { ok: false as const, error: spawn.error.message };
    const sessionId = spawn.value.sessionId;
    const personId = `person_pool${poolNext++}`;
    const agentSession = poolSessions.get(personId)!;
    const convoId = `conv_${randomUUID().slice(0, 8)}`;
    seedConvo(convoId, `person:${personId}`, title, 'agent', agentId);
    const c = convos.get(convoId)!;
    const s = toSummary(c);
    broadcast('conversation', s);
    realSessions.set(convoId, { sessionId, personId });

    // Live lane (R3-1): REAL CLI output chunks → real messaging replies.
    const sender: LiveLaneSender = {
      async sendMessage(input: unknown) {
        const res = await agentSession.sendMessage(input as never);
        if (res.kind === 'ok') {
          const v = res.value as { threadId: string; messageId: string };
          if (!c.threadId) c.threadId = v.threadId;
          broadcast('message', {
            id: v.messageId, conversationId: convoId, senderId: personId,
            text: (input as { body: { text: string } }).body.text,
            createdAt: new Date().toISOString(),
          });
        }
        return res;
      },
    };
    agents.attachLiveLane({ sessionId, address: `person:${ME}`, sender });
    return { ok: true as const, conversation: s };
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
    // REAL kimi conversations: forward the text into the live CLI session;
    // the reply comes back through the live lane as a messaging message.
    const real = realSessions.get(p.conversationId);
    if (real) {
      const sent = agentsCtx.adapters.kimi.send(real.sessionId, p.text);
      if (!sent) broadcast('message', {
        id: `note_${randomUUID().slice(0, 8)}`, conversationId: p.conversationId,
        senderId: real.personId, text: '⚠️ session is no longer running',
        createdAt: new Date().toISOString(),
      });
    }
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

console.log('[shell demo] bridge listening on ws://127.0.0.1:4173 (real messaging + foundation + agents, root .novakai/)');
