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
import { recordSystemAction } from '@novakai/foundation/dist/contract/index.js';
import type {
  AgentsContract, ProviderSessionRegistry, KimiCliRuntime, ProviderCliRuntime,
} from '../../agents/contract/index.js';
import type { SupervisionEngine } from './supervision/engine.js';
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
  /** Which provider that session runs on — decides advisory delivery. */
  provider?: ProviderName;
}

/** Everything the methods operate on. Assembled once, by the composition root. */
export interface ServerRuntime {
  root: string;
  cwd: string;
  human: { personId: string; holder: MessagingSessionHolder };
  holders: SessionHolderFactory;
  agents: AgentsContract;
  kimiRuntime: KimiCliRuntime;
  /** B1b: every bound provider CLI runtime, for capability reporting. */
  providerRuntimes: Partial<Record<ProviderName, ProviderCliRuntime>>;
  sessions: ProviderSessionRegistry;
  /** B1b §8: the supervision engine owns lifecycle + usage. */
  supervision: SupervisionEngine;
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

/**
 * conversationView is the SOURCE OF TRUTH for a conversation across restarts
 * (F1/DEC-S2-11), so it must be re-saved the moment the thread id is LEARNED —
 * a thread is created on the first send, and a view still holding threadRef
 * null cannot be relinked to its provider session on the next boot.
 */
async function persistView(runtime: ServerRuntime, c: Conversation, clientOpId: string): Promise<void> {
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
}

/** Live lane (R3-1): provider output → a REAL messaging reply from the agent's person. */
function attachLane(runtime: ServerRuntime, conversation: Conversation, sessionId: string, personId: string): void {
  const sender = {
    async sendMessage(input: unknown) {
      const holder = await runtime.holderForPerson(personId);
      if (!holder) return { kind: 'error', error: { name: 'NotAuthenticated', message: `no holder for ${personId}` } };
      const res = await holder.call((s) => (s as { sendMessage(i: unknown): Promise<unknown> }).sendMessage(input)) as
        { kind: string; value?: { threadId: string; messageId: string } };
      if (res.kind === 'ok' && res.value) {
        const learnedThread = !conversation.threadId;
        if (learnedThread) conversation.threadId = res.value.threadId;
        conversation.lastActivityAt = now();
        if (learnedThread) await persistView(runtime, conversation, runtime.mintOpId());
        runtime.broadcast('message', {
          id: res.value.messageId, conversationId: conversation.id, senderId: personId,
          text: (input as { body: { text: string } }).body.text, createdAt: now(),
        });
      }
      return res;
    },
  };
  runtime.agents.attachLiveLane({ sessionId, address: `person:${runtime.human.personId}`, sender } as never);
}

/**
 * Boot step 7b (DEC-B1-6): a session that outlived the process is rebound to
 * BOTH its provider runtime and its conversation. Without the second half the
 * thread would look alive while every send went nowhere — the failure a restart
 * is supposed to make impossible.
 */
export async function restoreLiveSessions(runtime: ServerRuntime): Promise<number> {
  const config = runtime.configStore.current();
  const threads = await runtime.human.holder.call((s) =>
    (s as { listThreadsForPerson(i: object): Promise<unknown> }).listThreadsForPerson({})) as
    { kind: string; value?: { threads: Array<{ id: string; direct?: { pair: string[] } }> } };
  const byPerson = new Map<string, string>();
  if (threads.kind === 'ok' && threads.value) {
    for (const thread of threads.value.threads) {
      for (const person of thread.direct?.pair ?? []) byPerson.set(person, thread.id);
    }
  }

  let restored = 0;
  for (const record of await runtime.sessions.resumable()) {
    const binding = config.bindings.find((b) => b.agentId === record.agentId);
    if (!binding) continue;
    const rebound = runtime.agents.reattachSession({
      sessionId: record.sessionId,
      agentId: record.agentId,
      provider: record.provider,
      providerConversationId: record.providerConversationId,
      model: record.model,
      cwd: record.cwd,
    });
    if (!rebound) continue;
    const threadId = byPerson.get(binding.personId);
    const conversation = [...runtime.conversations.values()].find((c) => c.threadId === threadId);
    if (!conversation) continue;
    conversation.sessionId = record.sessionId;
    conversation.personId = binding.personId;
    conversation.provider = record.provider;
    conversation.agentId = record.agentId;
    conversation.address = `person:${binding.personId}`;
    attachLane(runtime, conversation, record.sessionId, binding.personId);
    restored += 1;
  }
  return restored;
}

export function buildMethods(runtime: ServerRuntime): MethodTable {
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

  return {
    // ── S2b context bus (SHL-008): the server is the focus AUTHORITY ────────
    async publishFocus(params: never) {
      runtime.focus = params as ScreenContext;
      for (const conversation of runtime.conversations.values()) {
        // §22 ruling 1 + the demo's recorded limit: a between-turn advisory to a
        // PRINT-MODE CLI session is a whole provider turn per focus change —
        // real money, and the agent reads it as an empty message. Real provider
        // sessions get their context from the send-time snapshot line instead
        // (AGT-006, applied in sendMessage); only in-process sessions take the
        // advisory.
        if (conversation.sessionId && conversation.provider === 'mock') {
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
      await persistView(runtime, conversation, p.clientOpId);
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
        lastActivityAt: now(), agentId, sessionId, personId, provider,
      };
      runtime.conversations.set(conversation.id, conversation);
      await persistView(runtime, conversation, runtime.mintOpId());
      attachLane(runtime, conversation, sessionId, personId);

      const summary = summarize(conversation);
      runtime.broadcast('conversation', summary);
      return { ok: true as const, conversation: summary, sessionId };
    },

    /**
     * Production entry point for DEC-B1-10. The caller supplies either an
     * existing agent id or a definition to create, then this method owns the
     * spawn → providerSession registration → two-turn gate/work lifecycle.
     */
    async runSupervisedTask(params: never) {
      const p = (params ?? {}) as {
        clientOpId?: string;
        agentId?: string;
        agentDef?: Parameters<AgentsContract['defineAgent']>[0];
        taskBrief?: string;
        providerOpts?: Parameters<AgentsContract['spawnAgent']>[1];
      };
      if (!p.clientOpId || !p.taskBrief?.trim() || Boolean(p.agentId) === Boolean(p.agentDef)) {
        return {
          ok: false as const,
          error: {
            code: 'InvalidSupervisedTask',
            message: 'clientOpId, taskBrief, and exactly one of agentId/agentDef are required',
          },
        };
      }

      let agentId = p.agentId;
      if (p.agentDef) {
        const defined = await runtime.agents.defineAgent(p.agentDef, p.clientOpId as never) as
          { ok: boolean; value?: { id: string }; error?: { code?: string; message?: string } };
        if (!defined.ok || !defined.value) {
          return {
            ok: false as const,
            error: {
              code: defined.error?.code ?? 'DefineAgentFailed',
              message: defined.error?.message ?? 'agent definition failed',
            },
          };
        }
        agentId = defined.value.id;
      } else {
        const found = await runtime.agents.getAgent(agentId! as never) as
          { ok: boolean; value?: { absent?: boolean }; error?: { code?: string; message?: string } };
        if (!found.ok || found.value?.absent) {
          return {
            ok: false as const,
            error: {
              code: found.error?.code ?? 'AgentNotFound',
              message: found.error?.message ?? `no agent with id "${agentId}"`,
            },
          };
        }
      }

      const spawned = await runtime.agents.spawnAgent(
        agentId! as never,
        p.providerOpts,
        p.clientOpId as never,
      ) as {
        ok: boolean;
        value?: { sessionId: string; model: string; provider: ProviderName };
        error?: { code?: string; message?: string };
      };
      if (!spawned.ok || !spawned.value) {
        return {
          ok: false as const,
          error: {
            code: spawned.error?.code ?? 'SpawnFailed',
            message: spawned.error?.message ?? 'agent spawn failed',
          },
        };
      }

      const sessionId = spawned.value.sessionId;
      const cwd = p.providerOpts?.cwd ?? runtime.cwd;
      const registered = await runtime.sessions.register({
        sessionId,
        agentId: agentId!,
        provider: spawned.value.provider,
        cwd,
        model: spawned.value.model || 'cli-default',
      });
      if (!registered.ok) {
        runtime.agents.closeSession(sessionId as never);
        return {
          ok: false as const,
          error: { code: registered.error.code, message: registered.error.message },
        };
      }
      runtime.watchdog.register({
        sessionId,
        provider: spawned.value.provider,
        task: p.taskBrief,
        transcriptPath: null,
        cwd,
      });

      const outcome = await runtime.supervision.runSupervisedTask({
        sessionId,
        agentId: agentId!,
        brief: p.taskBrief,
        clientOpId: p.clientOpId,
      });
      if (!outcome.ok) {
        runtime.watchdog.close(sessionId);
        return outcome;
      }
      if (outcome.taskComplete) {
        const ended = await runtime.supervision.terminate(
          sessionId,
          'supervised task complete',
          p.clientOpId,
        );
        runtime.watchdog.close(sessionId);
        if (!ended.ok) return { ok: false as const, sessionId, error: ended.error };
        return { ...outcome, terminated: true as const };
      }
      return { ...outcome, terminated: false as const };
    },

    async getCapabilities() {
      const config = runtime.configStore.current();
      // B1b: availability is MEASURED per provider (is the CLI on disk?), not
      // declared. A provider whose CLI is missing reports false rather than
      // letting a spawn fail later with a mystery.
      const available = (provider: ProviderName): boolean =>
        runtime.providerRuntimes[provider]?.isAvailable() ?? false;
      return {
        protocol: 'nvk-ws v1',
        providers: {
          kimi: available('kimi'),
          claude: available('claude'),
          codex: available('codex'),
          mock: config.dev.allowMock,
        },
        // The shell's existing capability check keeps working unchanged.
        realKimi: available('kimi'),
      };
    },

    async pinConversation(params: never) {
      const p = params as { id: string; pinned: boolean; clientOpId: string };
      const c = runtime.conversations.get(p.id);
      if (!c) return { ok: false, error: 'unknown conversation' };
      c.pinned = p.pinned;
      c.lastActivityAt = now();
      await persistView(runtime, c, p.clientOpId);
      runtime.broadcast('conversation', summarize(c));
      return { ok: true };
    },

    async archiveConversation(params: never) {
      const p = params as { id: string; archived: boolean; clientOpId: string };
      const c = runtime.conversations.get(p.id);
      if (!c) return { ok: false, error: 'unknown conversation' };
      c.archived = p.archived;
      c.lastActivityAt = now();
      await persistView(runtime, c, p.clientOpId);
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
        { kind: string; value?: { messages: Array<{
          id: string; senderId: string; body: { text: string }; createdAt: string; clientMessageId: string;
        }> } };
      if (res.kind !== 'ok' || !res.value) return [];
      return res.value.messages.map((m) => ({
        id: m.id,
        conversationId: p.conversationId,
        senderId: m.senderId === runtime.human.personId ? 'me' : m.senderId,
        text: m.body.text,
        createdAt: m.createdAt,
        clientOpId: m.clientMessageId,
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
      if (c.sessionId) {
        const marked = await runtime.sessions.markSending(c.sessionId, { clientOpId: clientMessageId });
        if (!marked.ok) return { ok: false, error: marked.error };
      }
      const res = await runtime.human.holder.call((s) => (s as { sendMessage(i: object): Promise<unknown> }).sendMessage({
        address, body: { text: p.text }, priority: 'normal', clientMessageId,
      })) as { kind: string; value?: { threadId: string; messageId: string }; error?: { name: string; message: string } };
      if (res.kind !== 'ok' || !res.value) {
        if (c.sessionId) {
          const closed = await runtime.sessions.markFailed(c.sessionId, clientMessageId);
          if (!closed.ok) return { ok: false, error: closed.error };
        }
        return { ok: false, error: `${res.error?.name}: ${res.error?.message}` };
      }
      const learnedThread = !c.threadId;
      if (learnedThread) c.threadId = res.value.threadId;
      c.lastActivityAt = now();
      if (learnedThread) await persistView(runtime, c, runtime.mintOpId());

      const message = {
        id: res.value.messageId, conversationId: p.conversationId, senderId: 'me',
        text: p.text, createdAt: now(), clientOpId: clientMessageId, context: runtime.focus,
      };
      runtime.broadcast('message', message);

      if (c.sessionId) {
        await runtime.sessions.clearInterruption(c.sessionId);
        const forwarded = await runtime.agents.sendToSession(
          c.sessionId as never, `${contextLine(runtime.focus)}\n${p.text}`,
        );
        if (!forwarded) {
          const closed = await runtime.sessions.markFailed(c.sessionId, clientMessageId);
          if (!closed.ok) return { ok: false, error: closed.error };
          runtime.broadcast('message', {
            id: `note_${randomUUID().slice(0, 8)}`, conversationId: p.conversationId,
            senderId: c.personId ?? 'system', text: '⚠️ session is no longer running',
            createdAt: now(),
          });
          return {
            ok: false,
            error: { code: 'ProviderSendFailed', sessionId: c.sessionId, clientOpId: clientMessageId },
          };
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
      const session = await runtime.sessions.get(p.sessionId);
      if (!session) return { ok: false, error: { code: 'SessionNotFound', sessionId: p.sessionId } };
      runtime.agents.closeSession(p.sessionId as never);
      const closed = await runtime.sessions.close(p.sessionId, 'closed');
      if (!closed.ok) return { ok: false, error: closed.error };
      runtime.watchdog.close(p.sessionId);
      for (const c of runtime.conversations.values()) {
        if (c.sessionId === p.sessionId) delete c.sessionId;
      }
      const traced = await recordSystemAction(runtime.persistence.handle, {
        action: 'session.terminate',
        target: { kind: 'session', id: p.sessionId },
        clientOpId: runtime.mintOpId() as never,
        meta: {
          refs: [
            { kind: 'session', id: p.sessionId },
            { kind: 'agent', id: session.agentId },
          ],
        },
      });
      if (!traced.ok) return { ok: false, error: traced.error };
      return { ok: true };
    },
    /**
     * B1b: REAL per-session token counts, parsed from the providers' own
     * transcripts (DEC-B1-11) — claude per-message, kimi wire.jsonl step.end,
     * codex rollout totals with a baseline subtracted because they are
     * cumulative. A session whose transcript cannot be read reports null and
     * says why; no number here is ever invented.
     */
    async getUsageTable() {
      return runtime.supervision.usageTable();
    },

    /**
     * DEC-B1-13, Chris verbatim: "terminated after any meaningful work and
     * re-started". The engine ends the session and spawns a fresh one for the
     * same agent, CARRYING the provider conversation id so the work continues.
     */
    async restartSession(params: never) {
      const p = params as { sessionId: string };
      const res = await runtime.supervision.restart(p.sessionId);
      if (!res.ok) return { ok: false as const, error: res.error };
      relinkConversation(runtime, p.sessionId, res.sessionId);
      return { ok: true as const, sessionId: res.sessionId };
    },

    /**
     * Chris verbatim: "They should also have compact as an option." No B1
     * provider declares a native compact, so restart-fresh IS the compact
     * (DEC-B1-5) — the context is dropped rather than resumed, and the reply
     * NAMES the mechanism instead of implying a native one.
     */
    async compactSession(params: never) {
      const p = params as { sessionId: string };
      const res = await runtime.supervision.compact(p.sessionId);
      if (!res.ok) return { ok: false as const, error: res.error };
      relinkConversation(runtime, p.sessionId, res.sessionId);
      return { ok: true as const, sessionId: res.sessionId, mechanism: res.mechanism };
    },

    /** §8: one cheap-first drift check-in on demand (the timer runs it too). */
    async checkDrift() {
      return runtime.supervision.checkDrift();
    },
  };
}

/**
 * A restarted session is a NEW sessionId. The conversation that was talking to
 * the old one has to follow it, or the thread would look alive while every send
 * went nowhere — the same failure mode B1a found after a server restart, which
 * is exactly why it is handled here rather than left to the caller.
 */
function relinkConversation(runtime: ServerRuntime, oldSessionId: string, newSessionId: string): void {
  for (const conversation of runtime.conversations.values()) {
    if (conversation.sessionId !== oldSessionId) continue;
    conversation.sessionId = newSessionId;
    if (conversation.personId) {
      attachLane(runtime, conversation, newSessionId, conversation.personId);
    }
  }
}
