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
  AgentEvent, RunUsageTableView, ShellServices, SettingsRecord, WatcherListView,
} from '../contract/index.js';
import type { SetSettingError } from '../contract/index.js';
import { runUsageTableFrom } from '../contract/usage.js';
import { createShellAgentServices } from './agentRuns.js';

interface Pending { resolve(v: unknown): void; reject(e: Error): void }

interface B3WireResult<Value> {
  readonly ok: boolean;
  readonly value?: Value;
  readonly error?: { readonly code: string; readonly message: string };
}

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
      // D32: availability is MEASURED once at connect; the UI offers a "new
      // agent" entry only for providers the server says it can actually spawn.
      void call<{ providers?: Partial<Record<'kimi' | 'claude' | 'codex' | 'mock', boolean>> }>('getCapabilities')
        .then((caps) => {
          if (caps.providers) api.providerAvailability = caps.providers;
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
        if (frame.name === 'agent.provider-usage-evidence.committed'
          || frame.name === 'agent.run.usage.changed') {
          runUsageListeners.forEach((listener) => listener());
        }
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
    const runUsageListeners = new Set<() => void>();
    // A dead socket must fail loudly, not strand optimistic rows as pending
    // forever: reject in-flight calls when the connection drops, and refuse new
    // calls outright while it is down (the UI draws the typed failure inline).
    ws.onclose = () => {
      for (const p of pending.values()) p.reject(new Error('connection lost — the server closed or is unreachable'));
      pending.clear();
    };
    const call = <T>(method: string, params: unknown = {}): Promise<T> => {
      if (ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('connection lost — the server closed or is unreachable'));
      }
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params, v: PROTOCOL_VERSION }));
      return new Promise<T>((res, rej) => pending.set(id, { resolve: res as (v: unknown) => void, reject: rej }));
    };

    /**
     * The ONE door onto Agent Runs (FZ-VIEW-001). It hands the frozen
     * projection through untouched — see `app/agentRuns.ts` for why the browser
     * owns no projection of its own.
     */
    const agentRuns = createShellAgentServices({
      call: (method, payload) => call(method, { contractVersion: 1, payload }),
    });

    /**
     * The B1b usage table, now DERIVED from the frozen rows rather than read
     * over a second path. Until this seat the browser ran its own
     * `b3.agent.listRuns` read and renamed fields on the way in — a second
     * projection of one Run, which is the FZ-VIEW-034 failure shape. The flat
     * names that legacy screen's view type still wants are produced by a named
     * presentation adapter (`runUsageTableFrom`), so the reshaping is visible
     * at the edge that needs it instead of hiding inside the transport.
     */
    async function readRunUsageTable(): Promise<RunUsageTableView> {
      const page = await agentRuns.runs.listAgentRuns({ state: 'all' });
      if (!page.ok) throw new Error(page.error.message);
      return runUsageTableFrom(page.value, new Date().toISOString());
    }

    const api: ShellServices = {
      listConversations: () => call('listConversations'),
      createConversation: (title, kind, clientOpId) => call('createConversation', { title, kind, clientOpId }),
      pinConversation: (id, pinned, clientOpId) => call('pinConversation', { id, pinned, clientOpId }),
      archiveConversation: (id, archived, clientOpId) => call('archiveConversation', { id, archived, clientOpId }),
      markConversationRead: (conversationId, lastMessageId, clientOpId) =>
        call('markConversationRead', { conversationId, lastMessageId, clientOpId }),
      getMessages: (conversationId) => call('getMessages', { conversationId }),
      sendMessage: (conversationId, text, clientOpId) =>
        call('sendMessage', { conversationId, text, clientOpId }),
      publishFocus: (focus) => { void call('publishFocus', focus).catch(() => undefined); },
      // The one spawn path (§7/D30): existing agent OR new agent on a provider.
      spawnAgentConversation: (input, clientOpId) =>
        call('spawnAgentConversation', { ...input, clientOpId }),
      subscribe(events) {
        const ml = (m: unknown) => events.onMessage?.(m as never);
        const cl = (c: unknown) => events.onConversation?.(c as never);
        const ul = (t: unknown) => events.onUsage?.(t as never);
        const runUsageListener = () => events.onRunUsageChanged?.();
        msgListeners.add(ml); convListeners.add(cl); usageListeners.add(ul);
        runUsageListeners.add(runUsageListener);
        return () => {
          msgListeners.delete(ml); convListeners.delete(cl); usageListeners.delete(ul);
          runUsageListeners.delete(runUsageListener);
        };
      },
      getUsageTable: () => call('getUsageTable'),
      listWatchers: async () => watcherListingFromWire(await call<WatcherWireResult>(
        'b3.supervision.listWatchers',
        { contractVersion: 1, payload: { limit: 500 } },
      )),
      getRunUsageTable: readRunUsageTable,
      agentRuns,
      getLayout: () => call('getLayout'),
      // M5/DEC-S2-12: clientOpId minted HERE (the interaction layer) and sent
      // with the mutation; the server threads it to foundation meta.
      setLayout: (patch, clientOpId) => call('setLayout', { patch, clientOpId }),
      // FZ-VIEW-017: the tab record travels as plain data, like layout does.
      // clientOpId is minted at the interaction layer and threaded through, so a
      // retried click never opens two tabs (LAW 1).
      terminalTabs: {
        list: () => call('listTerminalTabs'),
        save: (tabId, patch, clientOpId) => call('setTerminalTab', { id: tabId, patch, clientOpId }),
        close: (tabId, clientOpId) => call('closeTerminalTab', { id: tabId, clientOpId }),
      },
      getSettings: () => call('getSettings'),
      setSetting: async (key, value, opts) =>
        call<{ ok: true; value: SettingsRecord } | { ok: false; error: SetSettingError }>('setSetting', { key, value, opts }),
      // The Library's Kill verb: the server's existing session registry doors.
      sessions: {
        list: () => call('listSessions'),
        terminate: (sessionId) => call('terminateSession', { sessionId }),
      },
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
