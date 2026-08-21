// shell/contract/services.ts — the UI's data seam. Screens render ONLY
// contract data through this interface (B §12); implementations: the node
// bridge (real packages/messaging + foundation) or an in-memory mock (tests).
import type { AgentEvent, LayoutRecord, PresenceSource, SettingsRecord } from './types.js';
import type { SetSettingError } from './settings.js';
import type { PersistFailedError } from './errors.js';
import type { FocusSnapshot } from './context.js';
import type { RunUsageTableView, UsageTableView } from './usage.js';
import type { WatcherListView } from './watchers.js';
import type { ShellAgentServices } from './agentRuns.js';
import type { TerminalTabPatch, TerminalTabRecord } from './terminalTab.js';

/**
 * S2a: shell-side view of an agent definition v2 (plain data — the browser
 * never imports packages/agents; the bridge maps contract objects to these).
 */
export interface AgentDefView {
  id: string;
  displayName: string;
  provider: 'kimi' | 'claude' | 'codex' | 'mock';
  model: string;
  instructions: string;
  hooks: Array<{ id: string; event: string; action: { kind: string; text?: string; message?: string } }>;
  skills: string[]; // skill id refs
  status: 'defined' | 'archived';
  version: number; // CAS version for updateAgent
}

/** One registered skill, as the agents registry lists it. */
export interface SkillView {
  id: string;
  name: string;
  path: string;
  description: string;
}

/** Typed failure surface for agent-registry operations. */
export type AgentOpError = { code: string; message: string };

/** The agents-registry seam (S2a): definitions, models, skills. */
export interface ShellAgentsServices {
  listAgents(): Promise<AgentDefView[]>;
  defineAgent(input: {
    displayName: string; provider: AgentDefView['provider']; model: string;
    instructions?: string; skills?: string[];
  }, clientOpId: string): Promise<{ ok: true; value: AgentDefView } | { ok: false; error: AgentOpError }>;
  updateAgent(id: string, patch: Partial<Pick<AgentDefView, 'displayName' | 'provider' | 'instructions' | 'skills'>>,
    expectedVersion: number, clientOpId: string):
    Promise<{ ok: true; value: AgentDefView } | { ok: false; error: AgentOpError }>;
  /** AGT-003/DEC-S2-5: def-level model writes go through agents.setModel ONLY. */
  setModel(agentId: string, model: string, clientOpId: string):
    Promise<{ ok: true; value: AgentDefView } | { ok: false; error: AgentOpError }>;
  listSkills(): Promise<SkillView[]>;
}

/** Mint a clientOpId at the interaction layer (M5/DEC-S2-12). Browser + node safe. */
export const mintShellOpId = (): string => `op_${globalThis.crypto.randomUUID()}`;

/** The slice of a provider-session registry record the shell reads. */
export interface SessionView {
  sessionId: string;
  agentId: string;
  provider: string;
  status: string;
}

/** One conversation as the wire lists it — the Bench/Library row source. */
export interface ConversationSummary {
  id: string;             // ConversationId — shell-side conversation identity
  threadId: string;       // messaging ThreadId backing it
  title: string;
  kind: 'agent' | 'room' | 'direct';
  pinned: boolean;
  archived: boolean;
  lastActivityAt: string;
  /** S3 (M3-01): the read cursor. Unread is DERIVED (cursor + loaded
   * messages) — a stored count was the fabrication M1-04 forbids. */
  lastReadMessageId?: string;
  agentId?: string;       // when kind === 'agent' — drives the presence dot
}

/** One rendered chat message, including optimistic/failed local rows. */
export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  createdAt: string;
  pending?: boolean;
  failed?: string;        // typed inline error message (never blank — red gate 5)
  /** Stable idempotency key; resend reuses it instead of minting a new post. */
  clientOpId?: string;
  /** S2b (SHL-008): send-time screen context snapshot — present on every
   * human-composed message (red gate 2; {app, ref:'none'} counts). */
  context?: FocusSnapshot;
}

