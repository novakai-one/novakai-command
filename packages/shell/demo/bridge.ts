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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createKimiCliRuntime, defaultKimiCliPath } from './kimiCliRuntime.js';
// G3: unique provisioned person per spawned mock agent (pool pattern).
// G4: idempotent demo-agent seeding (no registry duplicates across boots).
import { mockAgentPrincipals, MockPersonPool } from './mockPersons.js';
import { ensureAgent, type EnsureAgentsContract } from './ensureAgent.js';

// foundation brands mints `op_${uuid}`; shell never imports foundation from
// the demo, so mint the same shape locally for defineAgent calls.
const mintOpId = () => `op_${randomUUID()}` as never;
import { composeShellPersistence, objectVersion } from '../contract/persistence.node.js';
import { getLayoutVersioned, setLayout as writeLayout } from '../contract/layout.js';
import * as settingsContract from '../contract/settings.js';
import { setConversationView, listConversationViews } from '../contract/conversationView.js';
import type { ScreenContext } from '../contract/context.js';
import type { AgentDefView } from '../contract/services.js';

// ── S2b context bus (SHL-008, DEC-S2-6) ─────────────────────────────────────
// The bridge is the focus AUTHORITY for this host (the browser publishes every
// focus change here; nvk-context pulls it here). Ephemeral, never persisted.
// Default satisfies red gate 2 from boot: {app, ref:'none'} is PRESENT (ruling 7).
let currentFocus: ScreenContext = { app: 'messaging', ref: 'none' };
/** The send-time snapshot line prepended to session-bound input (AGT-006). */
const contextLine = (ctx: ScreenContext): string =>
  `[novakai context] ${JSON.stringify(ctx)}`;

/** Map an agents-contract definition to the shell view (with CAS version). */
async function toAgentView(a: {
  id: string; displayName: string; provider: 'kimi' | 'claude' | 'codex' | 'mock';
  model: string; instructions: string; skills: string[]; status: 'defined' | 'archived';
  hooks: Array<{ id: string; event: string; action: { kind: string; text?: string; message?: string } }>;
}): Promise<AgentDefView> {
  return {
    id: a.id, displayName: a.displayName, provider: a.provider, model: a.model,
    instructions: a.instructions, hooks: a.hooks, skills: a.skills, status: a.status,
    version: await objectVersion(agentsCtx.handle, 'agent', a.id),
  };
}

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
      // G3: mock spawn agents each reply through their OWN provisioned person
      // (person_mockagent0..9) — sharing one person made every mock convo the
      // same messaging thread.
      ...mockAgentPrincipals().map((p) => ({ token: p.token, personId: p.personId as PersonId, roles: p.roles })),
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

// ── Session TTL survival (bug fix 2026-07-28) ─────────────────────────────
// Messaging sessions expire after 1h (DEFAULT_SESSION_TTL_MS) and the config
// authority has no refresh — a long-running demo bridge dies with
// "NotAuthenticated: session is no longer valid". Wrap every long-lived
// session: on an auth failure, re-authenticate with the same token and retry
// the operation once.
type SessionHolder = { token: string; session: messaging.MessagingSession };
const chrisHolder: SessionHolder = { token: TOKEN, session };
const isAuthFailure = (res: unknown): boolean => {
  const r = res as { kind?: string; error?: { name?: string; message?: string } };
  return r?.kind === 'error' && /NotAuthenticated|no longer valid/i.test(`${r.error?.name ?? ''} ${r.error?.message ?? ''}`);
};
async function reauth(holder: SessionHolder): Promise<void> {
  const a = await embedded.authenticate({ token: holder.token });
  if (a.kind !== 'authenticated') throw new Error(`re-auth failed for ${holder.token}`);
  holder.session = a.session;
}
async function sessCall<T>(holder: SessionHolder, op: (s: messaging.MessagingSession) => Promise<T>): Promise<T> {
  const first = await op(holder.session);
  if (!isAuthFailure(first)) return first;
  await reauth(holder);
  return op(holder.session);
}
// Chris may address every provisioned demo person (agents, pool, mock spawns).
await session.setContactPolicy({
  allowlist: ['person_kimi', 'person_fable', ...mockAgentPrincipals().map((p) => p.personId)],
  defaultRule: 'deny',
});

