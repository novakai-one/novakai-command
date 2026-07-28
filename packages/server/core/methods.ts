// packages/server/core/methods.ts — the nvk-ws v1 method surface (§7).
//
// The method set is the demo's PROVEN set, minus demo affordances:
//   spawnMockAgent + spawnRealKimi  →  one spawnAgentConversation
//   getCapabilities keeps its shape (the shell reads it) but reports the real
//   provider registry rather than "is the demo's kimi shim present".
// Plus the lifecycle surface DEC-B1-6 makes possible: listSessions,
// terminateSession, getUsageTable.
//
// Every messaging call goes through a holder (red gate 5). Every stored
// mutation carries a clientOpId (R3-10). Persons come from config, never a pool
// (DEC-B1-8).
import { randomUUID } from 'node:crypto';
import type { AgentsContract, ProviderSessionRegistry, KimiCliRuntime } from '../../agents/contract/index.js';
import { composeShellPersistence, objectVersion } from '../../shell/contract/persistence.node.js';
import { getLayoutVersioned, setLayout as writeLayout } from '../../shell/contract/layout.js';
import * as settingsContract from '../../shell/contract/settings.js';
import { setConversationView } from '../../shell/contract/conversationView.js';
import type { ScreenContext } from '../../shell/contract/context.js';
import type { MethodTable } from '../contract/protocol.js';
import type { ServerConfig, ProviderName } from '../contract/config.js';
import type { ConfigStore } from './config/store.js';
import type { MessagingSessionHolder, SessionHolderFactory } from './session/holders.js';
import type { WatchdogHook } from './supervision/watchdog.js';

type ShellPersistence = ReturnType<typeof composeShellPersistence>;

export interface Conversation {
  id: string;
  threadId?: string;
  address: string;
  title: string;
  kind: 'agent' | 'room' | 'direct';
  pinned: boolean;
  archived: boolean;
  lastActivityAt: string;
  agentId?: string;
  /** The live provider session this conversation talks to, when spawned. */
  sessionId?: string;
  personId?: string;
}

/** Everything the methods operate on. Assembled once, by the composition root. */
export interface ServerRuntime {
  root: string;
  cwd: string;
  human: { personId: string; holder: MessagingSessionHolder };
  holders: SessionHolderFactory;
  agents: AgentsContract;
  kimiRuntime: KimiCliRuntime;
  sessions: ProviderSessionRegistry;
  watchdog: WatchdogHook;
  persistence: ShellPersistence;
  conversations: Map<string, Conversation>;
  configStore: ConfigStore;
  config: ServerConfig;
  focus: ScreenContext;
  broadcast(name: string, data: unknown): void;
  holderForPerson(personId: string): Promise<MessagingSessionHolder | null>;
  mintOpId(): string;
}

const now = () => new Date().toISOString();

/** The send-time snapshot line prepended to session-bound input (AGT-006). */
const contextLine = (focus: unknown): string => `[novakai context] ${JSON.stringify(focus)}`;

const summarize = (c: Conversation) => ({
  id: c.id, threadId: c.threadId ?? c.address, title: c.title, kind: c.kind,
  pinned: c.pinned, archived: c.archived, lastActivityAt: c.lastActivityAt,
  unreadCount: 0, agentId: c.agentId,
});

