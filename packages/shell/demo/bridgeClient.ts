// shell/demo/bridgeClient.ts — browser-side ShellServices over the WS bridge
// (real packages/messaging + foundation on the node side). Falls back handled
// by the demo entry: if the socket never opens, the caller swaps in the mock.
import type { ShellServices, SettingsRecord, AgentEvent } from '../contract/index.js';
import type { SetSettingError } from '../contract/index.js';

interface Pending { resolve(v: unknown): void; reject(e: Error): void }

export function createBridgeServices(url: string, onPresence: (e: AgentEvent) => void): Promise<ShellServices> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let seq = 0;
    const pending = new Map<number, Pending>();
    const msgListeners = new Set<(m: unknown) => void>();

    const timeout = setTimeout(() => { ws.close(); reject(new Error('bridge timeout')); }, 3000);

    ws.onopen = () => {
      clearTimeout(timeout);
      // Show the real-Kimi affordance only when the bridge has the CLI.
      void call<{ realKimi: boolean }>('getCapabilities').then((caps) => {
        if (caps.realKimi) api.spawnRealKimiAgent = (title) => call('spawnRealKimi', { title });
      }).catch(() => undefined).finally(() => resolve(api));
    };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error('bridge unreachable')); };
    ws.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data));
      if (frame.type === 'event') {
        if (frame.name === 'presence') onPresence(frame.data as AgentEvent);
        if (frame.name === 'message') msgListeners.forEach((l) => l(frame.data));
        if (frame.name === 'conversation') convListeners.forEach((l) => l(frame.data));
        return;
      }
      const p = pending.get(frame.id);
      if (!p) return;
      pending.delete(frame.id);
      if (frame.error) p.reject(new Error(frame.error));
      else p.resolve(frame.result);
    };

    const convListeners = new Set<(c: unknown) => void>();
    const call = <T>(method: string, params: unknown = {}): Promise<T> => {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise<T>((res, rej) => pending.set(id, { resolve: res as (v: unknown) => void, reject: rej }));
    };

    const api: ShellServices = {
      listConversations: () => call('listConversations'),
      createConversation: (title, kind, clientOpId) => call('createConversation', { title, kind, clientOpId }),
      pinConversation: (id, pinned, clientOpId) => call('pinConversation', { id, pinned, clientOpId }),
      archiveConversation: (id, archived, clientOpId) => call('archiveConversation', { id, archived, clientOpId }),
      getMessages: (conversationId) => call('getMessages', { conversationId }),
      sendMessage: (conversationId, text) => call('sendMessage', { conversationId, text }),
      publishFocus: (focus) => { void call('publishFocus', focus).catch(() => undefined); },
      spawnMockAgent: (title) => call('spawnMockAgent', { title }),
      subscribe(events) {
        const ml = (m: unknown) => events.onMessage?.(m as never);
        const cl = (c: unknown) => events.onConversation?.(c as never);
        msgListeners.add(ml); convListeners.add(cl);
        return () => { msgListeners.delete(ml); convListeners.delete(cl); };
      },
      getLayout: () => call('getLayout'),
      // M5/DEC-S2-12: clientOpId minted HERE (the interaction layer) and sent
      // with the mutation; the bridge threads it to foundation meta.
      setLayout: (patch, clientOpId) => call('setLayout', { patch, clientOpId }),
      getSettings: () => call('getSettings'),
      setSetting: async (key, value, opts) =>
        call<{ ok: true; value: SettingsRecord } | { ok: false; error: SetSettingError }>('setSetting', { key, value, opts }),
      agents: {
        listAgents: () => call('listAgents'),
        defineAgent: (input, clientOpId) => call('defineAgent', { input, clientOpId }),
        updateAgent: (id, patch, expectedVersion, clientOpId) =>
          call('updateAgent', { id, patch, expectedVersion, clientOpId }),
        setModel: (agentId, model, clientOpId) => call('setAgentModel', { agentId, model, clientOpId }),
        listSkills: () => call('listSkills'),
      },
      presence: {
        subscribeAgentEvents(handler) {
          const h = (e: AgentEvent) => handler(e);
          presenceHandlers.add(h);
          return () => presenceHandlers.delete(h);
        },
      },
    };
    const presenceHandlers = new Set<(e: AgentEvent) => void>();
    const origOnPresence = onPresence;
    onPresence = (e) => { origOnPresence(e); presenceHandlers.forEach((h) => h(e)); };
  });
}