// Let the two demo agents accept Chris's messages: each principal owns its
// own ContactPolicy (DEC-14), so each agent session opens the door itself.
for (const [token, allow] of [['demo-token-kimi', ME], ['demo-token-fable', ME]] as const) {
  const a = await embedded.authenticate({ token });
  if (a.kind === 'authenticated') {
    await a.session.setContactPolicy({ allowlist: [allow], defaultRule: 'deny' });
  }
}
// Pool persons open their doors to Chris too (user-created agent chats).
const poolTokens: string[] = [];
const poolSessions = new Map<string, SessionHolder>();
for (let i = 0; i < 10; i++) {
  poolTokens.push(`demo-token-pool-${i}`);
  const a = await embedded.authenticate({ token: `demo-token-pool-${i}` });
  if (a.kind === 'authenticated') {
    await a.session.setContactPolicy({ allowlist: [ME], defaultRule: 'deny' });
    poolSessions.set(`person_pool${i}`, { token: `demo-token-pool-${i}`, session: a.session });
  }
}
let poolNext = 0;

// G3: mock-spawn persons — each opens its door to Chris and gets a
// sessCall-wrapped holder for its live lane (unique person per spawn).
const mockPool = new MockPersonPool();
const mockSessions = new Map<string, SessionHolder>();
for (const p of mockAgentPrincipals()) {
  const a = await embedded.authenticate({ token: p.token });
  if (a.kind !== 'authenticated') throw new Error(`demo mock-agent auth failed for ${p.personId}`);
  await a.session.setContactPolicy({ allowlist: [ME], defaultRule: 'deny' });
  mockSessions.set(p.personId, { token: p.token, session: a.session });
}

const persistence = composeShellPersistence({ root: NOVAKAI_ROOT, principal: ME });

// ── shell-side conversation metadata ─────────────────────────────────────────
// F1/DEC-S2-11: pin/archive/title-override are PERSISTED conversationView
// records (foundation scoped handle, kind 'conversationView') — the store is
// the source of truth; this Map is an in-memory cache hydrated at boot.
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
/** S2b: live-lane session ids by provider — focus-change advisories push only
 * to mock sessions here. For the REAL kimi CLI (prompt mode), a between-turn
 * advisory would consume a full provider turn per focus change — the send-time
 * context line covers req 9 there (recorded in shell NOTES.md). */
const laneSessions = new Map<string, 'mock' | 'kimi'>();

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

// F1/DEC-S2-11: conversationView is the SOURCE OF TRUTH for pin/archive/title.
// Boot hydration: stored views apply onto the cache (restart → pin/archive
// restored); conversations without a stored view get one (system op id —
// first-boot materialisation, same pattern as the layout default).
async function persistConvoView(c: Convo, clientOpId: string): Promise<void> {
  const res = await setConversationView(persistence.conversationViewDriver, c.id, {
    threadRef: c.threadId ? { kind: 'thread', id: c.threadId } : null,
    pinned: c.pinned,
    archived: c.archived,
    lastActivityAt: c.lastActivityAt,
  }, clientOpId);
  if (!res.ok) console.error(`[shell demo] conversationView persist failed for ${c.id}: ${res.error.code} ${res.error.message}`);
}
{
  const stored = await listConversationViews(persistence.conversationViewDriver);
  const byId = new Map(stored.map((v) => [v.id, v]));
  for (const c of convos.values()) {
    const v = byId.get(c.id);
    if (v) {
      c.pinned = v.pinned;
      c.archived = v.archived;
      if (v.titleOverride) c.title = v.titleOverride;
      if (v.threadRef?.kind === 'thread' && !c.threadId) c.threadId = v.threadRef.id;
    } else {
      await persistConvoView(c, `op_${randomUUID()}`); // first boot: materialise
    }
  }
}

// Demo affordance (S2a): seed one registry skill so the Agents screen's
// skills multi-select has something real to show (idempotent per root).
// M10: skill path refs must live under .novakai/skills/ — the seed creates the
// directory it references (a real, minimal skill dir).
{
  const existing = await agents.listSkills();
  if (existing.ok && existing.value.items.length === 0) {
    const seedDir = path.join(NOVAKAI_ROOT, 'skills', 'tdd');
    mkdirSync(seedDir, { recursive: true });
    if (!existsSync(path.join(seedDir, 'SKILL.md'))) {
      writeFileSync(path.join(seedDir, 'SKILL.md'), '# TDD\n\nTest-driven development: RED first, then GREEN, then refactor.\n');
    }
    await agents.registerSkill(
      { name: 'TDD', path: `.novakai/skills/tdd`, description: 'test-driven development' },
      mintOpId(),
    );
  }
}

