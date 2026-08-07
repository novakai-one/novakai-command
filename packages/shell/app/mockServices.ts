// shell/demo/mockServices.ts — in-memory ShellServices. Used by tests and as
// the demo's never-blank fallback when the node bridge is unreachable.
// (Absence is drawn, not described — but the app must never look dead.)
import type {
  ChatMessage, ConversationSummary, MessagingEvents, SettingsRecord, ShellServices,
  AgentEvent, LayoutRecord, NotificationView,
} from '../contract/index.js';
import { defaultLayoutRecord } from '../contract/layout.js';
import { validateSetting } from '../contract/settings.js';
import { fail, ok, persistFailed } from '../contract/errors.js';
import {
  closeTerminalTab, setTerminalTab,
  type TerminalTabDriver, type TerminalTabRecord,
} from '../contract/terminalTab.js';
import { composeHumanMessage, type FocusSnapshot } from '../contract/context.js';
import { createOfflineAgentServices } from './mockAgentRuns.js';

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
  // CAS is modelled, not skipped: a stale expectedVersion is refused here the
  // same way Foundation refuses it, so a UI that forgets to re-read is caught in
  // the demo rather than only against a real store.
  const mockTabs = new Map<string, { record: TerminalTabRecord; version: number }>();
  const mockTabDriver: TerminalTabDriver = {
    async list() { return [...mockTabs.values()].map((held) => held.record); },
    async read(id) { return mockTabs.get(id) ?? null; },
    async create(record, _clientOpId) {
      if (mockTabs.has(record.id)) {
        return fail(persistFailed('terminalTab', 'Conflict', `tab ${record.id} already exists`));
      }
      const held = { record, version: 1 };
      mockTabs.set(record.id, held);
      return ok(held);
    },
    async update(id, record, expectedVersion, _clientOpId) {
      const current = mockTabs.get(id);
      if (!current) return fail(persistFailed('terminalTab', 'NotFound', `no terminal tab ${id}`));
      if (current.version !== expectedVersion) {
        return fail(persistFailed('terminalTab', 'VersionConflict', `tab ${id} moved on`));
      }
      const held = { record, version: current.version + 1 };
      mockTabs.set(id, held);
      return ok(held);
    },
  };
  const emit = (fn: (l: MessagingEvents) => void) => listeners.forEach(fn);

  // Lane C: notifications covering every durable state AND both drift phases,
  // so the ONE attention row, its release, and the human-escalation exception
  // are all drivable without a Supervision engine.
  //
  // These are whole FZ-VIEW-024 records, not the seven-field row the Shell used
  // to invent (L-14): the mock answers the FROZEN door, so the offline harness
  // exercises `app/supervision.ts` rather than a second path around it.
  let notifications: NotificationView[] = [
    // TWO human escalations, on purpose. One mark, not two — the fixture that
    // would have shipped the wrong screenshot here is the one where only a
    // single row can qualify, because then "at most one mark" is untested by
    // the picture. Settling this one releases the mark onto the other.
    { id: 'notification_escalation_seen', summary: 'Fable stopped mid-turn and its work is unfinished',
      state: 'transcript-observed', deliveryMode: 'start-turn', phase: 'drift-human-escalation',
      driftEpisodeId: 'driftepisode_fable_4', watchRuleId: 'watchrule_drift_fable',
      conditionGeneration: 7, evidenceRefs: ['driftcheck_9'],
      recipient: { kind: 'human', principalId: 'person_chris' },
      subject: { kind: 'agent', agentId: 'agent_fable' },
      createdAt: '2026-08-03T10:55:00.000Z' },
    { id: 'notification_escalation', summary: 'Kimi has stopped answering and its work is unfinished',
      state: 'queued', deliveryMode: 'start-turn', phase: 'drift-human-escalation',
      driftEpisodeId: 'driftepisode_kimi_1', watchRuleId: 'watchrule_drift_kimi',
      conditionGeneration: 12, evidenceRefs: ['driftcheck_2', 'driftcheck_3'],
      recipient: { kind: 'human', principalId: 'person_chris' },
      subject: { kind: 'agent', agentId: 'agent_kimi' },
      createdAt: '2026-08-03T10:50:00.000Z' },
    { id: 'notification_seen_2', summary: 'Kimi has not answered the supervision check-in',
      state: 'transcript-observed', deliveryMode: 'start-turn', phase: 'drift-status-request',
      driftEpisodeId: 'driftepisode_kimi_1', watchRuleId: 'watchrule_drift_kimi',
      conditionGeneration: 12, evidenceRefs: ['driftcheck_1'],
      recipient: { kind: 'agent', agentId: 'agent_kimi' },
      subject: { kind: 'agent', agentId: 'agent_kimi' },
      createdAt: '2026-08-03T10:40:00.000Z' },
    { id: 'notification_seen_1', summary: 'Output token threshold reached',
      state: 'transcript-observed', deliveryMode: 'start-turn', phase: 'condition',
      watchRuleId: 'watchrule_tokens', conditionGeneration: 4,
      evidenceRefs: ['usageevidence_88'],
      recipient: { kind: 'human', principalId: 'person_chris' },
      subject: { kind: 'agent', agentId: 'agent_fable' },
      createdAt: '2026-08-03T10:20:00.000Z' },
    { id: 'notification_uncertain', summary: 'Build room reply never appeared in the transcript',
      state: 'delivery-uncertain', deliveryMode: 'next-turn-context', phase: 'condition',
      watchRuleId: 'watchrule_reply', conditionGeneration: 2, evidenceRefs: [],
      recipient: { kind: 'human', principalId: 'person_chris' },
      subject: { kind: 'agent-run', agentRunId: 'agentrun_codex_7' },
      createdAt: '2026-08-03T10:10:00.000Z' },
    { id: 'notification_sent', summary: 'Deadline armed for the nightly gate',
      state: 'offered-to-endpoint', deliveryMode: 'next-turn-context', phase: 'condition',
      watchRuleId: 'watchrule_nightly', conditionGeneration: 31,
      evidenceRefs: ['watchdeadline_5'],
      recipient: { kind: 'human', principalId: 'person_chris' },
      subject: { kind: 'children-of', agentId: 'agent_kimi' },
      createdAt: '2026-08-03T09:50:00.000Z' },
    { id: 'notification_queued', summary: 'Disk usage crossed 80% on the build host',
      state: 'queued', deliveryMode: 'queue-only', phase: 'condition',
      watchRuleId: 'watchrule_disk', conditionGeneration: 1, evidenceRefs: [],
      recipient: { kind: 'human', principalId: 'person_chris' },
      subject: { kind: 'agent', agentId: 'agent_kimi' },
      createdAt: '2026-08-03T09:30:00.000Z' },
    { id: 'notification_settled', summary: 'Nightly gate passed',
      state: 'acknowledged', deliveryMode: 'queue-only', phase: 'condition',
      watchRuleId: 'watchrule_nightly', conditionGeneration: 30,
      evidenceRefs: ['watchdeadline_4'],
      recipient: { kind: 'human', principalId: 'person_chris' },
      subject: { kind: 'agent', agentId: 'agent_codex' },
      createdAt: '2026-08-03T08:00:00.000Z' },
  ];

  // S2b context bus: the mock holds focus like the bridge does (host authority).
  let focus: FocusSnapshot = { app: 'messaging', ref: 'none' };

  // demo presence: Kimi breathes online, Fable types occasionally
  setInterval(() => {
    const e: AgentEvent = { type: 'activity', agentId: 'agent_fable', sessionId: 'sess_mock', at: new Date().toISOString(), activity: 'thinking about the reply' };
    presenceHandlers.forEach((h) => h(e));
  }, 9000);

  return {
    async listConversations() { return convos; },
    async createConversation(title, kind, _clientOpId) {
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
    async pinConversation(id, pinned, _clientOpId) {
      convos = convos.map((c) => (c.id === id ? { ...c, pinned } : c));
      emit((l) => { const c = convos.find((x) => x.id === id); if (c) l.onConversation?.(c); });
    },
    async archiveConversation(id, archived, _clientOpId) {
      convos = convos.map((c) => (c.id === id ? { ...c, archived } : c));
      emit((l) => { const c = convos.find((x) => x.id === id); if (c) l.onConversation?.(c); });
    },
    async getMessages(conversationId) { return messages.get(conversationId) ?? []; },
    async listWatchers() { return { rules: [], deadlines: [], omissions: [] }; },
    publishFocus(f) { focus = f; },
    async sendMessage(conversationId, text, clientOpId) {
      // SHL-008: the send-time snapshot attaches to every human-composed message.
      const m: ChatMessage = composeHumanMessage({ conversationId, text, clientOpId }, focus);
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
    async setLayout(patch, _clientOpId) {
      layout = {
        record: { ...layout.record, ...patch } as LayoutRecord,
        version: layout.version + 1,
      };
      return { ok: true as const, value: layout };
    },
    // The tab store the demo runs on. It is an in-memory DRIVER behind the REAL
    // contract functions, not a second implementation of them — so the demo
    // rejects a wrong-prefix session id and keeps a closed tab's session for the
    // same reasons production does, instead of being politely wrong.
    terminalTabs: {
      async list() { return [...mockTabs.values()].map((held) => held.record); },
      async save(id, patch, clientOpId) {
        return setTerminalTab(mockTabDriver, id, patch, clientOpId);
      },
      async close(id, clientOpId) { return closeTerminalTab(mockTabDriver, id, clientOpId); },
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
    // S2a: in-memory agents seam (agent-def UI + model picker demo/tests)
    agents: (() => {
      let defs: import('../contract/services.js').AgentDefView[] = [
        { id: 'agent_kimi', displayName: 'Kimi', provider: 'kimi', model: 'kimi-k2', instructions: '', hooks: [], skills: [], status: 'defined', version: 1 },
        { id: 'agent_fable', displayName: 'Fable', provider: 'mock', model: 'mock-model', instructions: '', hooks: [], skills: [], status: 'defined', version: 1 },
      ];
      const skills: import('../contract/services.js').SkillView[] = [
        { id: 'skill_tdd', name: 'TDD', path: '.novakai/skills/tdd', description: 'test-driven development' },
      ];
      const toView = (d: import('../contract/services.js').AgentDefView) => ({ ...d });
      return {
        async listAgents() { return defs.map(toView); },
        async defineAgent(input, _clientOpId) {
          const d = {
            id: `agent_${Math.random().toString(36).slice(2, 10)}`,
            displayName: input.displayName, provider: input.provider, model: input.model,
            instructions: input.instructions ?? '', hooks: [], skills: input.skills ?? [],
            status: 'defined' as const, version: 1,
          };
          defs = [...defs, d];
          return { ok: true as const, value: toView(d) };
        },
        async updateAgent(id, patch, expectedVersion, _clientOpId) {
          const cur = defs.find((d) => d.id === id);
          if (!cur) return { ok: false as const, error: { code: 'NotFound', message: `no agent ${id}` } };
          if (cur.version !== expectedVersion) return { ok: false as const, error: { code: 'CasConflict', message: `expected v${expectedVersion}, actual v${cur.version}` } };
          const next = { ...cur, ...patch, version: cur.version + 1 };
          defs = defs.map((d) => (d.id === id ? next : d));
          return { ok: true as const, value: toView(next) };
        },
        async setModel(agentId, model, _clientOpId) {
          const cur = defs.find((d) => d.id === agentId);
          if (!cur) return { ok: false as const, error: { code: 'NotFound', message: `no agent ${agentId}` } };
          if (!model) return { ok: false as const, error: { code: 'InvalidEnvelope', message: 'model must be non-empty' } };
          const next = { ...cur, model, version: cur.version + 1 };
          defs = defs.map((d) => (d.id === agentId ? next : d));
          return { ok: true as const, value: toView(next) };
        },
        async listSkills() { return skills.map((s) => ({ ...s })); },
      };
    })(),
    /**
     * FZ-VIEW-001, whole (app/mockAgentRuns.ts). This host has no Runtime, so
     * every slice but supervision says so as a VALUE — the screens draw a stated
     * absence, which is the same thing they must do when a real host's Runtime
     * is down. It lives in its own file because the door is twenty-one members
     * and a door buried in a mock is a door whose missing slice is invisible
     * (finding L-20).
     */
    agentRuns: createOfflineAgentServices({
      list: () => notifications,
      settle: (notificationId, settled) => {
        notifications = notifications.map((item) =>
          (item.id === notificationId ? settled : item));
        emit((listener) => listener.onNotifications?.());
      },
    }),
    presence: {
      subscribeAgentEvents(handler) {
        presenceHandlers.add(handler);
        handler({ type: 'online', agentId: 'agent_kimi', sessionId: 'sess_mock', at: new Date().toISOString() });
        return () => presenceHandlers.delete(handler);
      },
    },
  };
}
