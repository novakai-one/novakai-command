// shell/app/serverClient.ts — browser-side ShellServices over nvk-ws v1.
//
// B1a: the page is served BY the Novakai server, so the connection facts come
// from the same origin: GET /bootstrap.json → {wsUrl, token, protocolVersion}.
// Every frame carries v:1; the socket is opened with the connection token
// (without it the upgrade is refused before any method can dispatch).
//
// The demo's two spawn affordances collapse into the server's single
// spawnAgentConversation (§7): the real-provider entry point is always wired,
// and the mock entry point appears only when the server says dev.allowMock.
import type {
  AgentEvent, ShellServices, SettingsRecord, WatcherListView,
} from '../contract/index.js';
import type { SetSettingError } from '../contract/index.js';

interface Pending { resolve(v: unknown): void; reject(e: Error): void }

const PROTOCOL_VERSION = 1;

export interface BootstrapDocument {
  wsUrl: string;
  token: string;
  protocolVersion: number;
}

interface WatcherWireResult {
  readonly ok: boolean;
  readonly value?: Omit<WatcherListView, 'deadlines'> & {
    readonly deadlines: readonly (Omit<WatcherListView['deadlines'][number], 'driftPhase'> & {
      readonly driftState?: { readonly phase?: string };
    })[];
  };
  readonly error?: { readonly code: string; readonly message: string };
}

/** Keep Supervision's record vocabulary out of the component tree. */
export function watcherListingFromWire(result: WatcherWireResult): WatcherListView {
  if (!result.ok || result.value === undefined) {
    throw new Error(`${result.error?.code ?? 'RuntimeUnavailable'}: `
      + `${result.error?.message ?? 'watcher listing returned no value'}`);
  }
  return {
    rules: result.value.rules,
    deadlines: result.value.deadlines.map((deadline) => ({
      id: deadline.id,
      watchRuleId: deadline.watchRuleId,
      state: deadline.state,
      dueAt: deadline.dueAt,
      activityGeneration: deadline.activityGeneration,
      ...(deadline.driftState?.phase === undefined
        ? {}
        : { driftPhase: deadline.driftState.phase }),
    })),
    omissions: result.value.omissions,
  };
}

/** Same-origin bootstrap. The token is never hardcoded anywhere in the app. */
export async function fetchBootstrap(origin = ''): Promise<BootstrapDocument> {
  const res = await fetch(`${origin}/bootstrap.json`, { cache: 'no-store' } as RequestInit);
  if (!res.ok) throw new Error(`bootstrap failed: HTTP ${res.status}`);
  const doc = await res.json() as BootstrapDocument;
  if (doc.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`server speaks nvk-ws v${doc.protocolVersion}, this shell speaks v${PROTOCOL_VERSION}`);
  }
  return doc;
}

export function createServerServices(
  bootstrap: BootstrapDocument,
  onPresence: (e: AgentEvent) => void,
): Promise<ShellServices> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${bootstrap.wsUrl}?token=${encodeURIComponent(bootstrap.token)}`);
    let seq = 0;
    const pending = new Map<number, Pending>();
    const msgListeners = new Set<(m: unknown) => void>();

    const timeout = setTimeout(() => { ws.close(); reject(new Error('server timeout')); }, 3000);

    ws.onopen = () => {
      clearTimeout(timeout);
      void call<{ providers?: { mock?: boolean } }>('getCapabilities').then((caps) => {
        // Mock spawning is a DEV affordance now, gated by server config (M10).
        if (caps.providers?.mock) {
          api.spawnMockAgent = (title) => call('spawnAgentConversation', { title, provider: 'mock' });
        }
      }).catch(() => undefined).finally(() => resolve(api));
    };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error('server unreachable')); };
    ws.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data));
      if (frame.type === 'event') {
        if (frame.name === 'presence') onPresence(frame.data as AgentEvent);
        if (frame.name === 'message') msgListeners.forEach((l) => l(frame.data));
        if (frame.name === 'conversation') convListeners.forEach((l) => l(frame.data));
        // B1b §8: the supervision usage table, every usageIntervalSec.
        if (frame.name === 'usage') usageListeners.forEach((l) => l(frame.data));
        return;
      }
      const p = pending.get(frame.id);
      if (!p) return;
      pending.delete(frame.id);
      if (frame.error) p.reject(new Error(frame.error));
      else p.resolve(frame.result);
    };

    const convListeners = new Set<(c: unknown) => void>();
    const usageListeners = new Set<(t: unknown) => void>();
    const call = <T>(method: string, params: unknown = {}): Promise<T> => {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params, v: PROTOCOL_VERSION }));
      return new Promise<T>((res, rej) => pending.set(id, { resolve: res as (v: unknown) => void, reject: rej }));
    };

    const api: ShellServices = {
      listConversations: () => call('listConversations'),
      createConversation: (title, kind, clientOpId) => call('createConversation', { title, kind, clientOpId }),
      pinConversation: (id, pinned, clientOpId) => call('pinConversation', { id, pinned, clientOpId }),
      archiveConversation: (id, archived, clientOpId) => call('archiveConversation', { id, archived, clientOpId }),
      getMessages: (conversationId) => call('getMessages', { conversationId }),
      sendMessage: (conversationId, text, clientOpId) =>
        call('sendMessage', { conversationId, text, clientOpId }),
      publishFocus: (focus) => { void call('publishFocus', focus).catch(() => undefined); },
      // The one spawn path (§7): a real provider session on the configured CLI.
      spawnRealKimiAgent: (title) => call('spawnAgentConversation', { title, provider: 'kimi' }),
      subscribe(events) {
        const ml = (m: unknown) => events.onMessage?.(m as never);
        const cl = (c: unknown) => events.onConversation?.(c as never);
        const ul = (t: unknown) => events.onUsage?.(t as never);
        msgListeners.add(ml); convListeners.add(cl); usageListeners.add(ul);
        return () => {
          msgListeners.delete(ml); convListeners.delete(cl); usageListeners.delete(ul);
        };
      },
      getUsageTable: () => call('getUsageTable'),
      listWatchers: async () => watcherListingFromWire(await call<WatcherWireResult>(
        'b3.supervision.listWatchers',
        { contractVersion: 1, payload: { limit: 500 } },
      )),
      getLayout: () => call('getLayout'),
      // M5/DEC-S2-12: clientOpId minted HERE (the interaction layer) and sent
      // with the mutation; the server threads it to foundation meta.
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
