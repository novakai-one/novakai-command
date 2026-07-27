// shell/demo/mockServices.ts — in-memory ShellServices. Used by tests and as
// the demo's never-blank fallback when the node bridge is unreachable.
// (Absence is drawn, not described — but the app must never look dead.)
import type {
  ChatMessage, ConversationSummary, MessagingEvents, SettingsRecord, ShellServices,
  AgentEvent, LayoutRecord,
} from '../contract/index.js';
import { defaultLayoutRecord } from '../contract/layout.js';
import { validateSetting } from '../contract/settings.js';

export function createMockServices(opts: { seeded?: boolean } = {}): ShellServices {
  let convos: ConversationSummary[] = opts.seeded === false ? [] : [
    { id: 'conv_kimi', threadId: 'thread_kimi', title: 'Kimi', kind: 'agent', pinned: true, archived: false, lastActivityAt: new Date().toISOString(), unreadCount: 0, agentId: 'agent_kimi' },
    { id: 'conv_fable', threadId: 'thread_fable', title: 'Fable', kind: 'agent', pinned: false, archived: false, lastActivityAt: new Date().toISOString(), unreadCount: 0, agentId: 'agent_fable' },
    { id: 'conv_build', threadId: 'thread_build', title: 'Build room', kind: 'room', pinned: false, archived: false, lastActivityAt: new Date().toISOString(), unreadCount: 0 },
  ];
  const messages = new Map<string, ChatMessage[]>();
  const listeners = new Set<MessagingEvents>();
  const presenceHandlers = new Set<(e: AgentEvent) => void>();
  let settingsStore: SettingsRecord[] = [];
  let layout: { record: LayoutRecord; version: number } = {
    record: defaultLayoutRecord(new Date().toISOString(), 'person_chris'),
    version: 1,
  };
  const emit = (fn: (l: MessagingEvents) => void) => listeners.forEach(fn);

  // demo presence: Kimi breathes online, Fable types occasionally
  setInterval(() => {
    const e: AgentEvent = { type: 'activity', agentId: 'agent_fable', sessionId: 'sess_mock', at: new Date().toISOString(), activity: 'thinking about the reply' };
    presenceHandlers.forEach((h) => h(e));
  }, 9000);

  return {
    async listConversations() { return convos; },
    async createConversation(title, kind) {
      const c: ConversationSummary = {
        id: `conv_${Math.random().toString(36).slice(2, 10)}`,
        threadId: `thread_${Math.random().toString(36).slice(2, 10)}`,
        title, kind, pinned: false, archived: false,
        lastActivityAt: new Date().toISOString(), unreadCount: 0,
      };
      convos = [c, ...convos];
      emit((l) => l.onConversation?.(c));
      return c;
    },
    async pinConversation(id, pinned) {
      convos = convos.map((c) => (c.id === id ? { ...c, pinned } : c));
      emit((l) => { const c = convos.find((x) => x.id === id); if (c) l.onConversation?.(c); });
    },
    async archiveConversation(id, archived) {
      convos = convos.map((c) => (c.id === id ? { ...c, archived } : c));
      emit((l) => { const c = convos.find((x) => x.id === id); if (c) l.onConversation?.(c); });
    },
    async getMessages(conversationId) { return messages.get(conversationId) ?? []; },
    async sendMessage(conversationId, text) {
      const m: ChatMessage = {
        id: `msg_${Math.random().toString(36).slice(2, 10)}`,
        conversationId, senderId: 'me', text, createdAt: new Date().toISOString(),
      };
      messages.set(conversationId, [...(messages.get(conversationId) ?? []), m]);
      return { ok: true as const, message: m };
    },
    subscribe(events) { listeners.add(events); return () => listeners.delete(events); },
    async spawnMockAgent(title) {
      const agentId = `agent_mock_${Math.random().toString(36).slice(2, 8)}`;
      const c: ConversationSummary = {
        id: `conv_${Math.random().toString(36).slice(2, 10)}`,
        threadId: `thread_${Math.random().toString(36).slice(2, 10)}`,
        title: title?.trim() || 'Mock agent', kind: 'agent', pinned: false, archived: false,
        lastActivityAt: new Date().toISOString(), unreadCount: 0, agentId,
      };
      convos = [c, ...convos];
      emit((l) => l.onConversation?.(c));
      const at = () => new Date().toISOString();
      const pe = (e: AgentEvent) => presenceHandlers.forEach((h) => h(e));
      pe({ type: 'spawned', agentId, sessionId: 'sess_mock', at: at() });
      pe({ type: 'online', agentId, sessionId: 'sess_mock', at: at() });
      setTimeout(() => pe({ type: 'activity', agentId, sessionId: 'sess_mock', at: at(), activity: 'typing a reply' }), 1500);
      setTimeout(() => pe({ type: 'offline', agentId, sessionId: 'sess_mock', at: at(), reason: 'closed' }), 6000);
      return { ok: true as const, conversation: c };
    },
    async getLayout() { return { ok: true as const, value: layout }; },
    async setLayout(patch) {
      layout = {
        record: { ...layout.record, ...patch } as LayoutRecord,
        version: layout.version + 1,
      };
      return { ok: true as const, value: layout };
    },
    async getSettings() { return settingsStore; },
    async setSetting(key, value, o) {
      const v = validateSetting(key, value, { derivedFrom: o?.derivedFrom, theme: o?.theme });
      if (!v.ok) return { ok: false as const, error: v.error };
      const rec: SettingsRecord = {
        kind: 'settings', id: `settings_${key}`, schemaVersion: 1,
        createdAt: new Date().toISOString(), permissionLevel: 'private',
        createdBy: 'person_chris', key, value,
        ...(o?.derivedFrom ? { derivedFrom: o.derivedFrom } : {}),
      };
      settingsStore = [...settingsStore.filter((r) => r.key !== key), rec];
      return { ok: true as const, value: rec };
    },
    presence: {
      subscribeAgentEvents(handler) {
        presenceHandlers.add(handler);
        handler({ type: 'online', agentId: 'agent_kimi', sessionId: 'sess_mock', at: new Date().toISOString() });
        return () => presenceHandlers.delete(handler);
      },
    },
  };
}