export function buildMethods(runtime: ServerRuntime): MethodTable {
  const persistView = async (c: Conversation, clientOpId: string): Promise<void> => {
    const res = await setConversationView(runtime.persistence.conversationViewDriver, c.id, {
      threadRef: c.threadId ? { kind: 'thread', id: c.threadId } : null,
      pinned: c.pinned,
      archived: c.archived,
      lastActivityAt: c.lastActivityAt,
      titleOverride: c.title,
    }, clientOpId);
    if (!res.ok) {
      console.error(`[nvk-server] conversationView persist failed for ${c.id}: ${res.error?.code} ${res.error?.message}`);
    }
  };

  /** Resolve the messaging thread behind a conversation (created on first send). */
  const threadFor = async (c: Conversation): Promise<string | null> => {
    if (c.threadId) return c.threadId;
    const res = await runtime.human.holder.call((s) =>
      (s as { listThreadsForPerson(input: object): Promise<unknown> }).listThreadsForPerson({})) as
      { kind: string; value?: { threads: Array<{ id: string; direct?: { pair: string[] } }> } };
    if (res.kind !== 'ok' || !res.value) return null;
    const person = c.address.startsWith('person:') ? c.address.slice('person:'.length) : null;
    const thread = person ? res.value.threads.find((t) => t.direct?.pair.includes(person)) : undefined;
    if (thread) { c.threadId = thread.id; return thread.id; }
    return null;
  };

  /**
   * G4 lesson, promoted (§9): look the definition up by displayName+provider
   * before defining, so a restart never appends a duplicate agent.
   */
  const ensureAgent = async (displayName: string, provider: ProviderName): Promise<string> => {
    const listed = await runtime.agents.listAgents() as
      { ok: boolean; value?: { items: Array<{ id: string; displayName: string; provider: string; status: string }> } };
    const existing = listed.ok
      ? listed.value?.items.find((a) => a.displayName === displayName && a.provider === provider && a.status !== 'archived')
      : undefined;
    if (existing) return existing.id;
    const defined = await runtime.agents.defineAgent(
      { displayName, provider, model: runtime.configStore.current().providers[provider].defaultModel },
      runtime.mintOpId() as never,
    ) as { ok: boolean; value?: { id: string }; error?: { message: string } };
    if (!defined.ok || !defined.value) throw new Error(`defineAgent failed: ${defined.error?.message ?? 'unknown'}`);
    return defined.value.id;
  };

  /**
   * DEC-B1-8: no pools. An agent that can hold conversations binds exactly ONE
   * person, provisioned through config, idempotently (existing binding reused,
   * never duplicated) — and the person opens its own door to Chris (DEC-14:
   * each principal owns its ContactPolicy).
   */
  const ensureAgentPerson = async (agentId: string): Promise<string> => {
    const config = runtime.configStore.current();
    const bound = config.bindings.find((b) => b.agentId === agentId);
    if (bound) {
      await openContactPolicy(bound.personId);
      return bound.personId;
    }
    const personId = `person_a${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    // A messaging-only principal writes no objects: an empty grant set is the
    // honest scope, not a borrowed one.
    const token = runtime.configStore.mintPrincipalToken({ personId, roles: ['Worker'], grants: [] });
    await runtime.configStore.set(
      { configKind: 'principal', personId, roles: ['Worker'], tokenId: token.id },
      runtime.mintOpId() as never,
    );
    await runtime.configStore.set(
      { configKind: 'agentPersonBinding', agentId, personId },
      runtime.mintOpId() as never,
    );
    await openContactPolicy(personId);
    await allowHumanToReach(personId);
    return personId;
  };

  /** The agent person allows Chris and denies everyone else (demo pattern). */
  const openContactPolicy = async (personId: string): Promise<void> => {
    const holder = await runtime.holderForPerson(personId);
    if (!holder) return;
    await holder.call((s) => (s as { setContactPolicy(p: object): Promise<unknown> })
      .setContactPolicy({ allowlist: [runtime.human.personId], defaultRule: 'deny' }));
  };

  /** Chris's own allowlist grows to include every provisioned agent person. */
  const allowHumanToReach = async (_personId: string): Promise<void> => {
    const others = runtime.configStore.current().principals
      .map((p) => p.personId)
      .filter((id) => id !== runtime.human.personId);
    await runtime.human.holder.call((s) => (s as { setContactPolicy(p: object): Promise<unknown> })
      .setContactPolicy({ allowlist: others, defaultRule: 'deny' }));
  };

  /** Live lane (R3-1): provider output → a REAL messaging reply from the agent's person. */
  const attachLane = (conversation: Conversation, sessionId: string, personId: string): void => {
    const sender = {
      async sendMessage(input: unknown) {
        const holder = await runtime.holderForPerson(personId);
        if (!holder) return { kind: 'error', error: { name: 'NotAuthenticated', message: `no holder for ${personId}` } };
        const res = await holder.call((s) => (s as { sendMessage(i: unknown): Promise<unknown> }).sendMessage(input)) as
          { kind: string; value?: { threadId: string; messageId: string } };
        if (res.kind === 'ok' && res.value) {
          if (!conversation.threadId) conversation.threadId = res.value.threadId;
          conversation.lastActivityAt = now();
          runtime.broadcast('message', {
            id: res.value.messageId, conversationId: conversation.id, senderId: personId,
            text: (input as { body: { text: string } }).body.text, createdAt: now(),
          });
        }
        return res;
      },
    };
    runtime.agents.attachLiveLane({ sessionId, address: `person:${runtime.human.personId}`, sender } as never);
  };

  return {
    // ── S2b context bus (SHL-008): the server is the focus AUTHORITY ────────
    async publishFocus(params: never) {
      runtime.focus = params as ScreenContext;
      for (const conversation of runtime.conversations.values()) {
        if (conversation.sessionId) {
          runtime.agents.pushContextAdvisory(conversation.sessionId as never, contextLine(runtime.focus));
        }
      }
      return { ok: true };
    },
    async getFocus() {
      return runtime.focus;
    },

    // ── conversations ──────────────────────────────────────────────────────
    async listConversations() {
      return [...runtime.conversations.values()].map(summarize);
    },

    async createConversation(params: never) {
      const p = params as { title: string; kind: Conversation['kind']; clientOpId: string };
      const id = `conv_${randomUUID().slice(0, 8)}`;
      let address = `thread:thread_${randomUUID().slice(0, 8)}`;
      let agentId: string | undefined;
      let personId: string | undefined;
      if (p.kind === 'agent') {
        agentId = await ensureAgent(p.title, 'kimi');
        personId = await ensureAgentPerson(agentId);
        address = `person:${personId}`;
      }
      const conversation: Conversation = {
        id, address, title: p.title, kind: p.kind, pinned: false, archived: false,
        lastActivityAt: now(), ...(agentId ? { agentId } : {}), ...(personId ? { personId } : {}),
      };
      runtime.conversations.set(id, conversation);
      await persistView(conversation, p.clientOpId);
      const summary = summarize(conversation);
      runtime.broadcast('conversation', summary);
      return summary;
    },

    /**
     * The demo's spawnMockAgent + spawnRealKimi, unified (§7). One path: define
     * (idempotently) → provision the person → spawn on the configured provider
     * → register the session → bind the live lane.
     */
    async spawnAgentConversation(params: never) {
      const p = (params ?? {}) as { title?: string; provider?: 'kimi' | 'claude' | 'codex' | 'mock' };
      const provider = p.provider ?? 'kimi';
      const title = p.title?.trim() || `Agent ${runtime.conversations.size + 1}`;
      const agentId = await ensureAgent(title, provider);
      const personId = await ensureAgentPerson(agentId);

      const spawn = await runtime.agents.spawnAgent(agentId as never) as
        { ok: boolean; value?: { sessionId: string; model: string }; error?: { message: string } };
      if (!spawn.ok || !spawn.value) return { ok: false as const, error: spawn.error?.message ?? 'spawn failed' };
      const sessionId = spawn.value.sessionId;

      await runtime.sessions.register({
        sessionId, agentId, provider, cwd: runtime.cwd, model: spawn.value.model || 'cli-default',
      });
      runtime.watchdog.register({
        sessionId, provider, task: title, transcriptPath: null, cwd: runtime.cwd,
      });

      const conversation: Conversation = {
        id: `conv_${randomUUID().slice(0, 8)}`,
        address: `person:${personId}`,
        title, kind: 'agent', pinned: false, archived: false,
        lastActivityAt: now(), agentId, sessionId, personId,
      };
      runtime.conversations.set(conversation.id, conversation);
      await persistView(conversation, runtime.mintOpId());
      attachLane(conversation, sessionId, personId);

      const summary = summarize(conversation);
      runtime.broadcast('conversation', summary);
      return { ok: true as const, conversation: summary, sessionId };
    },

    async getCapabilities() {
      const config = runtime.configStore.current();
      return {
        protocol: 'nvk-ws v1',
        providers: {
          kimi: runtime.kimiRuntime.isAvailable(),
          claude: false, // B1b
          codex: false,  // B1b
          mock: config.dev.allowMock,
        },
        // The shell's existing capability check keeps working unchanged.
        realKimi: runtime.kimiRuntime.isAvailable(),
      };
    },

    async pinConversation(params: never) {
      const p = params as { id: string; pinned: boolean; clientOpId: string };
      const c = runtime.conversations.get(p.id);
      if (!c) return { ok: false, error: 'unknown conversation' };
      c.pinned = p.pinned;
      c.lastActivityAt = now();
      await persistView(c, p.clientOpId);
      runtime.broadcast('conversation', summarize(c));
      return { ok: true };
    },

    async archiveConversation(params: never) {
      const p = params as { id: string; archived: boolean; clientOpId: string };
      const c = runtime.conversations.get(p.id);
      if (!c) return { ok: false, error: 'unknown conversation' };
      c.archived = p.archived;
      c.lastActivityAt = now();
      await persistView(c, p.clientOpId);
      runtime.broadcast('conversation', summarize(c));
      return { ok: true };
    },

    // ── messages ───────────────────────────────────────────────────────────
    async getMessages(params: never) {
      const p = params as { conversationId: string };
      const c = runtime.conversations.get(p.conversationId);
      if (!c) return [];
      const threadId = await threadFor(c);
      if (!threadId) return [];
      const res = await runtime.human.holder.call((s) =>
        (s as { getMessages(i: object): Promise<unknown> }).getMessages({ threadId, limit: 200 })) as
        { kind: string; value?: { messages: Array<{ id: string; senderId: string; body: { text: string }; createdAt: string }> } };
      if (res.kind !== 'ok' || !res.value) return [];
      return res.value.messages.map((m) => ({
        id: m.id,
        conversationId: p.conversationId,
        senderId: m.senderId === runtime.human.personId ? 'me' : m.senderId,
        text: m.body.text,
        createdAt: m.createdAt,
      }));
    },

    async sendMessage(params: never) {
      const p = params as { conversationId: string; text: string; clientOpId?: string };
      const c = runtime.conversations.get(p.conversationId);
      if (!c) return { ok: false, error: 'unknown conversation' };
      const address = c.threadId ? `thread:${c.threadId}` : c.address;
      // §13 disposition 2: the SAME clientMessageId is reused on a manual
      // resend, so messaging idempotency prevents a double post.
      const clientMessageId = p.clientOpId ?? `cmsg_${randomUUID()}`;
      const res = await runtime.human.holder.call((s) => (s as { sendMessage(i: object): Promise<unknown> }).sendMessage({
        address, body: { text: p.text }, priority: 'normal', clientMessageId,
      })) as { kind: string; value?: { threadId: string; messageId: string }; error?: { name: string; message: string } };
      if (res.kind !== 'ok' || !res.value) {
        return { ok: false, error: `${res.error?.name}: ${res.error?.message}` };
      }
      if (!c.threadId) c.threadId = res.value.threadId;
      c.lastActivityAt = now();

      const message = {
        id: res.value.messageId, conversationId: p.conversationId, senderId: 'me',
        text: p.text, createdAt: now(), context: runtime.focus,
      };
      runtime.broadcast('message', message);

      if (c.sessionId) {
        await runtime.sessions.markSending(c.sessionId, { clientOpId: clientMessageId });
        await runtime.sessions.clearInterruption(c.sessionId);
        const forwarded = await runtime.agents.sendToSession(
          c.sessionId as never, `${contextLine(runtime.focus)}\n${p.text}`,
        );
        if (!forwarded) {
          runtime.broadcast('message', {
            id: `note_${randomUUID().slice(0, 8)}`, conversationId: p.conversationId,
            senderId: c.personId ?? 'system', text: '⚠️ session is no longer running',
            createdAt: now(),
          });
        }
      }
      return { ok: true, message };
    },

    // ── shell persistence (unchanged semantics) ────────────────────────────
    async getLayout() {
      return getLayoutVersioned(runtime.persistence.layoutDriver);
    },
    async setLayout(params: never) {
      const p = params as { patch: Record<string, unknown>; clientOpId: string };
      return writeLayout(runtime.persistence.layoutDriver, p.patch, p.clientOpId);
    },
    async getSettings() {
      return settingsContract.getSettings(runtime.persistence.settingsDriver);
    },
    async setSetting(params: never) {
      const p = params as { key: string; value: unknown; opts: Parameters<typeof settingsContract.setSetting>[3] };
      return settingsContract.setSetting(runtime.persistence.settingsDriver, p.key, p.value, p.opts);
    },

    // ── agents registry (S2a seam, unchanged) ──────────────────────────────
    async listAgents() {
      const res = await runtime.agents.listAgents() as
        { ok: boolean; value?: { items: Array<Record<string, unknown>> } };
      if (!res.ok || !res.value) return [];
      return Promise.all(res.value.items.map(async (a) => ({
        ...a,
        version: await objectVersion(runtime.persistence.handle, 'agent', String(a.id)),
      })));
    },
    async defineAgent(params: never) {
      const p = params as { input: Parameters<AgentsContract['defineAgent']>[0]; clientOpId: string };
      return runtime.agents.defineAgent(p.input, p.clientOpId as never);
    },
    async updateAgent(params: never) {
      const p = params as { id: string; patch: Parameters<AgentsContract['updateAgent']>[1]; expectedVersion: number; clientOpId: string };
      return runtime.agents.updateAgent(p.id as never, p.patch, p.expectedVersion, p.clientOpId as never);
    },
    async setAgentModel(params: never) {
      const p = params as { agentId: string; model: string; clientOpId: string };
      return runtime.agents.setModel(p.agentId as never, p.model, p.clientOpId as never);
    },
    async listSkills() {
      const res = await runtime.agents.listSkills() as { ok: boolean; value?: { items: unknown[] } };
      return res.ok && res.value ? res.value.items : [];
    },

    // ── session lifecycle (DEC-B1-6 made visible) ──────────────────────────
    async listSessions() {
      return runtime.sessions.list();
    },
    async terminateSession(params: never) {
      const p = params as { sessionId: string };
      runtime.agents.closeSession(p.sessionId as never);
      await runtime.sessions.close(p.sessionId, 'closed');
      runtime.watchdog.close(p.sessionId);
      for (const c of runtime.conversations.values()) {
        if (c.sessionId === p.sessionId) delete c.sessionId;
      }
      return { ok: true };
    },
    /**
     * Real data only: turns, model, activity and status come from the registry.
     * Token counts are NULL for kimi because kimi 0.29.1 stream-json emits no
     * usage line — the gap is reported, never guessed (DEC-B1-7); the B1b
     * watchdog fills it from transcripts.
     */
    async getUsageTable() {
      const rows = await runtime.sessions.list();
      return {
        rows: rows.map((r) => ({
          sessionId: r.sessionId, agentId: r.agentId, provider: r.provider, model: r.model,
          turns: r.turns, lastActivityAt: r.lastActivityAt, status: r.status,
          inputTokens: null, outputTokens: null,
          interrupted: (r.lastInterruption as { clientOpId: string } | null)?.clientOpId ?? null,
        })),
        tokenAccounting: 'unavailable-in-B1a: kimi stream-json emits no usage records (B1b transcript parsing)',
      };
    },
  };
}