/** Live messaging event hooks a host may subscribe to. */
export interface MessagingEvents {
  onMessage?(m: ChatMessage): void;
  onConversation?(c: ConversationSummary): void;
  /**
   * B1b §8: the supervision usage table, broadcast by the server every
   * supervision.usageIntervalSec (DEC-B1-11). Hosts without supervision simply
   * never call it.
   */
  onUsage?(table: UsageTableView): void;
  /**
   * Lane C: something moved in the notification inbox.
   *
   * Deliberately CARRIES NOTHING. It used to push a Shell-shaped inbox, which
   * made the pushed value a second projection of a Notification arriving by a
   * second path — the FZ-VIEW-034 drift shape. It is a nudge now: the screen
   * re-reads through the frozen `supervision` door, so there is exactly one
   * shape of a Notification in the browser and exactly one place it comes from.
   */
  onNotifications?(): void;
  /** A committed Agents evidence event says the rebuildable Run rows may have moved. */
  onRunUsageChanged?(): void;
}

/**
 * The browser's reach into the `terminalTab` kind. Plain data both ways: the
 * page never sees a driver, and `clientOpId` is minted at the interaction layer
 * exactly as it is for every other UI-originated mutation (DEC-S2-12).
 */
export interface ShellTerminalTabServices {
  list(): Promise<TerminalTabRecord[]>;
  save(id: string, patch: TerminalTabPatch, clientOpId: string):
    Promise<{ ok: true; value: { record: TerminalTabRecord; version: number } } | { ok: false; error: PersistFailedError }>;
  /** Detaches this window from the tab. It does not stop the session. */
  close(id: string, clientOpId: string):
    Promise<{ ok: true; value: { record: TerminalTabRecord; version: number } } | { ok: false; error: PersistFailedError }>;
}

/** THE host seam: everything a shell screen may ask of its host. */
export interface ShellServices {
  // conversations (messaging owns CRUD — §11 ruling 9; shell calls its contract)
  listConversations(): Promise<ConversationSummary[]>;
  // F1/DEC-S2-12: creation is a UI-originated mutation — clientOpId REQUIRED.
  createConversation(title: string, kind: ConversationSummary['kind'], clientOpId: string): Promise<ConversationSummary>;
  // F1/DEC-S2-11: pin/archive persist as shell-owned conversationView records;
  // clientOpId REQUIRED (R3-10 — minted at the interaction layer).
  pinConversation(id: string, pinned: boolean, clientOpId: string): Promise<void>;
  archiveConversation(id: string, archived: boolean, clientOpId: string): Promise<void>;
  /** S3 (M3-01): advance the read cursor — the transcript was actually seen to
   * this message. Optional: hosts without read-state simply never badge. */
  markConversationRead?(conversationId: string, lastMessageId: string, clientOpId: string):
    Promise<{ ok: boolean; error?: unknown }>;

  // messages
  getMessages(conversationId: string): Promise<ChatMessage[]>;
  sendMessage(conversationId: string, text: string, clientOpId: string): Promise<
    { ok: true; message: ChatMessage }
    | { ok: false; error: string | { code: string; message?: string; [key: string]: unknown } }
  >;
  subscribe(events: MessagingEvents): () => void;

  // layout + settings (shell-owned kinds)
  // M4: write/materialise failures are typed PersistFailed Results, never rejections.
  // M5/DEC-S2-12: clientOpId REQUIRED on every UI-originated mutation.
  getLayout(): Promise<{ ok: true; value: { record: LayoutRecord; version: number } } | { ok: false; error: PersistFailedError }>;
  setLayout(patch: Partial<LayoutRecord>, clientOpId: string): Promise<{ ok: true; value: { record: LayoutRecord; version: number } } | { ok: false; error: PersistFailedError }>;
  getSettings(): Promise<SettingsRecord[]>;
  setSetting(key: string, value: unknown, opts: { derivedFrom?: string; theme?: 'dark' | 'light'; clientOpId: string }):
    Promise<{ ok: true; value: SettingsRecord } | { ok: false; error: SetSettingError }>;