const toSummary = (c: Convo) => ({
  id: c.id, threadId: c.threadId ?? c.address, title: c.title, kind: c.kind,
  pinned: c.pinned, archived: c.archived, lastActivityAt: c.lastActivityAt,
  unreadCount: 0, agentId: c.agentId,
});

// Resolve the messaging thread behind a conversation (created on first send).
async function threadFor(c: Convo): Promise<string | null> {
  if (c.threadId) return c.threadId;
  const res = await sessCall(chrisHolder, (s) => s.listThreadsForPerson({}));
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
  // S2b context bus: the UI publishes every focus change; nvk-context pulls.
  async publishFocus(p: ScreenContext) {
    currentFocus = p;
    // §22 ruling 1: in-app sessions get the advisory via the live lane as a
    // system context line BETWEEN turns (queued mid-turn by the lane).
    for (const [sid, kind] of laneSessions) {
      if (kind === 'mock') agents.pushContextAdvisory(sid as never, contextLine(currentFocus));
    }
    return { ok: true };
  },
  async getFocus() {
    return currentFocus;
  },
  async listConversations() {
    return [...convos.values()].filter((c) => !c.archived || true).map(toSummary);
  },
  async createConversation(p: { title: string; kind: Convo['kind']; clientOpId: string }) {
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
    await persistConvoView(c, p.clientOpId); // F1: persisted view state from birth
    const s = toSummary(c);
    broadcast('conversation', s);
    return s;
  },
  // Demo affordance (SHL-006/007 proof): define + spawn a REAL agents-registry
  // agent on the mock provider, script its session lifecycle, and bind the live
  // lane so its output lands in the thread as a real messaging reply.
  async spawnMockAgent(p: { title?: string }) {
    const title = p.title?.trim() || `Mock agent ${convos.size - 1}`;
    // G3: a UNIQUE provisioned person per spawn — sharing person_mock made
    // every mock conversation resolve to the same messaging thread, so agents
    // replied into each other's chats.
    const assigned = mockPool.assign();
    if (!assigned) return { ok: false as const, error: 'demo mock pool exhausted (10 mock agents per restart)' };
    const holder = mockSessions.get(assigned.personId)!;
    const agentId = await defineDemoAgent(title);
    const spawn = await agents.spawnAgent(agentId as never);
    if (!spawn.ok) return { ok: false as const, error: spawn.error.message };
    const sessionId = spawn.value.sessionId;
    const convoId = `conv_${randomUUID().slice(0, 8)}`;
    seedConvo(convoId, `person:${assigned.personId}`, title, 'agent', agentId);
    const c = convos.get(convoId)!;
    await persistConvoView(c, mintOpId()); // F1: persisted view state from birth
    const s = toSummary(c);
    broadcast('conversation', s);

    // Live lane (R3-1): mock session output → real messaging reply to Chris
    // THROUGH THE SPAWN'S OWN PERSON (sessCall-wrapped holder), then mirrored
    // to the UI as a message event for this conversation.
    const sender: LiveLaneSender = {
      async sendMessage(input: unknown) {
        const res = await sessCall(holder, (s) => s.sendMessage(input as never));
        if (res.kind === 'ok') {
          const v = res.value as { threadId: string; messageId: string };
          if (!c.threadId) c.threadId = v.threadId;
          broadcast('message', {
            id: v.messageId, conversationId: convoId, senderId: assigned.personId,
            text: (input as { body: { text: string } }).body.text,
            createdAt: new Date().toISOString(),
          });
        }
        return res;
      },
    };
    agents.attachLiveLane({ sessionId, address: `person:${ME}`, sender });
    laneSessions.set(sessionId, 'mock');

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
    await persistConvoView(c, mintOpId()); // F1: persisted view state from birth
    const s = toSummary(c);
    broadcast('conversation', s);
    realSessions.set(convoId, { sessionId, personId });

    // Live lane (R3-1): REAL CLI output chunks → real messaging replies.
    const sender: LiveLaneSender = {
      async sendMessage(input: unknown) {
        const res = await sessCall(agentSession, (s) => s.sendMessage(input as never));
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
    laneSessions.set(sessionId, 'kimi');
    return { ok: true as const, conversation: s };
  },
  async pinConversation(p: { id: string; pinned: boolean; clientOpId: string }) {
    // F1: UI-originated mutation — clientOpId threads to foundation meta (R3-10).
    const c = convos.get(p.id);
    if (c) {
      c.pinned = p.pinned;
      c.lastActivityAt = new Date().toISOString();
      await persistConvoView(c, p.clientOpId);
      broadcast('conversation', toSummary(c));
    }
  },
  async archiveConversation(p: { id: string; archived: boolean; clientOpId: string }) {
    const c = convos.get(p.id);
    if (c) {
      c.archived = p.archived;
      c.lastActivityAt = new Date().toISOString();
      await persistConvoView(c, p.clientOpId);
      broadcast('conversation', toSummary(c));
    }
  },
  async getMessages(p: { conversationId: string }) {
    const c = convos.get(p.conversationId);
    if (!c) return [];
    const threadId = await threadFor(c);
    if (!threadId) return [];
    const res = await sessCall(chrisHolder, (s) => s.getMessages({ threadId, limit: 200 }));
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
    const res = await sessCall(chrisHolder, (s) => s.sendMessage({
      address,
      body: { text: p.text },
      priority: 'normal',
      clientMessageId: `cmsg_${randomUUID()}`,
    }));
    if (res.kind !== 'ok') return { ok: false, error: `${res.error.name}: ${res.error.message}` };
    if (!c.threadId) c.threadId = res.value.threadId;
    // SHL-008 red gate: the send-time snapshot attaches to EVERY human-composed
    // message. currentFocus is always present (default {app, ref:'none'}).
    const message = {
      id: res.value.messageId, conversationId: p.conversationId, senderId: 'me',
      text: p.text, createdAt: new Date().toISOString(),
      context: currentFocus,
    };
    broadcast('message', message);
    // REAL kimi conversations: forward the text through the CONTRACT send
    // path (S2a — onMessagePre/onMessagePost hooks fire, injections prepend);
    // the reply comes back through the live lane as a messaging message.
    // AGT-006: the send-time context snapshot travels WITH the message.
    const real = realSessions.get(p.conversationId);
    if (real) {
      const sent = await agents.sendToSession(real.sessionId as never, `${contextLine(currentFocus)}\n${p.text}`);
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
  async setLayout(p: { patch: Record<string, unknown>; clientOpId: string }) {
    // M5: the interaction layer's clientOpId threads through to foundation meta.
    return writeLayout(persistence.layoutDriver, p.patch as never, p.clientOpId);
  },
  async getSettings() {
    return settingsContract.getSettings(persistence.settingsDriver);
  },
  async setSetting(p: { key: string; value: unknown; opts: { derivedFrom?: string; theme?: 'dark' | 'light'; clientOpId: string } }) {
    return settingsContract.setSetting(persistence.settingsDriver, p.key, p.value, p.opts);
  },
  // ── S2a agents seam: agent-def UI + model picker over the REAL contract ──
  async listAgents() {
    const res = await agents.listAgents();
    if (!res.ok) return [];
    return Promise.all(res.value.items.map((a) => toAgentView(a)));
  },
  async defineAgent(p: { input: { displayName: string; provider: 'kimi' | 'claude' | 'codex' | 'mock'; model: string; instructions?: string; skills?: string[] }; clientOpId: string }) {
    const res = await agents.defineAgent(p.input, p.clientOpId as never);
    if (!res.ok) return { ok: false as const, error: { code: res.error.code, message: res.error.message } };
    return { ok: true as const, value: await toAgentView(res.value) };
  },
  async updateAgent(p: { id: string; patch: Record<string, unknown>; expectedVersion: number; clientOpId: string }) {
    const res = await agents.updateAgent(p.id as never, p.patch as never, p.expectedVersion, p.clientOpId as never);
    if (!res.ok) return { ok: false as const, error: { code: res.error.code, message: res.error.message } };
    return { ok: true as const, value: await toAgentView(res.value) };
  },
  async setAgentModel(p: { agentId: string; model: string; clientOpId: string }) {
    // DEC-S2-5: model truth lives in agents — the UI writes via setModel only.
    const res = await agents.setModel(p.agentId as never, p.model, p.clientOpId as never);
    if (!res.ok) return { ok: false as const, error: { code: res.error.code, message: res.error.message } };
    return { ok: true as const, value: await toAgentView(res.value) };
  },
  async listSkills() {
    const res = await agents.listSkills();
    if (!res.ok) return [];
    return res.value.items.map((s) => ({ id: s.id, name: s.name, path: s.path, description: s.description }));
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