  /**
   * Terminal TABS — the Shell's own durable record of which windows are open
   * (FZ-VIEW-017), reached the same way layout and settings are.
   *
   * Deliberately NOT on `TerminalServices`: that seam is the Runtime's terminal
   * facade and owns sessions, which outlive every tab. This one is a Shell fact
   * and goes through the Shell's scoped Foundation handle. Keeping them apart is
   * what makes "closing a tab does not stop a session" structural rather than a
   * rule someone has to remember (red gate 1).
   */
  terminalTabs: ShellTerminalTabServices;

  // agents (S2a: agent-def UI + model picker; shell keeps NO model truth —
  // every write goes through the agents contract via this seam)
  agents?: ShellAgentsServices;

  // presence (agents-lite seam; the demo bridge wires the REAL packages/agents
  // agentEvent stream; tests/mock inject an in-memory source)
  presence: PresenceSource;

  // S2b context bus (SHL-008): the UI publishes every focus change; the shell
  // host (demo bridge / future Electron) is the focus authority and attaches
  // the send-time snapshot to each human-composed message. Fire-and-forget.
  publishFocus?(focus: FocusSnapshot): void;

  /**
   * S2 (D30/D31): the ONE way a UI starts an agent conversation. Exactly one
   * of `agentId` (existing agent) or `provider` (define + spawn a new one).
   * `conversationId` is client-minted (`conv_<uuid>`) so spatial layout is
   * keyed by the real id from the first frame. Replaces the retired
   * spawnMockAgent/spawnRealKimiAgent demo affordances.
   */
  spawnAgentConversation?(input: {
    agentId?: string; provider?: AgentDefView['provider'];
    title?: string; conversationId?: string;
  }, clientOpId: string): Promise<
    { ok: true; conversation: ConversationSummary }
    | { ok: false; error: string | { code: string; message?: string } }
  >;

  /**
   * Which providers this host can actually spawn on (measured by the server's
   * getCapabilities at connect). Absent on hosts with no spawn capability —
   * the UI then offers existing agents only, never a dead "new agent" entry.
   */
  providerAvailability?: Readonly<Partial<Record<AgentDefView['provider'], boolean>>>;

  /**
   * B1b §8 supervision surface (DEC-B1-11): the current usage table, pulled
   * once so the screen is never blank while it waits for the next broadcast.
   * Absent on hosts with no supervision engine — the screen draws that.
   */
  getUsageTable?(): Promise<UsageTableView>;

  /** Current watcher rules joined to their generation-fenced deadlines. */
  listWatchers?(): Promise<WatcherListView>;
  /**
   * `getNotificationInbox` and `acknowledgeNotification` used to live here.
   *
   * They were Shell-invented methods that no host outside `app/mockServices.ts`
   * implemented, so against a fully backed server the attention screen drew
   * "Supervision is not available in this host" forever while the published
   * `b3.supervision.listNotifications` and `b3.supervision.acknowledge` sat
   * unread (L-14). Retired in B2.5 — the surface reads through
   * `agentRuns.supervision` like every other frozen view.
   */
  /** B3d Run usage read from Runtime views; older hosts omit or refuse it. */
  getRunUsageTable?(): Promise<RunUsageTableView>;

  /**
   * Provider-session lifecycle (DEC-B1-6 made visible in the UI): list the
   * registry's sessions and stop one. Backed by the server's existing
   * listSessions/terminateSession methods; absent on hosts with no runtime —
   * the Kill affordance then explains itself instead of pretending.
   */
  sessions?: {
    list(): Promise<SessionView[]>;
    terminate(sessionId: string): Promise<{ ok: boolean; error?: unknown }>;
  };
  /**
   * B3e: the frozen read door onto Agent Runs (FZ-VIEW-001). Screens that show
   * a Run read it HERE and render the projection as it arrives — the same
   * bytes `nvk agent list --json` prints. Absent on hosts with no Runtime,
   * which the screen draws rather than guesses at.
   */
  agentRuns?: ShellAgentServices;
}
